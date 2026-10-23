import {
  StorageScopeError, applyActionsToMessage, buildOverview, buildQuery, buildSenders, isBroadTrash, reverseCleanupActions, validateCleanup, buildSubscriptions, categorize, inverseActions, parseListUnsubscribe, planChanges, validateRule,
  type CleanupFilters, type CleanupRule, type InboxCounts, type MailAction, type MailMessage, type MailProvider, type Rule, type Subscription, type UnsubscribeTargets,
} from '@organizer/core'
import { AUTO_TRASH_LIMIT } from '../shared'
import type { ActivityEntry, CleanupPreview, OverviewResult, PreviewResult, AutomationStatus, ScanProgress, SenderAction, SenderSummary, SendersResult, StorageResult } from '../shared'
import type { Store, UndoStep } from './db'

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
  private auto: AutomationStatus = { lastRunAt: null, needsReview: [], errors: [], runs: 0 }

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

  private async runCleanup(rule: CleanupRule, provider: MailProvider, query: string, expectedCount: number, confirmation?: string): Promise<ActivityEntry> {
    if (isBroadTrash(rule) && confirmation?.trim().toUpperCase() !== 'TRASH') {
      throw new Error('This rule can reach everyday mail. Type TRASH to confirm.')
    }
    const ids = await provider.searchInbox!(query) // search again now, so nothing stale is acted on
    if (ids.length > expectedCount * 1.1 + 25) {
      throw new Error(`More mail matches now (${ids.length.toLocaleString()}) than when you previewed (${expectedCount.toLocaleString()}). Preview again to review it.`)
    }
    if (ids.length === 0) throw new Error('Nothing matches this rule right now.')

    await provider.applyActions(ids, rule.actions)
    const undo: UndoStep[] = [{ messageIds: ids, actions: reverseCleanupActions(rule.actions) }]
    this.updateCached(provider.accountId, ids, rule.actions)
    this.patchViews(ids, rule.actions)
    this.mailChanged()
    return this.store.addActivity(rule.name, ids.length, undo)
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
  private async applyRule(rule: Rule, messages: MailMessage[], activityName: string): Promise<ActivityEntry> {
    const byId = new Map(messages.map((m) => [m.id, m]))
    const changes = planChanges([rule], messages)

    // Group messages that need the same reversal, so undo is a few batched calls rather than one per message
    // (each batchModify call costs 50 quota units).
    const groups = new Map<string, UndoStep>()
    for (const c of changes) {
      const original = byId.get(c.messageId)!
      const inverse = inverseActions(original, c.actions)
      if (!inverse.length) continue
      const key = JSON.stringify(inverse)
      const g = groups.get(key) ?? { messageIds: [], actions: inverse }
      g.messageIds.push(c.messageId)
      if (!applyActionsToMessage(original, c.actions).labels.includes('INBOX')) {
        const { category: _category, ...stored } = original // the category is derived, not stored
        ;(g.restore ??= []).push(stored)
      }
      groups.set(key, g)
    }
    const undo = [...groups.values()]
    const provider = this.getProvider()
    const ids = changes.map((c) => c.messageId)
    await provider.applyActions(ids, rule.actions)
    this.updateCached(provider.accountId, ids, rule.actions)
    this.patchViews(ids, rule.actions)
    return this.store.addActivity(activityName, changes.length, undo)
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
    const provider = this.getProvider()

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
        await this.runCleanup({ ...rule, name: `${rule.name} (automatic)` }, provider, query, count)
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
          await this.applyRule(rule, messages, `${rule.name} (automatic)`)
          changed++
        } catch (e) {
          errors.push({ name: rule.name, message: e instanceof Error ? e.message : String(e), kind: 'rule' })
        }
      }
      if (changed) this.mailChanged()
    }

    this.auto = { lastRunAt: new Date().toISOString(), needsReview, errors, runs: this.auto.runs + (changed ? 1 : 0) }
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
