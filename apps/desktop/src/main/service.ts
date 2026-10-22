import {
  StorageScopeError, applyActionsToMessage, buildOverview, buildSubscriptions, categorize, inverseActions, parseListUnsubscribe, planChanges, validateRule,
  type MailAction, type MailMessage, type MailProvider, type Rule, type Subscription, type UnsubscribeTargets,
} from '@organizer/core'
import type { ActivityEntry, OverviewResult, PreviewResult, ScanProgress, StorageResult } from '../shared'
import type { Store, UndoStep } from './db'

/** New messages are downloaded and saved in chunks of this size, so progress survives a stop or crash. */
const FETCH_CHUNK = 50
/** A scan that finishes within this long (small inboxes, cached mail) is awaited instead of reported as in progress. */
const SETTLE_MS = 400
const RATE_WINDOW_MS = 90_000
/** Gmail history is only reliable for about a week, so recount the whole inbox at least this often. */
const FULL_RELIST_AFTER_MS = 6 * 24 * 3_600_000

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
  /** The last finished view, shown while a rescan is still counting the inbox so the screen never goes blank. */
  private stale: ScanData | null = null

  constructor(
    private getProvider: () => MailProvider,
    private store: Store,
    private onProgress: (p: ScanProgress) => void = () => {},
  ) {
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
  }

  /** Stop the running scan. Whatever has been scanned is kept, and the next scan resumes from there. */
  cancelScan(): void {
    if (!this.scanning) return
    this.scanning.abort.abort()
    if (this.scanning.last) this.onProgress({ ...this.scanning.last, stopping: true }) // so the UI can say "Stopping…"
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
        if (this.scanning === entry) { this.cache = data; this.scanning = null } // not if invalidated mid-scan
      },
      (e) => {
        if (this.scanning === entry) { this.scanning = null; this.failure = e }
      },
    )
    this.scanning = entry
    return entry
  }

  /**
   * Incremental full-inbox scan. Listing ids is cheap, so each scan lists every inbox id and the unread
   * ids, drops cached messages that left the inbox, and downloads metadata only for messages not yet cached.
   * Everything known is published to `entry.snapshot` as it goes, so callers can show partial results.
   */
  private async runScan(entry: ScanEntry): Promise<ScanData> {
    const { provider, snapshot } = entry
    const signal = entry.abort.signal
    const accountId = provider.accountId
    const persist = accountId !== 'demo' // the demo mailbox lives in memory

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
    const report = (p: Omit<ScanProgress, 'startedAt' | 'perMinute'>) => {
      if (p.phase === 'fetching' && !p.throttled) {
        const now = Date.now()
        samples.push({ at: now, done: p.done })
        while (samples.length > 1 && now - samples[0].at > RATE_WINDOW_MS) samples.shift()
      }
      entry.last = { ...p, startedAt, perMinute: perMinute() }
      this.onProgress(entry.last)
    }

    const cached = persist ? this.store.loadMessages(accountId) : new Map<string, MailMessage>()
    const saved = persist ? this.store.loadScanState(accountId) : null

    // Resume: ask Gmail what changed since the checkpoint instead of counting the whole inbox again.
    let ids: string[] | null = null
    let unreadNow: (id: string) => boolean = () => false
    let resumed = false
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

    const missing = ids.filter((id) => !cached.has(id)) // newest first, so a partial scan covers the most recent mail
    let processed = 0 // messages handled so far, including any that vanished before they could be fetched
    if (missing.length) report({ phase: 'fetching', done: 0, total: missing.length }) // show the bar right away
    for (let i = 0; i < missing.length && !signal.aborted; i += FETCH_CHUNK) {
      const chunk = missing.slice(i, i + FETCH_CHUNK)
      let lastEmit = 0
      const got = await provider.getMessages(chunk, {
        signal,
        onProgress: (n) => {
          const now = Date.now()
          if (now - lastEmit < 200) return // at most ~5 updates a second
          lastEmit = now
          report({ phase: 'fetching', done: processed + n, total: missing.length })
        },
        onWait: () => report({ phase: 'fetching', done: processed, total: missing.length, throttled: true }),
      })
      if (persist) this.store.upsertMessages(accountId, got)
      for (const m of got) view.push({ ...m, category: categorize(m) })
      processed += chunk.length
      report({ phase: 'fetching', done: processed, total: missing.length })
    }

    report({ phase: 'done', done: processed, total: missing.length, resumed })
    return { provider, messages: view, inboxTotal: ids.length, complete: !signal.aborted }
  }

  async overview(refresh = false): Promise<OverviewResult> {
    if (refresh) this.invalidate()
    const v = await this.current()
    return { ...buildOverview(v.messages), inboxTotal: v.inboxTotal, complete: v.complete, scanning: v.scanning }
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

  /** Changing mail while a scan is writing the same cache would race, so wait for it or stop it first. */
  private requireNoScan(): void {
    if (this.scanning) throw new Error('A scan is still running. Wait for it to finish or stop it, then try again.')
  }

  async apply(ruleId: string): Promise<ActivityEntry> {
    this.requireNoScan()
    const rule = this.requireRule(ruleId)
    const v = await this.current()
    if (v.scanning) this.requireNoScan()
    const messages = v.messages
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
    this.invalidate() // the next scan reconciles with Gmail; the patched view shows meanwhile
    return this.store.addActivity(rule.name, changes.length, undo)
  }

  async undo(activityId: number): Promise<void> {
    this.requireNoScan()
    const steps = this.store.takeUndo(activityId)
    if (!steps) throw new Error('Nothing to undo')
    const provider = this.getProvider()
    for (const s of steps) {
      await provider.applyActions(s.messageIds, s.actions)
      this.updateCached(provider.accountId, s.messageIds, s.actions)
      if (s.restore?.length && provider.accountId !== 'demo') this.store.upsertMessages(provider.accountId, s.restore)
    }
    this.invalidate()
  }
}
