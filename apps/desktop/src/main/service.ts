import {
  StorageScopeError, applyActionsToMessage, buildOverview, buildSubscriptions, categorize, inverseActions, parseListUnsubscribe, planChanges, validateRule,
  type MailAction, type MailMessage, type MailProvider, type Rule, type Subscription, type UnsubscribeTargets,
} from '@organizer/core'
import type { ActivityEntry, OverviewResult, PreviewResult, ScanProgress, StorageResult } from '../shared'
import type { Store, UndoStep } from './db'

/** New messages are downloaded and saved in chunks of this size, so progress survives a cancel or crash. */
const FETCH_CHUNK = 200

interface ScanData {
  provider: MailProvider
  messages: MailMessage[]
  inboxTotal: number
  complete: boolean
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
  private scanning: { provider: MailProvider; promise: Promise<ScanData>; abort: AbortController } | null = null

  constructor(
    private getProvider: () => MailProvider,
    private store: Store,
    private onProgress: (p: ScanProgress) => void = () => {},
  ) {
    if (store.listRules().length === 0) DEFAULT_RULES.forEach((r) => store.saveRule(r))
  }

  /** Forget the in-memory scan (e.g. the account changed or mail was modified). Cheap: the next scan only downloads what is new. */
  invalidate(): void {
    this.scanning?.abort.abort()
    this.scanning = null
    this.cache = null
  }

  /** Stop the running scan. Whatever has been scanned is kept, and the next scan resumes from there. */
  cancelScan(): void {
    this.scanning?.abort.abort()
  }

  private async messages(): Promise<MailMessage[]> {
    return (await this.scan()).messages
  }

  private scan(): Promise<ScanData> {
    const provider = this.getProvider()
    if (this.cache?.provider === provider) return Promise.resolve(this.cache)
    if (this.scanning?.provider === provider) return this.scanning.promise

    const abort = new AbortController()
    const entry = { provider, abort, promise: undefined as unknown as Promise<ScanData> }
    entry.promise = this.runScan(provider, abort.signal).then(
      (data) => {
        if (this.scanning === entry) { this.cache = data; this.scanning = null } // not if invalidated mid-scan
        return data
      },
      (e) => {
        if (this.scanning === entry) this.scanning = null
        throw e
      },
    )
    this.scanning = entry
    return entry.promise
  }

  /**
   * Incremental full-inbox scan. Listing ids is cheap, so each scan lists every inbox id and the unread
   * ids, drops cached messages that left the inbox, and downloads metadata only for messages not yet cached.
   */
  private async runScan(provider: MailProvider, signal: AbortSignal): Promise<ScanData> {
    const accountId = provider.accountId
    const persist = accountId !== 'demo' // the demo mailbox lives in memory
    this.onProgress({ phase: 'listing', done: 0, total: 0 })

    const ids = await provider.listInboxIds(false)
    const unread = new Set(await provider.listInboxIds(true))
    const cached = persist ? this.store.loadMessages(accountId) : new Map<string, MailMessage>()

    const present = new Set(ids)
    const gone = [...cached.keys()].filter((id) => !present.has(id))
    if (persist && gone.length) this.store.deleteMessages(accountId, gone)

    const missing = ids.filter((id) => !cached.has(id)) // newest first, so a partial scan covers the most recent mail
    const fetched = new Map<string, MailMessage>()
    for (let i = 0; i < missing.length && !signal.aborted; i += FETCH_CHUNK) {
      const got = await provider.getMessages(missing.slice(i, i + FETCH_CHUNK), { signal })
      if (persist) this.store.upsertMessages(accountId, got)
      for (const m of got) fetched.set(m.id, m)
      this.onProgress({ phase: 'fetching', done: fetched.size, total: missing.length })
    }

    const messages: MailMessage[] = []
    const readStateChanged: MailMessage[] = []
    for (const id of ids) {
      const m = fetched.get(id) ?? cached.get(id)
      if (!m) continue
      const current = m.isUnread === unread.has(id) ? m : { ...m, isUnread: unread.has(id) }
      if (current !== m && cached.has(id)) readStateChanged.push(current) // read/unread changed outside this app
      messages.push({ ...current, category: categorize(current) })
    }
    if (persist && readStateChanged.length) this.store.upsertMessages(accountId, readStateChanged)

    this.onProgress({ phase: 'done', done: fetched.size, total: missing.length })
    return { provider, messages, inboxTotal: ids.length, complete: !signal.aborted }
  }

  async overview(refresh = false): Promise<OverviewResult> {
    if (refresh) this.invalidate()
    const data = await this.scan()
    return { ...buildOverview(data.messages), inboxTotal: data.inboxTotal, complete: data.complete }
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
    const messages = await this.messages()
    const changes = planChanges([this.requireRule(ruleId)], messages)
    const ids = new Set(changes.map((c) => c.messageId))
    const matched = messages.filter((m) => ids.has(m.id))
    return { changes, samples: matched.slice(0, 8), totalBytes: matched.reduce((n, m) => n + m.sizeBytes, 0) }
  }

  async apply(ruleId: string): Promise<ActivityEntry> {
    const rule = this.requireRule(ruleId)
    const messages = await this.messages()
    const byId = new Map(messages.map((m) => [m.id, m]))
    const changes = planChanges([rule], messages)

    const undo: UndoStep[] = []
    for (const c of changes) {
      const inverse = inverseActions(byId.get(c.messageId)!, c.actions)
      if (inverse.length) undo.push({ messageIds: [c.messageId], actions: inverse })
    }
    const provider = this.getProvider()
    const ids = changes.map((c) => c.messageId)
    await provider.applyActions(ids, rule.actions)
    this.updateCached(provider.accountId, ids, rule.actions)
    this.invalidate()
    return this.store.addActivity(rule.name, changes.length, undo)
  }

  async undo(activityId: number): Promise<void> {
    const steps = this.store.takeUndo(activityId)
    if (!steps) throw new Error('Nothing to undo')
    const provider = this.getProvider()
    for (const s of steps) {
      await provider.applyActions(s.messageIds, s.actions)
      this.updateCached(provider.accountId, s.messageIds, s.actions)
    }
    this.invalidate()
  }
}
