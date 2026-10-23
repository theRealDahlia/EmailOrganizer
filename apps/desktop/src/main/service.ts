import {
  StorageScopeError, applyActionsToMessage, buildOverview, buildQuery, buildSenders, findDuplicates, isBroadTrash, mailMove, reverseCleanupActions, validateCleanup, buildSubscriptions, categorize, inverseActions, parseListUnsubscribe, planChanges, validateRule,
  type CleanupFilters, type CleanupRule, type InboxCounts, type MailAction, type MailMessage, type MailProvider, type Rule, type Subscription, type UnsubscribeTargets,
} from '@organizer/core'
import { AUTO_TRASH_LIMIT } from '../shared'
import type { ActivityEntry, CleanupPreview, OverviewResult, PreviewResult, AutomationStatus, ScanProgress, SenderAction, SenderSummary, SendersResult, StorageResult } from '../shared'
import type { Store, UndoStep } from './db'
import { randomUUID } from 'node:crypto'
import type { DuplicatesResult, ImportResult, RulesExport, ImpactSummary, ImpactTotals, SpaceCandidate, SpaceGuide, Suggestion, SuggestionsResult, UnsubscribeRecord } from '../shared'

/** New messages are downloaded and saved in chunks of this size, so progress survives a stop or crash. */
const FETCH_CHUNK = 50
/** A scan that finishes within this long (small inboxes, cached mail) is awaited instead of reported as in progress. */
const SETTLE_MS = 400
const RATE_WINDOW_MS = 90_000
/** Gmail history is only reliable for about a week, so recount the whole inbox at least this often. */
const FULL_RELIST_AFTER_MS = 6 * 24 * 3_600_000
/**
 * Unless the user asks for a full scan, only the newest this-many inbox messages are downloaded: about 7
 * minutes at Gmail's pace, and enough to show who sends the most and what can be unsubscribed from.
 * Inbox totals and per-tab counts come straight from Gmail and never need a scan.
 */
export const SAMPLE_SIZE = 2_000
/** How often automatic rules and cleanups run while the app is open. */
export const AUTO_INTERVAL_MS = 30 * 60_000
/** The most rules of each kind one import will read. */
const IMPORT_LIMIT = 200
/** A sender needs at least this much mail before it's worth a suggestion. */
const SUGGESTION_MIN_MAIL = 8
/** Things the "Free up space" guide looks for. All inbox mail, and all moved to Trash (archiving frees nothing). */
const SPACE_CANDIDATES: { id: string; title: string; blurb: string; filters: CleanupFilters }[] = [
  { id: 'attachments-25', title: 'Attachments over 25 MB', blurb: 'The biggest single messages in your inbox.', filters: { largerThanMB: 25, keepStarred: true } },
  { id: 'attachments-10', title: 'Attachments of 10 to 25 MB', blurb: 'Large files that were probably saved elsewhere already.', filters: { largerThanMB: 10, extra: '-larger:25M', keepStarred: true } },
  { id: 'attachments-5', title: 'Attachments of 5 to 10 MB', blurb: 'Photos, PDFs and presentations adding up.', filters: { largerThanMB: 5, extra: '-larger:10M', keepStarred: true } },
  { id: 'promotions-old', title: 'Promotions older than a year', blurb: 'Sales and offers that have long expired.', filters: { category: 'promotions', olderThan: { value: 1, unit: 'y' }, keepStarred: true } },
  { id: 'social-old', title: 'Social notifications older than 3 months', blurb: 'Likes, follows and tags nobody needs again.', filters: { category: 'social', olderThan: { value: 3, unit: 'm' }, keepStarred: true } },
  { id: 'updates-old', title: 'Updates older than 2 years', blurb: 'Old confirmations and notices.', filters: { category: 'updates', olderThan: { value: 2, unit: 'y' }, keepStarred: true } },
]
/** How many matches of each candidate are downloaded to work out their size (20 quota units each). */
const SPACE_SAMPLE = 8
/** How long to wait after an unsubscribe before checking whether the sender stopped (senders have a few days to act). */
export const UNSUBSCRIBE_GRACE_MS = 7 * 86_400_000
/** A plain sentence about what a run did, like "Archived 212 messages and moved 30 to Trash"; empty when it did nothing. */
export function describeRun(entries: ActivityEntry[]): string {
  const total = (move: ActivityEntry['move'] | 'other') => entries.filter((e) => (move === 'other' ? !e.move : e.move === move)).reduce((n, e) => n + e.messageCount, 0)
  const archived = total('archive'), trashed = total('trash'), other = total('other')
  const bits = [
    archived && `archived ${archived.toLocaleString()} ${archived === 1 ? 'message' : 'messages'}`,
    trashed && `moved ${trashed.toLocaleString()} to Trash`,
    other && `updated ${other.toLocaleString()} ${other === 1 ? 'message' : 'messages'}`,
  ].filter(Boolean) as string[]
  if (bits.length === 0) return ''
  const sentence = bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}`
  return sentence[0].toUpperCase() + sentence.slice(1)
}

/** Rules made on the fly (one sender, one space candidate) are never saved, so they have no id worth keeping. */
const savedRuleId = (id: string) => (/^(sender|space)-/.test(id) ? undefined : id)


interface ScanData {
  provider: MailProvider
  messages: MailMessage[]
  inboxTotal: number
  complete: boolean
}

/** What a running scan has covered so far; `messages` grows as downloads arrive. */
interface Snapshot {
  messages: MailMessage[]
  inboxTotal: number
}

interface ScanEntry {
  provider: MailProvider
  abort: AbortController
  promise: Promise<void>
  snapshot: Snapshot
  last: ScanProgress | null
  /** cached mail has been loaded into the snapshot, so it is worth showing */
  seeded: boolean
}

const DEFAULT_RULES: Rule[] = [
  {
    id: 'default-promos', name: 'Archive old promotions', enabled: true, match: 'all',
    conditions: [{ field: 'category', op: 'equals', value: 'promotion' }, { field: 'olderThanDays', op: 'gte', value: 14 }],
    actions: [{ type: 'addLabel', label: 'Promotions' }, { type: 'archive' }],
  },
  {
    id: 'default-receipts', name: 'Label receipts', enabled: true, match: 'all',
    conditions: [{ field: 'category', op: 'equals', value: 'receipt' }],
    actions: [{ type: 'addLabel', label: 'Receipts' }],
  },
]

/** App logic, kept independent of Electron so it can be tested and reused. */
export class OrganizerService {
  private cache: ScanData | null = null
  private scanning: ScanEntry | null = null
  private failure: unknown = null
  /** Mail changed (by a cleanup or an undo) while a scan was running, so that scan's picture is already out of date. */
  private dirty = false
  /** The last finished view, shown while a rescan is still counting the inbox so the screen never goes blank. */
  private stale: ScanData | null = null
  /** The user asked to download every inbox message, not just the newest `sampleSize`. */
  private full = false
  /** Inbox-wide counts from the mail service, kept until mail changes. */
  private counted = new Map<string, { provider: MailProvider; promise: Promise<unknown> }>()
  private sampleSize: number
  private onAutomatic: (status: AutomationStatus) => void
  private automating: Promise<AutomationStatus> | null = null
  private auto: AutomationStatus = { lastRunAt: null, needsReview: [], errors: [], runs: 0, lastChanged: 0, lastSummary: '' }

  constructor(
    private getProvider: () => MailProvider,
    private store: Store,
    private onProgress: (p: ScanProgress) => void = () => {},
    options: { sampleSize?: number; onAutomatic?: (status: AutomationStatus) => void } = {},
  ) {
    this.sampleSize = options.sampleSize ?? SAMPLE_SIZE
    this.onAutomatic = options.onAutomatic ?? (() => {})
    if (store.listRules().length === 0) DEFAULT_RULES.forEach((r) => store.saveRule(r))
  }

  /**
   * Forget the in-memory scan. Cheap: the next scan only downloads what is new. The previous view stays
   * available until the new scan can show something, unless `reset` (the account changed).
   */
  invalidate(reset = false): void {
    this.scanning?.abort.abort()
    this.scanning = null
    this.stale = reset ? null : (this.cache ?? this.stale)
    this.cache = null
    this.failure = null
    this.counted.clear()
    if (reset) this.full = false
  }

  /** Stop the running scan. Whatever has been scanned is kept, and the next scan resumes from there. */
  cancelScan(): void {
    if (!this.scanning) return
    this.full = false // back to the sample; asking for the full scan again resumes from what was saved
    this.scanning.abort.abort()
    if (this.scanning.last) this.onProgress({ ...this.scanning.last, stopping: true }) // so the UI can say "Stopping…"
  }

  /** Download the rest of the inbox too. The next `overview()` starts the scan; what is cached is kept. */
  scanFullInbox(): void {
    this.full = true
    this.invalidate()
  }

  /** Exact inbox totals, without a scan; null if the mail service can't count them. */
  inboxCounts(): Promise<InboxCounts | null> {
    return this.countOnce('inbox', (p) => p.inboxCounts?.())
  }

  /** Exact inbox mail per Gmail tab, without a scan; null if the mail service has no tabs. */
  tabCounts(): Promise<Record<string, number> | null> {
    return this.countOnce('tabs', (p) => p.tabCounts?.())
  }

  private countOnce<T>(key: string, load: (p: MailProvider) => Promise<T> | undefined): Promise<T | null> {
    const provider = this.getProvider()
    const hit = this.counted.get(key)
    if (hit?.provider === provider) return hit.promise as Promise<T | null>
    const promise: Promise<T | null> = (load(provider) ?? Promise.resolve(null)).catch((e) => {
      if (this.counted.get(key)?.promise === promise) this.counted.delete(key) // let the next call try again
      throw e
    })
    this.counted.set(key, { provider, promise })
    return promise
  }

  /**
   * The best available view of the inbox right now: the finished scan, or a snapshot of a scan in progress.
   * Never waits for a long scan, so the app stays usable (and shows data) while a big inbox downloads.
   */
  private async current(): Promise<{ messages: MailMessage[]; inboxTotal: number; complete: boolean; scanning: boolean }> {
    const provider = this.getProvider()
    this.throwFailure()
    if (this.cache?.provider !== provider) {
      const entry = this.scanning?.provider === provider ? this.scanning : this.startScan(provider)
      await Promise.race([entry.promise, new Promise((r) => setTimeout(r, SETTLE_MS))])
      this.throwFailure()
      if (this.cache?.provider !== provider) {
        if (!entry.seeded && this.stale?.provider === provider) {
          const { messages, inboxTotal, complete } = this.stale
          return { messages, inboxTotal, complete, scanning: true }
        }
        return { messages: entry.snapshot.messages, inboxTotal: entry.snapshot.inboxTotal, complete: false, scanning: true }
      }
    }
    const { messages, inboxTotal, complete } = this.cache!
    return { messages, inboxTotal, complete, scanning: false }
  }

  private throwFailure(): void {
    if (this.failure) {
      const e = this.failure
      this.failure = null
      throw e
    }
  }

  private async messages(): Promise<MailMessage[]> {
    return (await this.current()).messages
  }

  private startScan(provider: MailProvider): ScanEntry {
    const entry: ScanEntry = {
      provider, abort: new AbortController(), snapshot: { messages: [], inboxTotal: 0 }, last: null,
      promise: Promise.resolve(), seeded: false,
    }
    entry.promise = this.runScan(entry).then(
      (data) => {
        if (this.scanning !== entry) return // invalidated mid-scan
        this.scanning = null
        if (this.dirty) {
          // mail changed during the scan: show this view meanwhile, and let the next (cheap, history-based) scan catch up
          this.dirty = false
          this.stale = data
          this.cache = null
        } else {
          this.cache = data
        }
      },
      (e) => {
        if (this.scanning === entry) { this.scanning = null; this.failure = e }
      },
    )
    this.scanning = entry
    return entry
  }

  /**
   * Incremental inbox scan. Listing ids is cheap, so each scan lists every inbox id and the unread ids,
   * drops cached messages that left the inbox, and downloads metadata only for messages not yet cached:
   * among the newest `sampleSize`, or all of them when the user asked for a full scan.
   * Everything known is published to `entry.snapshot` as it goes, so callers can show partial results.
   */
  private async runScan(entry: ScanEntry): Promise<ScanData> {
    const { provider, snapshot } = entry
    const signal = entry.abort.signal
    const accountId = provider.accountId
    const persist = accountId !== 'demo' // the demo mailbox lives in memory
    const full = this.full

    const startedAt = Date.now()
    const samples: { at: number; done: number }[] = []
    const perMinute = (): number | undefined => {
      const first = samples[0]
      const lastSample = samples.at(-1)
      if (first && lastSample && lastSample.at - first.at >= 6000 && lastSample.done - first.done >= 5) {
        return ((lastSample.done - first.done) / (lastSample.at - first.at)) * 60_000
      }
      return provider.fetchesPerMinute // not enough data yet: use the provider's nominal pace
    }
    const report = (p: Omit<ScanProgress, 'startedAt' | 'perMinute' | 'full'>) => {
      if (p.phase === 'fetching' && !p.throttled) {
        const now = Date.now()
        samples.push({ at: now, done: p.done })
        while (samples.length > 1 && now - samples[0].at > RATE_WINDOW_MS) samples.shift()
      }
      entry.last = { ...p, startedAt, perMinute: perMinute(), full }
      this.onProgress(entry.last)
    }

    const cached = persist ? this.store.loadMessages(accountId) : new Map<string, MailMessage>()
    const saved = persist ? this.store.loadScanState(accountId) : null

    // Resume: ask Gmail what changed since the checkpoint instead of counting the whole inbox again.
    let ids: string[] | null = null
    let unreadNow: (id: string) => boolean = () => false
    let resumed = false
    let arrivedCount: number | undefined
    if (saved && provider.listChanges && Date.now() - saved.listedAt < FULL_RELIST_AFTER_MS) {
      report({ phase: 'listing', done: 0, total: 0, resumed: true })
      const changes = await provider.listChanges(saved.historyId, { onWait: () => report({ phase: 'listing', done: 0, total: 0, resumed: true, throttled: true }) })
      if (changes) {
        const known = new Set(saved.ids)
        const arrived = [...changes.inbox].filter(([id, inInbox]) => inInbox && !known.has(id)).map(([id]) => id)
        const keep = saved.ids.filter((id) => changes.inbox.get(id) !== false)
        ids = [...arrived.reverse(), ...keep] // history lists oldest first; new mail goes on the front
        unreadNow = (id) => changes.unread.get(id) ?? cached.get(id)?.isUnread ?? false
        resumed = true
        arrivedCount = arrived.length
        if (persist) this.store.saveScanState(accountId, { historyId: changes.historyId, listedAt: saved.listedAt, ids })
      }
    }

    // Otherwise (first scan, expired checkpoint, or a stale listing) count the inbox in full.
    if (!ids) {
      report({ phase: 'listing', done: 0, total: 0 })
      const historyId = provider.getHistoryId ? await provider.getHistoryId() : null // taken before listing, so changes made meanwhile are caught next time
      let listed = 0
      const wait = () => report({ phase: 'listing', done: listed, total: 0, throttled: true })
      ids = await provider.listInboxIds(false, {
        onProgress: (n) => { listed = n; report({ phase: 'listing', done: n, total: 0 }) },
        onWait: wait,
      })
      const unread = new Set(await provider.listInboxIds(true, { onWait: wait }))
      unreadNow = (id) => unread.has(id)
      if (persist && historyId) this.store.saveScanState(accountId, { historyId, listedAt: Date.now(), ids })
    }

    const present = new Set(ids)
    const gone = [...cached.keys()].filter((id) => !present.has(id))
    if (persist && gone.length) this.store.deleteMessages(accountId, gone)

    // Everything already cached is usable immediately, before any download.
    const view = snapshot.messages
    const readStateChanged: MailMessage[] = []
    for (const id of ids) {
      const m = cached.get(id)
      if (!m) continue
      const current = m.isUnread === unreadNow(id) ? m : { ...m, isUnread: unreadNow(id) }
      if (current !== m) readStateChanged.push(current) // read/unread changed outside this app
      view.push({ ...current, category: categorize(current) })
    }
    snapshot.inboxTotal = ids.length
    entry.seeded = true
    if (persist && readStateChanged.length) this.store.upsertMessages(accountId, readStateChanged)

    // ids are newest first, so the sample (and any partial scan) covers the most recent mail
    const wanted = full ? ids : ids.slice(0, this.sampleSize)
    const missing = wanted.filter((id) => !cached.has(id))
    const leftOut = ids.length - wanted.length - ids.slice(wanted.length).filter((id) => cached.has(id)).length
    const have = view.length // already downloaded by earlier scans, and still in the inbox
    const total = have + missing.length // what this scan will cover, not the whole inbox when sampling
    const detail = { alreadyHad: have || undefined, arrived: arrivedCount }
    let processed = 0 // messages handled so far, including any that vanished before they could be fetched
    if (missing.length) report({ phase: 'fetching', done: have, total, ...detail }) // show the bar right away, already part-full when resuming
    for (let i = 0; i < missing.length && !signal.aborted; i += FETCH_CHUNK) {
      const chunk = missing.slice(i, i + FETCH_CHUNK)
      let lastEmit = 0
      const got = await provider.getMessages(chunk, {
        signal,
        onProgress: (n) => {
          const now = Date.now()
          if (now - lastEmit < 200) return // at most ~5 updates a second
          lastEmit = now
          report({ phase: 'fetching', done: have + processed + n, total, ...detail })
        },
        onWait: () => report({ phase: 'fetching', done: have + processed, total, throttled: true, ...detail }),
      })
      if (persist) this.store.upsertMessages(accountId, got)
      for (const m of got) view.push({ ...m, category: categorize(m) })
      processed += chunk.length
      report({ phase: 'fetching', done: have + processed, total, ...detail })
    }

    report({ phase: 'done', done: have + processed, total, resumed, ...detail })
    return { provider, messages: view, inboxTotal: ids.length, complete: !signal.aborted && leftOut === 0 }
  }

  /** How much of the inbox the current view covers, and how long the rest would take. */
  private coverage(v: { messages: MailMessage[]; inboxTotal: number; complete: boolean; scanning: boolean }) {
    const pace = this.getProvider().fetchesPerMinute
    const remaining = v.inboxTotal - v.messages.length
    return {
      inboxTotal: v.inboxTotal, complete: v.complete, scanning: v.scanning,
      fullScanMinutes: pace && remaining > 0 ? Math.ceil(remaining / pace) : undefined,
    }
  }

  async overview(refresh = false): Promise<OverviewResult> {
    if (refresh) this.invalidate()
    const v = await this.current()
    return { ...buildOverview(v.messages), ...this.coverage(v) }
  }

  /** Every sender in the mail scanned so far (the newest sample, or the whole inbox after a full scan). */
  async senders(): Promise<SendersResult> {
    const v = await this.current()
    return { senders: buildSenders(v.messages), scanned: v.messages.length, ...this.coverage(v) }
  }

  /** Reflect a change in the loaded views, dropping messages that left the inbox. */
  private patchViews(ids: string[], actions: MailAction[]): void {
    const set = new Set(ids)
    for (const data of [this.cache, this.stale]) {
      if (!data) continue
      const before = data.messages.length
      data.messages = data.messages.flatMap((m) => {
        if (!set.has(m.id)) return [m]
        const next = applyActionsToMessage(m, actions)
        return next.labels.includes('INBOX') ? [{ ...next, category: m.category }] : []
      })
      data.inboxTotal -= before - data.messages.length
    }
  }

  /** Keep the on-disk copy in step with changes just made through the mail service. */
  private updateCached(accountId: string, ids: string[], actions: MailAction[]): void {
    if (accountId === 'demo' || ids.length === 0) return
    const current = this.store.getMessages(accountId, ids)
    this.store.upsertMessages(accountId, current.map((m) => applyActionsToMessage(m, actions)))
  }

  async storage(): Promise<StorageResult> {
    const provider = this.getProvider()
    if (!provider.getStorageQuota) return { status: 'error', message: 'Storage usage isn’t available for this account.' }
    try {
      return { status: 'ok', quota: await provider.getStorageQuota() }
    } catch (e) {
      if (e instanceof StorageScopeError) return { status: 'needsReconnect' }
      return { status: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  saveRule(rule: Rule): void {
    const problems = validateRule(rule)
    if (problems.length) throw new Error(problems.join(' '))
    this.store.saveRule(rule)
    if (rule.auto && rule.enabled) void this.runAutomatic() // an automatic rule starts working straight away
  }

  async subscriptions(): Promise<Subscription[]> {
    return buildSubscriptions(await this.messages())
  }

  /** Where an unsubscribe can be sent. Re-derived from scanned mail so the renderer can't supply URLs. */
  async unsubscribeTargets(senderEmail: string): Promise<UnsubscribeTargets & { oneClick: boolean }> {
    const sub = (await this.subscriptions()).find((s) => s.email === senderEmail.toLowerCase())
    if (!sub) throw new Error('No unsubscribe information for that sender.')
    return { ...parseListUnsubscribe(sub.listUnsubscribe), oneClick: sub.oneClick }
  }

  /** RFC 8058 one-click: a single POST, no cookies or credentials, redirects not followed. */
  async oneClickUnsubscribe(senderEmail: string): Promise<void> {
    const t = await this.unsubscribeTargets(senderEmail)
    if (!t.https || !t.oneClick) throw new Error('This sender does not support one-click unsubscribe.')
    const res = await fetch(t.https, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok && !(res.status >= 300 && res.status < 400)) throw new Error(`The sender's server refused the request (${res.status}).`)
  }

  createArchiveRule(senderEmail: string): Rule {
    const email = senderEmail.toLowerCase()
    const rule: Rule = {
      id: `archive-${email}`,
      name: `Archive mail from ${email}`,
      enabled: true,
      match: 'all',
      conditions: [{ field: 'senderEmail', op: 'equals', value: email }],
      actions: [{ type: 'addLabel', label: 'Subscriptions' }, { type: 'archive' }],
    }
    this.saveRule(rule)
    return rule
  }

  private requireRule(id: string): Rule {
    const rule = this.store.listRules().find((r) => r.id === id)
    if (!rule) throw new Error(`Unknown rule: ${id}`)
    return rule
  }

  async preview(ruleId: string): Promise<PreviewResult> {
    const v = await this.current()
    const changes = planChanges([this.requireRule(ruleId)], v.messages)
    const ids = new Set(changes.map((c) => c.messageId))
    const matched = v.messages.filter((m) => ids.has(m.id))
    return {
      changes,
      samples: matched.slice(0, 8),
      totalBytes: matched.reduce((n, m) => n + m.sizeBytes, 0),
      basis: { scanned: v.messages.length, inboxTotal: v.inboxTotal, complete: v.complete, scanning: v.scanning },
    }
  }

  /** After mail changed behind the scan's back: refresh at once, or once the running scan ends. */
  private mailChanged(): void {
    this.counted.clear()
    if (this.scanning) this.dirty = true
    else this.invalidate()
  }

  // --- Cleanup rules: found with a Gmail search, so they work on the whole inbox without any scan ---

  cleanupRules(): CleanupRule[] {
    return this.store.listCleanupRules()
  }

  saveCleanupRule(rule: CleanupRule): void {
    const problems = validateCleanup(rule)
    if (problems.length) throw new Error(problems.join(' '))
    this.store.saveCleanupRule(rule)
    if (rule.auto) void this.runAutomatic()
  }

  deleteCleanupRule(id: string): void {
    this.store.deleteCleanupRule(id)
  }

  private cleanupSetup(ruleId: string) {
    const rule = this.store.listCleanupRules().find((r) => r.id === ruleId)
    if (!rule) throw new Error('That cleanup rule no longer exists.')
    const problems = validateCleanup(rule)
    if (problems.length) throw new Error(problems.join(' '))
    const provider = this.getProvider()
    if (!provider.searchInbox) throw new Error('Search-based cleanup isn’t available for this account.')
    return { rule, provider, query: buildQuery(rule.filters, rule.actions) }
  }

  async previewCleanup(ruleId: string): Promise<CleanupPreview> {
    const { provider, query } = this.cleanupSetup(ruleId)
    const ids = await provider.searchInbox!(query)

    // Download a handful of matches (20 quota units each) to show examples and estimate the total size.
    const SAMPLE = 20
    const sampleIds = Array.from({ length: Math.min(SAMPLE, ids.length) }, (_, i) => ids[Math.floor((i * ids.length) / Math.min(SAMPLE, ids.length))])
    const sample = sampleIds.length ? await provider.getMessages(sampleIds) : []
    const exact = ids.length <= SAMPLE
    const average = sample.length ? sample.reduce((n, m) => n + m.sizeBytes, 0) / sample.length : 0
    return {
      query,
      count: ids.length,
      samples: sample.slice(0, 8),
      bytes: exact ? sample.reduce((n, m) => n + m.sizeBytes, 0) : Math.round(average * ids.length),
      bytesAreEstimate: !exact,
      sampled: sample.length,
    }
  }

  /** `confirmation` must be the word TRASH for a rule that could reach everyday mail; checked here, not just on screen. */
  async applyCleanup(ruleId: string, expectedCount: number, confirmation?: string): Promise<ActivityEntry> {
    const { rule, provider, query } = this.cleanupSetup(ruleId)
    const entry = await this.runCleanup(rule, provider, query, expectedCount, confirmation)
    if (!rule.runOnce) return entry
    this.store.deleteCleanupRule(rule.id) // it has done its one job
    return { ...entry, ruleRemoved: true }
  }

  /** How many messages a cleanup matches right now (a Gmail search, 5 units per 500 matches; nothing is downloaded). */
  async cleanupCount(ruleId: string): Promise<{ count: number; query: string }> {
    const { provider, query } = this.cleanupSetup(ruleId)
    return { count: (await provider.searchInbox!(query)).length, query }
  }

  private async runCleanup(rule: CleanupRule, provider: MailProvider, query: string, expectedCount: number, confirmation?: string, automatic = false): Promise<ActivityEntry> {
    if (isBroadTrash(rule) && confirmation?.trim().toUpperCase() !== 'TRASH') {
      throw new Error('This rule can reach everyday mail. Type TRASH to confirm.')
    }
    const ids = await provider.searchInbox!(query) // search again now, so nothing stale is acted on
    if (ids.length > expectedCount * 1.1 + 25) {
      throw new Error(`More mail matches now (${ids.length.toLocaleString()}) than when you previewed (${expectedCount.toLocaleString()}). Preview again to review it.`)
    }
    if (ids.length === 0) throw new Error('Nothing matches this rule right now.')

    const trashed = rule.actions.some((a) => a.type === 'trash')
    await provider.applyActions(ids, rule.actions)
    const undo: UndoStep[] = [{ messageIds: ids, actions: reverseCleanupActions(rule.actions) }]
    this.updateCached(provider.accountId, ids, rule.actions)
    this.patchViews(ids, rule.actions)
    this.mailChanged()
    return this.store.addActivity(rule.name, ids.length, undo, {
      ruleId: savedRuleId(rule.id), bytes: trashed ? this.sizeOf(provider.accountId, ids) : 0, automatic, move: mailMove(rule.actions),
    })
  }

  /**
   * About how many bytes these messages take: exact for any whose size the app already knows (scanned mail), and the
   * average of those for the rest. Nothing is downloaded to work it out, so mail the app has never seen counts as 0.
   */
  private sizeOf(accountId: string, ids: string[]): number {
    const known = new Map<string, number>()
    for (const m of (this.cache?.messages ?? this.stale?.messages ?? [])) known.set(m.id, m.sizeBytes)
    if (accountId !== 'demo') for (const m of this.store.getMessages(accountId, ids)) known.set(m.id, m.sizeBytes)
    let sum = 0, seen = 0
    for (const id of ids) { const n = known.get(id); if (n !== undefined) { sum += n; seen++ } }
    return seen === 0 ? 0 : Math.round(sum + (sum / seen) * (ids.length - seen))
  }

  // --- One sender at a time: the same search-based clean-up, aimed at everything from one address ---

  /** The clean-up for a sender. Trashing keeps starred mail, and "older" keeps the last month. */
  private senderRule(email: string, action: SenderAction): CleanupRule {
    const address = email.trim().toLowerCase()
    if (!/^[^\s<>"(){}\\]+@[^\s<>"(){}\\]+$/.test(address)) throw new Error('That isn’t a valid sender address.')
    const filters: CleanupFilters = { from: address }
    if (action === 'trash' || action === 'trashOlder') filters.keepStarred = true
    if (action === 'trashOlder') filters.olderThan = { value: 1, unit: 'm' }
    const named = {
      archive: { name: `Archive mail from ${address}`, actions: [{ type: 'archive' }] },
      markRead: { name: `Mark mail from ${address} as read`, actions: [{ type: 'markRead' }] },
      trash: { name: `Trash mail from ${address}`, actions: [{ type: 'trash' }] },
      trashOlder: { name: `Trash older mail from ${address}`, actions: [{ type: 'trash' }] },
    }[action] as { name: string; actions: MailAction[] }
    return { id: `sender-${action}`, filters, ...named }
  }

  private requireSearch(): MailProvider {
    const provider = this.getProvider()
    if (!provider.searchInbox) throw new Error('Search-based cleanup isn’t available for this account.')
    return provider
  }

  async senderSummary(email: string): Promise<SenderSummary> {
    const provider = this.requireSearch()
    const actions = ['archive', 'markRead', 'trash', 'trashOlder'] as const
    const found = await Promise.all(actions.map(async (a) => {
      const rule = this.senderRule(email, a)
      return [a, (await provider.searchInbox!(buildQuery(rule.filters, rule.actions))).length] as const
    }))
    return { email: email.trim().toLowerCase(), counts: Object.fromEntries(found) as Record<SenderAction, number>, olderThanMonths: 1 }
  }

  async cleanSender(email: string, action: SenderAction, expectedCount: number): Promise<ActivityEntry> {
    const provider = this.requireSearch()
    const rule = this.senderRule(email, action)
    return this.runCleanup(rule, provider, buildQuery(rule.filters, rule.actions), expectedCount)
  }

  /** Changing mail while a scan is writing the same cache would race, so wait for it or stop it first. */
  private requireNoScan(): void {
    if (this.scanning) throw new Error('A scan is still running. Wait for it to finish or stop it, then try again.')
  }

  async apply(ruleId: string): Promise<ActivityEntry> {
    this.requireNoScan()
    const rule = this.requireRule(ruleId)
    const v = await this.current()
    if (v.scanning) this.requireNoScan()
    const entry = await this.applyRule(rule, v.messages, rule.name)
    this.invalidate() // the next scan reconciles with Gmail; the patched view shows meanwhile
    return entry
  }

  /** Applies one rule to the given messages and records it. The caller decides when to rescan. */
  private async applyRule(rule: Rule, messages: MailMessage[], activityName: string, automatic = false): Promise<ActivityEntry> {
    const ids = planChanges([rule], messages).map((c) => c.messageId)
    return this.commitToMessages(ids, rule.actions, messages, activityName, { ruleId: rule.id, automatic })
  }

  /** Applies the same actions to some scanned messages, records it, and keeps what the app knows in step. */
  private async commitToMessages(ids: string[], actions: MailAction[], messages: MailMessage[], activityName: string, meta: { ruleId?: string; automatic?: boolean }): Promise<ActivityEntry> {
    const byId = new Map(messages.map((m) => [m.id, m]))

    // Group messages that need the same reversal, so undo is a few batched calls rather than one per message
    // (each batchModify call costs 50 quota units).
    const groups = new Map<string, UndoStep>()
    for (const id of ids) {
      const original = byId.get(id)!
      const inverse = inverseActions(original, actions)
      if (!inverse.length) continue
      const key = JSON.stringify(inverse)
      const g = groups.get(key) ?? { messageIds: [], actions: inverse }
      g.messageIds.push(id)
      if (!applyActionsToMessage(original, actions).labels.includes('INBOX')) {
        const { category: _category, ...stored } = original // the category is derived, not stored
        ;(g.restore ??= []).push(stored)
      }
      groups.set(key, g)
    }
    const undo = [...groups.values()]
    const provider = this.getProvider()
    await provider.applyActions(ids, actions)
    this.updateCached(provider.accountId, ids, actions)
    this.patchViews(ids, actions)
    const bytes = actions.some((a) => a.type === 'trash') ? ids.reduce((n, id) => n + (byId.get(id)?.sizeBytes ?? 0), 0) : 0
    return this.store.addActivity(activityName, ids.length, undo, { ...meta, bytes, move: mailMove(actions) })
  }

  // --- Duplicates ---

  async duplicates(): Promise<DuplicatesResult> {
    const v = await this.current()
    const groups = findDuplicates(v.messages)
    const extras = groups.flatMap((g) => g.extras)
    return {
      count: extras.length, bytes: extras.reduce((n, m) => n + m.sizeBytes, 0), groups: groups.length, scanned: v.messages.length, complete: v.complete,
      examples: groups.sort((a, b) => b.extras.length - a.extras.length).slice(0, 3).map((g) => ({ from: g.keep.from.name || g.keep.from.email, subject: g.keep.subject, copies: g.extras.length + 1 })),
    }
  }

  /** Moves the extra copies to Trash, keeping the newest of each. Works on the scanned mail, so it can't run during a scan. */
  async trashDuplicates(expectedCount: number): Promise<ActivityEntry> {
    this.requireNoScan()
    const v = await this.current()
    if (v.scanning) this.requireNoScan()
    const ids = findDuplicates(v.messages).flatMap((g) => g.extras.map((m) => m.id))
    if (ids.length === 0) throw new Error('No duplicates found right now.')
    if (ids.length > expectedCount * 1.1 + 25) throw new Error(`More duplicates are listed now (${ids.length.toLocaleString()}) than you were shown (${expectedCount.toLocaleString()}). Look again before moving them.`)
    const entry = await this.commitToMessages(ids, [{ type: 'trash' }], v.messages, 'Remove duplicate messages', {})
    this.invalidate() // the next scan reconciles with Gmail; the patched view shows meanwhile
    return entry
  }

  // --- Sharing rules ---

  exportRules(): RulesExport {
    return { app: 'email-organizer', version: 1, exportedAt: new Date().toISOString(), cleanupRules: this.store.listCleanupRules(), rules: this.store.listRules() }
  }

  /**
   * Adds rules from an exported file. The file is untrusted, so each rule is checked like any the user types in, gets a
   * new id, and loses anything that would let it act without the user: automatic runs, run-once, and the "include
   * everyday mail" consent. Rules that fail the checks are skipped, with the reason.
   */
  importRules(data: unknown): ImportResult {
    const file = data as Partial<RulesExport> | null
    if (!file || typeof file !== 'object' || file.app !== 'email-organizer' || !Array.isArray(file.cleanupRules ?? []) || !Array.isArray(file.rules ?? [])) {
      throw new Error('That isn’t a rules file from Email Organizer.')
    }
    const cleanups = (file.cleanupRules ?? []).slice(0, IMPORT_LIMIT)
    const scanned = (file.rules ?? []).slice(0, IMPORT_LIMIT)
    const result: ImportResult = { added: 0, skipped: [] }
    const named = (r: unknown) => (r && typeof r === 'object' && typeof (r as { name?: unknown }).name === 'string' ? (r as { name: string }).name : 'Unnamed rule')

    for (const raw of cleanups) {
      try {
        const r = raw as CleanupRule
        if (!r || typeof r.filters !== 'object' || !Array.isArray(r.actions)) throw new Error('It isn’t a cleanup rule.')
        const { auto: _a, runOnce: _o, allowBroad: _b, ...rest } = r
        const rule: CleanupRule = { ...rest, id: randomUUID() }
        const problems = validateCleanup(rule)
        if (problems.length) throw new Error(problems[0])
        this.store.saveCleanupRule(rule)
        result.added++
      } catch (e) { result.skipped.push({ name: named(raw), reason: e instanceof Error ? e.message : String(e) }) }
    }
    for (const raw of scanned) {
      try {
        const r = raw as Rule
        if (!r || !Array.isArray(r.conditions) || !Array.isArray(r.actions)) throw new Error('It isn’t a rule.')
        const { auto: _a, ...rest } = r
        const rule: Rule = { ...rest, id: randomUUID() }
        const problems = validateRule(rule)
        if (problems.length) throw new Error(problems[0])
        this.store.saveRule(rule)
        result.added++
      } catch (e) { result.skipped.push({ name: named(raw), reason: e instanceof Error ? e.message : String(e) }) }
    }
    return result
  }

  // --- Suggestions: senders the user barely reads ---

  /**
   * Senders with plenty of mail that is almost never opened: a newsletter read less than a fifth of the time, or anything
   * else practically never. Each comes with its reason. Hidden once dismissed or once a cleanup for that sender exists.
   */
  async suggestions(): Promise<SuggestionsResult> {
    const v = await this.current()
    const dismissed = new Set(this.store.listDismissed())
    const covered = new Set(this.store.listCleanupRules().map((r) => r.filters.from?.toLowerCase()).filter(Boolean))
    const items: Suggestion[] = []
    for (const s of buildSenders(v.messages)) {
      if (s.count < SUGGESTION_MIN_MAIL || dismissed.has(`sender:${s.email}`) || covered.has(s.email)) continue
      const read = s.count - s.unread
      if (read / s.count > (s.hasUnsubscribe ? 0.2 : 0.05)) continue
      const who = s.name || s.email
      items.push({
        id: `sender:${s.email}`, email: s.email, name: who, count: s.count, unread: s.unread, hasUnsubscribe: s.hasUnsubscribe, bytes: s.bytes,
        why: (read === 0 ? `You haven’t opened any of their ${s.count.toLocaleString()} emails.` : `You’ve opened only ${read.toLocaleString()} of their ${s.count.toLocaleString()} emails.`)
          + (s.hasUnsubscribe ? ' They offer an unsubscribe link.' : ''),
      })
    }
    return { items: items.sort((a, b) => b.count - a.count).slice(0, 10), scanned: v.messages.length, inboxTotal: v.inboxTotal, complete: v.complete }
  }

  dismissSuggestion(id: string): void {
    this.store.dismiss(id)
  }

  /** An automatic cleanup that archives one sender's mail: what "archive them from now on" means. */
  autoArchiveSender(email: string): void {
    const address = this.senderRule(email, 'archive').filters.from! // checks it's a real address
    const id = `auto-archive-${address}`
    if (this.store.listCleanupRules().some((r) => r.id === id)) return
    this.saveCleanupRule({ id, name: `Archive mail from ${address}`, filters: { from: address }, actions: [{ type: 'archive' }], auto: true })
  }

  // --- Free up space ---

  /** The account's storage, and what could be moved to Trash to free some. Cached until mail changes. */
  spaceGuide(): Promise<SpaceGuide> {
    return this.countOnce('space', (provider) => this.buildSpaceGuide(provider)) as Promise<SpaceGuide>
  }

  private async buildSpaceGuide(provider: MailProvider): Promise<SpaceGuide> {
    if (!provider.searchInbox) throw new Error('Search-based cleanup isn’t available for this account.')
    const quota = await provider.getStorageQuota?.().then((q) => ({ usedBytes: q.usedBytes, limitBytes: q.limitBytes }), () => null) ?? null
    const found: SpaceCandidate[] = []
    for (const def of SPACE_CANDIDATES) {
      const ids = await provider.searchInbox(buildQuery(def.filters, [{ type: 'trash' }]))
      if (ids.length === 0) continue
      const n = Math.min(SPACE_SAMPLE, ids.length)
      const sample = await provider.getMessages(Array.from({ length: n }, (_, i) => ids[Math.floor((i * ids.length) / n)]))
      const total = sample.reduce((sum, m) => sum + m.sizeBytes, 0)
      found.push({
        id: def.id, title: def.title, blurb: def.blurb, count: ids.length,
        bytes: sample.length === 0 ? 0 : ids.length <= SPACE_SAMPLE ? total : Math.round((total / sample.length) * ids.length),
        bytesAreEstimate: ids.length > SPACE_SAMPLE,
        samples: [...sample].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 3)
          .map((m) => ({ from: m.from.name || m.from.email, subject: m.subject, date: m.date, sizeBytes: m.sizeBytes })),
      })
    }
    return { quota, candidates: found.sort((a, b) => b.bytes - a.bytes) }
  }

  /** Moves one of the guide's candidates to Trash. The search is the app's own, never one the page supplies. */
  async cleanSpace(id: string, expectedCount: number): Promise<ActivityEntry> {
    const def = SPACE_CANDIDATES.find((c) => c.id === id)
    if (!def) throw new Error('That isn’t something the guide suggested.')
    const provider = this.requireSearch()
    const rule: CleanupRule = { id: `space-${id}`, name: `Free up space: ${def.title}`, filters: def.filters, actions: [{ type: 'trash' }] }
    return this.runCleanup(rule, provider, buildQuery(rule.filters, rule.actions), expectedCount)
  }

  // --- Impact: what the app has done for the user ---

  /** This month's and all-time totals, and each rule's lifetime count. Undone changes don't count. */
  impact(): ImpactSummary {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const done = this.store.activitySince().filter((a) => !a.undone)
    const unsubscribes = this.store.listUnsubscribes()
    const totals = (rows: typeof done, since?: string): ImpactTotals => ({
      messages: rows.reduce((n, a) => n + a.messageCount, 0),
      bytesTrashed: rows.reduce((n, a) => n + (a.bytes ?? 0), 0),
      trashed: rows.filter((a) => a.move === 'trash').reduce((n, a) => n + a.messageCount, 0),
      archived: rows.filter((a) => a.move === 'archive').reduce((n, a) => n + a.messageCount, 0),
      automatic: rows.filter((a) => a.automatic).reduce((n, a) => n + a.messageCount, 0),
      runs: rows.length,
      unsubscribes: unsubscribes.filter((u) => !since || u.at >= since).length,
    })
    const byRule: ImpactSummary['byRule'] = {}
    for (const a of done) if (a.ruleId) (byRule[a.ruleId] ??= { messages: 0 }).messages += a.messageCount
    return { month: totals(done.filter((a) => a.at >= monthStart), monthStart), all: totals(done), byRule }
  }

  /** Remember an unsubscribe the user just sent, so a later check can tell whether the sender really stopped. */
  async recordUnsubscribe(email: string, method: UnsubscribeRecord['method']): Promise<void> {
    const address = email.trim().toLowerCase()
    const name = (await this.subscriptions().catch(() => [])).find((s) => s.email === address)?.name ?? address
    this.store.recordUnsubscribe({ email: address, name, at: new Date().toISOString(), method, status: 'waiting' })
  }

  unsubscribeStatus(): UnsubscribeRecord[] {
    return this.store.listUnsubscribes()
  }

  /**
   * Checks, a week after each unsubscribe, whether the sender really stopped (a Gmail search for anything they sent
   * since). Senders that kept sending get an automatic archive cleanup, so they stop cluttering the inbox even though
   * unsubscribing didn't work. Returns how many records changed.
   */
  async checkUnsubscribes(now = Date.now()): Promise<number> {
    const provider = this.getProvider()
    if (!provider.searchInbox) return 0
    let changed = 0
    for (const record of this.store.listUnsubscribes()) {
      if (record.status === 'worked' || record.ruleId) continue
      const checkAfter = Date.parse(record.at) + UNSUBSCRIBE_GRACE_MS
      if (now < checkAfter) continue
      // anywhere in the mailbox, not just the inbox: mail they sent that some other rule already filed away still counts
      const since = Math.floor(checkAfter / 1000)
      const sent = await provider.searchInbox(`from:(${this.senderRule(record.email, 'archive').filters.from}) after:${since}`)
      if (sent.length === 0) {
        this.store.recordUnsubscribe({ ...record, status: 'worked', checkedAt: new Date(now).toISOString() })
      } else {
        const rule: CleanupRule = {
          id: `unsub-${record.email}`, name: `Archive ${record.name} (still sending after unsubscribe)`,
          filters: { from: record.email }, actions: [{ type: 'archive' }], auto: true,
        }
        if (!this.store.listCleanupRules().some((r) => r.id === rule.id)) this.store.saveCleanupRule(rule)
        this.store.recordUnsubscribe({ ...record, status: 'still_sending', checkedAt: new Date(now).toISOString(), ruleId: rule.id })
      }
      changed++
    }
    return changed
  }

  // --- Automatic rules and cleanups: applied on their own, with limits, because nobody is there to preview them ---

  automation(): AutomationStatus {
    return { ...this.auto, needsReview: [...this.auto.needsReview], errors: [...this.auto.errors] }
  }

  /** Runs every automatic cleanup and rule once. Never runs two at the same time. */
  runAutomatic(): Promise<AutomationStatus> {
    this.automating ??= this.runAutomaticNow().finally(() => { this.automating = null })
    return this.automating
  }

  private async runAutomaticNow(): Promise<AutomationStatus> {
    const needsReview: AutomationStatus['needsReview'] = []
    const errors: AutomationStatus['errors'] = []
    let changed = 0
    const ran: ActivityEntry[] = []
    const provider = this.getProvider()

    // first, so a sender that kept sending is archived in this same run
    try { await this.checkUnsubscribes() } catch (e) { errors.push({ name: 'Unsubscribe check', message: e instanceof Error ? e.message : String(e), kind: 'cleanup' }) }

    for (const rule of this.store.listCleanupRules().filter((r) => r.auto && !r.runOnce)) {
      try {
        if (!provider.searchInbox) continue
        const problems = validateCleanup(rule)
        if (problems.length) { errors.push({ name: rule.name, message: problems[0], kind: 'cleanup' }); continue }
        const query = buildQuery(rule.filters, rule.actions)
        const count = (await provider.searchInbox(query)).length
        if (count === 0) continue
        if (rule.actions.some((a) => a.type === 'trash') && count > AUTO_TRASH_LIMIT) {
          needsReview.push({ id: rule.id, name: rule.name, count, kind: 'cleanup' })
          continue
        }
        ran.push(await this.runCleanup({ ...rule, name: `${rule.name} (automatic)` }, provider, query, count, undefined, true))
        changed++
      } catch (e) {
        errors.push({ name: rule.name, message: e instanceof Error ? e.message : String(e), kind: 'cleanup' })
      }
    }

    // Header-based rules work on mail that has already been scanned, so they only run when that view is ready.
    const autoRules = this.store.listRules().filter((r) => r.auto && r.enabled)
    if (autoRules.length && !this.scanning && this.cache?.provider === provider) {
      for (const rule of autoRules) {
        try {
          const messages = this.cache?.messages ?? this.stale?.messages ?? []
          const count = planChanges([rule], messages).length
          if (count === 0) continue
          if (rule.actions.some((a) => a.type === 'trash') && count > AUTO_TRASH_LIMIT) {
            needsReview.push({ id: rule.id, name: rule.name, count, kind: 'rule' })
            continue
          }
          ran.push(await this.applyRule(rule, messages, `${rule.name} (automatic)`, true))
          changed++
        } catch (e) {
          errors.push({ name: rule.name, message: e instanceof Error ? e.message : String(e), kind: 'rule' })
        }
      }
      if (changed) this.mailChanged()
    }

    this.auto = {
      lastRunAt: new Date().toISOString(), needsReview, errors, runs: this.auto.runs + (changed ? 1 : 0),
      lastChanged: ran.reduce((n, e) => n + e.messageCount, 0), lastSummary: describeRun(ran),
    }
    if (changed || needsReview.length || errors.length) this.onAutomatic(this.automation())
    return this.automation()
  }

  async undo(activityId: number): Promise<void> {
    const steps = this.store.takeUndo(activityId)
    if (!steps) throw new Error('Nothing to undo')
    const provider = this.getProvider()
    for (const s of steps) {
      await provider.applyActions(s.messageIds, s.actions)
      this.updateCached(provider.accountId, s.messageIds, s.actions)
      if (s.restore?.length && provider.accountId !== 'demo') this.store.upsertMessages(provider.accountId, s.restore)
    }
    this.mailChanged()
  }
}
