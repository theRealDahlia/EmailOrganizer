import { describe, expect, it } from 'vitest'
import { DemoProvider, GmailProvider, applyActionsToMessage, buildQuery, type CleanupRule, type InboxChanges, type MailMessage, type Rule } from '@organizer/core'
import type { ScanState, Store } from './db'
import type { ScanProgress, SpaceSource } from '../shared'
import { OrganizerService, describeRun } from './service'

/** In-memory stand-in for Store, so these tests don't need the Electron-built SQLite module. */
class FakeStore {
  rules: Rule[] = []
  cleanup: CleanupRule[] = []
  listCleanupRules() { return this.cleanup }
  saveCleanupRule(r: CleanupRule) { this.cleanup = [...this.cleanup.filter((x) => x.id !== r.id), r] }
  deleteCleanupRule(id: string) { this.cleanup = this.cleanup.filter((x) => x.id !== id) }
  messages = new Map<string, Map<string, MailMessage>>()
  activity: { id: number; undo: unknown; undone: boolean; ruleName: string; messageCount: number; at: string; ruleId?: string; bytes?: number; automatic?: boolean; move?: 'trash' | 'archive' | null }[] = []
  private acct = (a: string) => this.messages.get(a) ?? this.messages.set(a, new Map()).get(a)!
  listRules() { return this.rules }
  saveRule(r: Rule) { this.rules = [...this.rules.filter((x) => x.id !== r.id), r] }
  loadMessages(a: string) { return new Map(this.acct(a)) }
  getMessages(a: string, ids: string[]) { return ids.flatMap((id) => (this.acct(a).has(id) ? [this.acct(a).get(id)!] : [])) }
  upsertMessages(a: string, ms: MailMessage[]) { ms.forEach((m) => this.acct(a).set(m.id, m)) }
  deleteMessages(a: string, ids: string[]) { ids.forEach((id) => this.acct(a).delete(id)) }
  scanStates = new Map<string, ScanState>()
  loadScanState(a: string) { return this.scanStates.get(a) ?? null }
  saveScanState(a: string, s: ScanState) { this.scanStates.set(a, s) }
  addActivity(ruleName: string, messageCount: number, undo: unknown, meta: Record<string, unknown> = {}) {
    const e = { id: this.activity.length + 1, at: new Date().toISOString(), ruleName, messageCount, undo, undone: false, ...meta }
    this.activity.push(e)
    return e
  }
  activitySince() { return this.activity as unknown as import('../shared').ActivityEntry[] }
  dismissed: string[] = []
  dismiss(id: string) { if (!this.dismissed.includes(id)) this.dismissed.push(id) }
  listDismissed() { return this.dismissed }
  unsubscribes: import('../shared').UnsubscribeRecord[] = []
  recordUnsubscribe(r: import('../shared').UnsubscribeRecord) { this.unsubscribes = [...this.unsubscribes.filter((x) => x.email !== r.email), r] }
  listUnsubscribes() { return this.unsubscribes }
  takeUndo(id: number) { const e = this.activity.find((a) => a.id === id); if (!e || e.undone) return null; e.undone = true; return e.undo } // like the real store: once only
}

/** A demo mailbox that looks like a real account and records how much it was asked to download. */
class CountingProvider extends DemoProvider {
  override readonly accountId = 'me@x.com'
  downloaded: string[] = []
  onFetch: () => void = () => {}
  override async getMessages(ids: string[], opts?: { signal?: AbortSignal }) {
    this.downloaded.push(...ids)
    this.onFetch()
    return super.getMessages(ids, opts)
  }
}

/** A mailbox with a change log, like Gmail's history: lets the app ask "what's new since checkpoint N?". */
class HistoryProvider extends CountingProvider {
  version = 100
  listCalls = 0
  expired = false
  private log: { v: number; id: string; inbox?: boolean; unread?: boolean }[] = []
  override async listInboxIds(unreadOnly: boolean, hooks?: Parameters<DemoProvider['listInboxIds']>[1]) {
    this.listCalls++
    return super.listInboxIds(unreadOnly, hooks)
  }
  async getHistoryId() { return String(this.version) }
  async listChanges(since: string): Promise<InboxChanges | null> {
    if (this.expired) return null
    const changes: InboxChanges = { historyId: String(this.version), inbox: new Map(), unread: new Map() }
    for (const e of this.log.filter((x) => x.v > Number(since))) {
      if (e.inbox !== undefined) changes.inbox.set(e.id, e.inbox)
      if (e.unread !== undefined) changes.unread.set(e.id, e.unread)
    }
    return changes
  }
  /** Something happens in the mailbox outside this app. */
  async elsewhere(id: string, change: { inbox?: boolean; unread?: boolean }) {
    this.version++
    this.log.push({ v: this.version, id, ...change })
    const actions: Parameters<DemoProvider['applyActions']>[1] = []
    if (change.inbox === false) actions.push({ type: 'archive' })
    if (change.inbox === true) actions.push({ type: 'addLabel', label: 'INBOX' })
    if (change.unread === false) actions.push({ type: 'markRead' })
    if (change.unread === true) actions.push({ type: 'markUnread' })
    await super.applyActions([id], actions)
  }
}

/** A mailbox whose listing and downloads can be held open, to look at the app mid-scan. */
class BlockingProvider extends CountingProvider {
  holdListing: Promise<void> | null = null
  holdDownloads: Promise<void> | null = null
  override async listInboxIds(unreadOnly: boolean, hooks?: Parameters<DemoProvider['listInboxIds']>[1]) {
    await this.holdListing
    return super.listInboxIds(unreadOnly, hooks)
  }
  override async getMessages(ids: string[], opts?: { signal?: AbortSignal }) {
    if (opts?.signal) await this.holdDownloads // only the scan passes a signal, so one-off lookups still work
    return super.getMessages(ids, opts)
  }
}

const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((r) => { open = r })
  return { promise, open }
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out waiting')
}

const setup = (count: number) => {
  const provider = new CountingProvider(count)
  const store = new FakeStore()
  const service = new OrganizerService(() => provider, store as unknown as Store)
  return { provider, store, service }
}

describe('scan progress', () => {
  it('shows the bar immediately after listing, then counts up to the total', async () => {
    const provider = new CountingProvider(450)
    const events: ScanProgress[] = []
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store, (p) => events.push(p))
    await service.overview()

    const firstFetch = events.findIndex((e) => e.phase === 'fetching')
    expect(events.slice(0, firstFetch).every((e) => e.phase === 'listing')).toBe(true)
    expect(events[firstFetch]).toMatchObject({ phase: 'fetching', done: 0, total: 450 }) // before any download finishes
    const done = events.filter((e) => e.phase === 'fetching').map((e) => e.done)
    expect([...done].sort((a, b) => a - b)).toEqual(done) // never goes backwards
    expect(events.at(-1)).toMatchObject({ phase: 'done', done: 450, total: 450 })
  })

  it('reports nothing to download when everything is cached', async () => {
    const provider = new CountingProvider(20)
    const store = new FakeStore() as unknown as Store
    await new OrganizerService(() => provider, store).overview()
    const events: ScanProgress[] = []
    await new OrganizerService(() => provider, store, (p) => events.push(p)).overview()
    expect(events.some((e) => e.phase === 'fetching')).toBe(false)
    expect(events.at(-1)).toMatchObject({ phase: 'done', done: 20, total: 20, alreadyHad: 20 }) // everything was already downloaded
  })
})

describe('search-based cleanup', () => {
  const oldPromos: CleanupRule = {
    id: 'c', name: 'Old promos', filters: { category: 'promotions', olderThan: { value: 7, unit: 'd' } }, actions: [{ type: 'archive' }],
  }
  const query = buildQuery(oldPromos.filters, oldPromos.actions)

  it('finds matches with a search and downloads only a small sample', async () => {
    const { service, store, provider } = setup(300)
    service.saveCleanupRule(oldPromos)
    const expected = (await provider.searchInbox(query)).length
    expect(expected).toBeGreaterThan(20)

    const preview = await service.previewCleanup('c') // no scan has happened
    expect(preview).toMatchObject({ query, count: expected, bytesAreEstimate: true, sampled: 20 })
    expect(preview.bytes).toBeGreaterThan(0)
    expect(provider.downloaded).toHaveLength(20) // a sample, not all 300
    expect(store.loadMessages('me@x.com').size).toBe(0)
  })

  it('acts on every match in one batch and undoes it exactly', async () => {
    const { service, provider } = setup(300)
    service.saveCleanupRule(oldPromos)
    const before = (await provider.listInboxIds(false)).length
    const { count } = await service.previewCleanup('c')

    const calls: number[] = []
    const original = provider.applyActions.bind(provider)
    provider.applyActions = async (ids, actions) => { calls.push(ids.length); return original(ids, actions) }

    const entry = await service.applyCleanup('c', count)
    expect(entry.messageCount).toBe(count)
    expect(calls).toEqual([count]) // one call
    expect((await provider.listInboxIds(false)).length).toBe(before - count)

    await service.undo(entry.id)
    expect((await provider.listInboxIds(false)).length).toBe(before)
    expect(calls).toEqual([count, count])
  })

  it('works while a scan is still running, and the scan carries on and then catches up', async () => {
    const provider = new BlockingProvider(100)
    const hold = gate()
    provider.holdDownloads = hold.promise
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store)
    expect((await service.overview()).scanning).toBe(true)

    service.saveCleanupRule(oldPromos)
    const { count } = await service.previewCleanup('c')
    await service.applyCleanup('c', count)
    expect((await service.overview()).scanning).toBe(true) // applying did not stop the scan

    hold.open()
    await until(async () => !(await service.overview()).scanning)
    expect(await service.overview()).toMatchObject({ total: 100 - count, complete: true }) // the finished view reflects the cleanup
  })

  it('refuses to apply when far more mail matches than was previewed', async () => {
    const { service } = setup(900)
    service.saveCleanupRule(oldPromos)
    const { count } = await service.previewCleanup('c')
    expect(count).toBeGreaterThan(60)
    await expect(service.applyCleanup('c', Math.floor(count / 3))).rejects.toThrow(/Preview again/)
    await expect(service.applyCleanup('c', count)).resolves.toMatchObject({ messageCount: count }) // the real count is fine
  })

  describe('trashing by age alone (the "older than 9 months" rule)', () => {
    const broad: CleanupRule = {
      id: 'b', name: 'Old mail', filters: { olderThan: { value: 7, unit: 'd' }, keepStarred: true }, actions: [{ type: 'trash' }],
    }

    it('must be opted into when saved', () => {
      const { service } = setup(50)
      expect(() => service.saveCleanupRule(broad)).toThrow(/Include everyday mail/)
      expect(() => service.saveCleanupRule({ ...broad, allowBroad: true })).not.toThrow()
    })

    it('needs the typed word TRASH to run, checked by the service itself', async () => {
      const { service, provider } = setup(300)
      service.saveCleanupRule({ ...broad, allowBroad: true })
      const before = (await provider.listInboxIds(false)).length
      const { count, query } = await service.previewCleanup('b')
      expect(query).toBe('in:inbox older_than:7d -is:starred')
      expect(count).toBeGreaterThan(0)

      await expect(service.applyCleanup('b', count)).rejects.toThrow(/Type TRASH/)
      await expect(service.applyCleanup('b', count, 'yes')).rejects.toThrow(/Type TRASH/)
      expect((await provider.listInboxIds(false)).length).toBe(before) // nothing happened

      await service.applyCleanup('b', count, 'trash')
      expect((await provider.listInboxIds(false)).length).toBe(before - count)
    })

    it('does not ask for the word when the rule is specific', async () => {
      const { service } = setup(300)
      service.saveCleanupRule(oldPromos)
      const { count } = await service.previewCleanup('c')
      await expect(service.applyCleanup('c', count)).resolves.toBeTruthy()
    })
  })

  it('rejects unsafe or empty rules when saving', () => {
    const { service } = setup(10)
    expect(() => service.saveCleanupRule({ ...oldPromos, id: 'x', filters: {} })).toThrow(/whole inbox/)
    expect(() => service.saveCleanupRule({ ...oldPromos, id: 'y', filters: { olderThan: { value: 2, unit: 'y' } }, actions: [{ type: 'trash' }] })).toThrow(/Trash/)
  })
})

describe('progress after a stop', () => {
  it('counts what was already downloaded, so the bar resumes part-full', async () => {
    const provider = new HistoryProvider(450)
    const store = new FakeStore()
    const first = new OrganizerService(() => provider, store as unknown as Store)
    provider.onFetch = () => first.cancelScan()
    const stopped = await first.overview()
    provider.onFetch = () => {}

    const events: ScanProgress[] = []
    await new OrganizerService(() => provider, store as unknown as Store, (p) => events.push(p)).overview()
    const fetching = events.filter((e) => e.phase === 'fetching')
    expect(fetching[0]).toMatchObject({ done: stopped.total, total: 450, alreadyHad: stopped.total }) // not 0 of 450-minus-something
    expect(fetching.every((e) => e.total === 450 && e.done >= stopped.total)).toBe(true)
    expect(events.at(-1)).toMatchObject({ phase: 'done', done: 450, total: 450 })
  })

  it('reports as new only mail that arrived since the last scan', async () => {
    const provider = new HistoryProvider(120)
    const store = new FakeStore()
    await provider.elsewhere('demo-0', { inbox: false })
    await provider.elsewhere('demo-1', { inbox: false })
    await new OrganizerService(() => provider, store as unknown as Store).overview()

    await provider.elsewhere('demo-0', { inbox: true }) // two messages arrive afterwards
    await provider.elsewhere('demo-1', { inbox: true })
    const events: ScanProgress[] = []
    await new OrganizerService(() => provider, store as unknown as Store, (p) => events.push(p)).overview()
    const first = events.find((e) => e.phase === 'fetching')!
    expect(first).toMatchObject({ arrived: 2, alreadyHad: 118, done: 118, total: 120 })
  })

  it('does not call anything new when nothing arrived', async () => {
    const provider = new HistoryProvider(60)
    const store = new FakeStore()
    const first = new OrganizerService(() => provider, store as unknown as Store)
    provider.onFetch = () => first.cancelScan()
    await first.overview()
    provider.onFetch = () => {}
    const events: ScanProgress[] = []
    await new OrganizerService(() => provider, store as unknown as Store, (p) => events.push(p)).overview()
    expect(events.find((e) => e.phase === 'fetching')!.arrived).toBe(0)
  })
})

describe('resuming without recounting', () => {
  const restart = (provider: HistoryProvider, store: FakeStore) =>
    new OrganizerService(() => provider, store as unknown as Store)

  it('picks up where it stopped without listing the inbox again', async () => {
    const provider = new HistoryProvider(450)
    const store = new FakeStore()
    const first = restart(provider, store)
    provider.onFetch = () => first.cancelScan() // stopped partway
    const stopped = await first.overview()
    expect(stopped.complete).toBe(false)
    expect(provider.listCalls).toBe(2) // the one full count: all ids + unread ids

    provider.onFetch = () => {}
    provider.downloaded = []
    const resumed = restart(provider, store) // app restarted
    expect(await resumed.overview()).toMatchObject({ total: 450, complete: true })
    expect(provider.listCalls).toBe(2) // no recount
    expect(provider.downloaded).toHaveLength(450 - stopped.total) // only what was left
  })

  it('also skips the recount for Rescan and Resume in the same session', async () => {
    const provider = new HistoryProvider(60)
    const service = restart(provider, new FakeStore())
    await service.overview()
    await service.overview(true)
    expect(provider.listCalls).toBe(2)
  })

  it('downloads mail that arrived since, and only that', async () => {
    const provider = new HistoryProvider(80)
    const store = new FakeStore()
    await provider.elsewhere('demo-0', { inbox: false }) // start without the newest three
    await provider.elsewhere('demo-1', { inbox: false })
    await provider.elsewhere('demo-2', { inbox: false })
    await restart(provider, store).overview()
    expect(provider.listCalls).toBe(2)

    await provider.elsewhere('demo-0', { inbox: true }) // three messages arrive while the app is closed
    await provider.elsewhere('demo-1', { inbox: true })
    await provider.elsewhere('demo-2', { inbox: true })
    provider.downloaded = []
    const view = await restart(provider, store).overview()
    expect(view).toMatchObject({ total: 80, inboxTotal: 80, complete: true })
    expect(provider.listCalls).toBe(2) // still no recount
    expect(provider.downloaded.sort()).toEqual(['demo-0', 'demo-1', 'demo-2'])
  })

  it('drops mail that left the inbox and tracks read changes, without listing', async () => {
    const provider = new HistoryProvider(40)
    const store = new FakeStore()
    const before = await restart(provider, store).overview()

    const [five, six] = await provider.getMessages(['demo-5', 'demo-6'])
    await provider.elsewhere('demo-5', { inbox: false }) // archived elsewhere
    await provider.elsewhere('demo-6', { unread: !six.isUnread }) // read (or unread) elsewhere
    const after = await restart(provider, store).overview()

    expect(after.total).toBe(before.total - 1)
    const expectedUnread = before.unread - (five.isUnread ? 1 : 0) + (six.isUnread ? -1 : 1)
    expect(after.unread).toBe(expectedUnread)
    expect(provider.listCalls).toBe(2)
    expect(store.loadMessages('me@x.com').has('demo-5')).toBe(false)
  })

  it('recounts in full when Gmail no longer has the history', async () => {
    const provider = new HistoryProvider(30)
    const store = new FakeStore()
    await restart(provider, store).overview()
    provider.expired = true
    await restart(provider, store).overview()
    expect(provider.listCalls).toBe(4)
  })

  it('recounts in full when the last full count is a week old', async () => {
    const provider = new HistoryProvider(30)
    const store = new FakeStore()
    await restart(provider, store).overview()
    const state = store.scanStates.get('me@x.com')!
    store.scanStates.set('me@x.com', { ...state, listedAt: Date.now() - 7 * 24 * 3_600_000 })
    await restart(provider, store).overview()
    expect(provider.listCalls).toBe(4)
  })
})

describe('non-blocking scan', () => {
  it('returns what it has instead of waiting for a long download', async () => {
    const store = new FakeStore() as unknown as Store
    await new OrganizerService(() => new CountingProvider(10), store).overview() // 10 messages already cached

    const provider = new BlockingProvider(30)
    const hold = gate()
    provider.holdDownloads = hold.promise
    const service = new OrganizerService(() => provider, store)

    const view = await service.overview()
    expect(view).toMatchObject({ scanning: true, complete: false, total: 10, inboxTotal: 30 })

    // other features work on the partial data, but mail can't be changed mid-scan
    expect((await service.preview('default-receipts')).basis).toMatchObject({ scanned: 10, inboxTotal: 30, scanning: true })
    await expect(service.apply('default-receipts')).rejects.toThrow(/scan is still running/)

    hold.open()
    await until(async () => !(await service.overview()).scanning)
    expect(await service.overview()).toMatchObject({ total: 30, complete: true, scanning: false })
  })

  it('keeps showing the previous overview while a rescan counts the inbox', async () => {
    const provider = new BlockingProvider(25)
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store)
    expect(await service.overview()).toMatchObject({ total: 25, scanning: false })

    const hold = gate()
    provider.holdListing = hold.promise // the rescan is stuck listing the inbox
    const during = await service.overview(true)
    expect(during).toMatchObject({ scanning: true, total: 25 }) // not blank
    hold.open()
  })

  it('reports that it is stopping when cancelled', async () => {
    const provider = new CountingProvider(450)
    const events: ScanProgress[] = []
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store, (p) => events.push(p))
    provider.onFetch = () => service.cancelScan()
    await service.overview()
    expect(events.some((e) => e.stopping)).toBe(true)
  })

  it('stamps every event with the scan start time, so the clock survives tab switches', async () => {
    const provider = new CountingProvider(120)
    const events: ScanProgress[] = []
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store, (p) => events.push(p))
    await service.overview()
    expect(new Set(events.map((e) => e.startedAt)).size).toBe(1)
  })
})

describe('undo', () => {
  const shopRule = (actions: Rule['actions']): Rule => ({
    id: 'shop', name: 'Shop', enabled: true, match: 'all',
    conditions: [{ field: 'senderDomain', op: 'equals', value: 'shopmart.example' }], actions,
  })

  it('reverses a large rule in a few batched calls, not one per message', async () => {
    const { service, store, provider } = setup(300)
    store.saveRule(shopRule([{ type: 'addLabel', label: 'Shop' }]))
    const { changes } = await service.preview('shop')
    expect(changes.length).toBeGreaterThan(50)
    const entry = await service.apply('shop')

    const calls: string[][] = []
    const original = provider.applyActions.bind(provider)
    provider.applyActions = async (ids, actions) => { calls.push(ids); return original(ids, actions) }
    await service.undo(entry.id)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(changes.length)
  })

  it('brings archived mail back without downloading it again', async () => {
    const { service, store, provider } = setup(300)
    store.saveRule(shopRule([{ type: 'archive' }]))
    const before = (await service.overview()).total
    const entry = await service.apply('shop')
    await until(async () => !(await service.overview()).scanning)
    expect((await service.overview()).total).toBeLessThan(before)

    await service.undo(entry.id)
    provider.downloaded = []
    await service.overview(true)
    await until(async () => !(await service.overview()).scanning)
    expect(await service.overview()).toMatchObject({ total: before, complete: true })
    expect(provider.downloaded).toEqual([]) // restored from the undo log, not re-downloaded
  })
})

describe('full-inbox scan', () => {
  it('scans past 200 messages and caches them', async () => {
    const { service, store } = setup(450)
    const o = await service.overview()
    expect(o).toMatchObject({ total: 450, inboxTotal: 450, complete: true })
    expect(store.loadMessages('me@x.com').size).toBe(450)
  })

  it('downloads only new mail on later scans, and forgets mail that left the inbox', async () => {
    const { service, provider } = setup(30)
    await service.overview()
    provider.downloaded = []

    await provider.applyActions(['demo-3', 'demo-4'], [{ type: 'archive' }]) // left the inbox elsewhere
    const o = await service.overview(true)
    expect(o.total).toBe(28)
    expect(provider.downloaded).toEqual([]) // nothing new, so nothing downloaded
  })

  it('picks up read-state changes made elsewhere without re-downloading', async () => {
    const { service, provider } = setup(10)
    const before = (await service.overview()).unread
    await provider.applyActions(['demo-1'], [{ type: 'markRead' }])
    provider.downloaded = []
    expect((await service.overview(true)).unread).toBe(before - 1)
    expect(provider.downloaded).toEqual([])
  })

  it('keeps partial results when cancelled, then resumes without re-downloading', async () => {
    const { service, provider, store } = setup(450)
    provider.onFetch = () => service.cancelScan() // stop after the first chunk
    const partial = await service.overview()
    expect(partial.complete).toBe(false)
    expect(partial.scanning).toBe(false)
    expect(partial.total).toBeGreaterThan(0)
    expect(partial.total).toBeLessThan(450)
    expect(partial.inboxTotal).toBe(450)
    expect(store.loadMessages('me@x.com').size).toBe(partial.total)

    provider.onFetch = () => {}
    provider.downloaded = []
    const full = await service.overview(true)
    expect(full).toMatchObject({ total: 450, complete: true })
    expect(provider.downloaded).toHaveLength(450 - partial.total) // only the remainder
  })

  it('applies a rule to the whole inbox and keeps the cache in step, with undo', async () => {
    const { service, store } = setup(300)
    store.saveRule({
      id: 'r', name: 'Label shop', enabled: true, match: 'all',
      conditions: [{ field: 'senderDomain', op: 'equals', value: 'shopmart.example' }],
      actions: [{ type: 'addLabel', label: 'Shop' }],
    })
    const preview = await service.preview('r')
    // some matches are among the older messages that the old 200-message cap never saw
    expect(preview.changes.some((c) => Number(c.messageId.split('-')[1]) >= 200)).toBe(true)
    const entry = await service.apply('r')
    const id = preview.changes[0].messageId
    expect(store.loadMessages('me@x.com').get(id)!.labels).toContain('Shop')

    await service.undo(entry.id)
    expect(store.loadMessages('me@x.com').get(id)!.labels).not.toContain('Shop')
  })
})

describe('sampled scan', () => {
  const sampled = (count: number, sampleSize: number) => {
    const provider = new CountingProvider(count)
    const store = new FakeStore()
    const events: ScanProgress[] = []
    const service = new OrganizerService(() => provider, store as unknown as Store, (p) => events.push(p), { sampleSize })
    return { provider, store, service, events }
  }

  it('downloads only the newest messages by default and says how long the rest would take', async () => {
    const { service, provider, events } = sampled(300, 100)
    const o = await service.overview()
    expect(o).toMatchObject({ total: 100, inboxTotal: 300, complete: false, scanning: false })
    expect(provider.downloaded).toEqual(Array.from({ length: 100 }, (_, i) => `demo-${i}`)) // newest first
    expect(events.at(-1)).toMatchObject({ phase: 'done', done: 100, total: 100, full: false })
    expect(o.fullScanMinutes).toBeUndefined() // the demo mailbox isn't rate limited
  })

  it('downloads only the rest when asked for the whole inbox', async () => {
    const { service, provider, events } = sampled(300, 100)
    await service.overview()
    provider.downloaded = []
    service.scanFullInbox()
    expect(await service.overview()).toMatchObject({ total: 300, complete: true })
    expect(provider.downloaded).toHaveLength(200)
    expect(events.at(-1)).toMatchObject({ phase: 'done', total: 300, full: true })

    provider.downloaded = []
    expect(await service.overview(true)).toMatchObject({ total: 300, complete: true }) // a rescan keeps the whole inbox covered
    expect(provider.downloaded).toEqual([])
  })

  it('goes back to the sample when a full scan is stopped', async () => {
    const { service, provider } = sampled(450, 100)
    await service.overview()
    service.scanFullInbox()
    provider.onFetch = () => service.cancelScan()
    const stopped = await service.overview()
    expect(stopped).toMatchObject({ complete: false, scanning: false })
    expect(stopped.total).toBeLessThan(450)

    provider.onFetch = () => {}
    provider.downloaded = []
    expect((await service.overview(true)).complete).toBe(false)
    expect(provider.downloaded).toEqual([]) // the newest 100 are already cached, so the sample needs nothing
  })

  it('counts the whole inbox and its tabs without downloading any mail', async () => {
    const { service, provider } = sampled(300, 100)
    const counts = await service.inboxCounts()
    const tabs = await service.tabCounts()
    expect(counts).toEqual({ total: 300, unread: 225 })
    expect(Object.values(tabs!).reduce((a, b) => a + b, 0)).toBe(300)
    expect(provider.downloaded).toEqual([])
  })

  it('recounts after a cleanup changes the inbox', async () => {
    const { service, store } = sampled(300, 100)
    expect((await service.inboxCounts())!.total).toBe(300)
    const rule: CleanupRule = { id: 'c', name: 'Old', filters: { olderThan: { value: 30, unit: 'd' } }, actions: [{ type: 'archive' }] }
    store.saveCleanupRule(rule)
    const { count } = await service.previewCleanup('c')
    await service.applyCleanup('c', count)
    expect((await service.inboxCounts())!.total).toBe(300 - count)
  })

  it('reports no counts for a mail service that cannot give them', async () => {
    const provider = new CountingProvider(10)
    Object.assign(provider, { inboxCounts: undefined, tabCounts: undefined })
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store)
    expect(await service.inboxCounts()).toBeNull()
    expect(await service.tabCounts()).toBeNull()
  })
})

describe('one sender at a time', () => {
  const mailbox = (count = 300) => {
    const provider = new CountingProvider(count)
    const store = new FakeStore()
    return { provider, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }
  const fromSender = (provider: CountingProvider, email: string) =>
    provider.listMessages().then((p) => p.messages.filter((m) => m.from.email === email))

  it('counts what each clean-up would change without downloading mail', async () => {
    const { service, provider } = mailbox()
    const all = (await fromSender(provider, 'deals@shopmart.example')).filter((m) => m.labels.includes('INBOX'))
    const summary = await service.senderSummary('deals@shopmart.example')
    expect(summary.counts.archive).toBe(all.length)
    expect(summary.counts.markRead).toBe(all.filter((m) => m.isUnread).length)
    expect(summary.counts.trashOlder).toBe(all.filter((m) => Date.now() - Date.parse(m.date) > 30 * 86_400_000).length)
    expect(summary.counts.trashOlder).toBeLessThan(summary.counts.trash)
    expect(provider.downloaded).toEqual([])
  })

  it('trashes only that sender, can be undone, and shows in Activity', async () => {
    const { service, provider, store } = mailbox()
    const before = (await fromSender(provider, 'deals@shopmart.example')).length
    const others = (await provider.listMessages()).messages.length - before
    const { counts } = await service.senderSummary('deals@shopmart.example')
    const entry = await service.cleanSender('deals@shopmart.example', 'trash', counts.trash)
    expect(entry.messageCount).toBe(counts.trash)
    expect(store.activity[0].ruleName).toBe('Trash mail from deals@shopmart.example')
    expect((await provider.listInboxIds(false)).length).toBe(300 - counts.trash)
    expect((await provider.listMessages()).messages.length - before).toBe(others) // nobody else was touched

    await service.undo(entry.id)
    expect((await provider.listInboxIds(false)).length).toBe(300)
  })

  it('marks read and archives, and refuses when far more mail matches than was shown', async () => {
    const { service, provider } = mailbox()
    const { counts } = await service.senderSummary('news@dailydigest.example')
    await service.cleanSender('news@dailydigest.example', 'markRead', counts.markRead)
    expect((await service.senderSummary('news@dailydigest.example')).counts.markRead).toBe(0)

    await expect(service.cleanSender('news@dailydigest.example', 'archive', 1)).rejects.toThrow(/More mail matches now/)
    await service.cleanSender('news@dailydigest.example', 'archive', counts.archive)
    expect((await provider.searchInbox!('in:inbox from:(news@dailydigest.example)')).length).toBe(0)
  })

  it('rejects an address that could change the search', async () => {
    const { service } = mailbox()
    await expect(service.senderSummary('a@b.com) OR (in:inbox')).rejects.toThrow(/valid sender/)
    await expect(service.cleanSender('not an address', 'trash', 10)).rejects.toThrow(/valid sender/)
  })
})

describe('senders list', () => {
  it('lists every sender in the scanned mail and says how much of the inbox that covers', async () => {
    const provider = new CountingProvider(300)
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store, () => {}, { sampleSize: 100 })
    const partial = await service.senders()
    expect(partial).toMatchObject({ scanned: 100, inboxTotal: 300, complete: false, scanning: false })
    expect(partial.senders.reduce((n, s) => n + s.count, 0)).toBe(100)

    service.scanFullInbox()
    const full = await service.senders()
    expect(full).toMatchObject({ scanned: 300, complete: true })
    expect(full.senders.reduce((n, s) => n + s.count, 0)).toBe(300)
    expect(full.senders.map((s) => s.count)).toEqual([...full.senders.map((s) => s.count)].sort((a, b) => b - a))
  })

  it('reflects a clean-up straight away', async () => {
    const provider = new CountingProvider(300)
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store)
    const before = (await service.senders()).senders.find((s) => s.email === 'deals@shopmart.example')!
    const { counts } = await service.senderSummary('deals@shopmart.example')
    await service.cleanSender('deals@shopmart.example', 'archive', counts.archive)
    const after = await service.senders()
    expect(before.count).toBe(counts.archive)
    expect(after.senders.find((s) => s.email === 'deals@shopmart.example')).toBeUndefined()
  })
})

describe('run once cleanups', () => {
  const setupOnce = () => {
    const provider = new CountingProvider(300)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    const rule: CleanupRule = { id: 'once', name: 'Drop ShopMart deals', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }], runOnce: true }
    store.saveCleanupRule(rule)
    return { provider, store, service, rule }
  }

  it('counts the matches without a preview or any download', async () => {
    const { service, provider } = setupOnce()
    const { count } = await service.cleanupCount('once')
    expect(count).toBe((await service.previewCleanup('once')).count)
    expect(count).toBeGreaterThan(0)
    provider.downloaded = []
    await service.cleanupCount('once')
    expect(provider.downloaded).toEqual([])
  })

  it('moves the mail to Trash, then removes the cleanup', async () => {
    const { service, provider, store } = setupOnce()
    const { count } = await service.cleanupCount('once')
    const entry = await service.applyCleanup('once', count)
    expect(entry).toMatchObject({ messageCount: count, ruleRemoved: true })
    expect(store.cleanup).toEqual([])
    expect((await provider.listInboxIds(false)).length).toBe(300 - count)
    expect((await provider.searchInbox!('in:inbox from:(deals@shopmart.example)')).length).toBe(0)

    await service.undo(entry.id as number) // the mail comes back, but the cleanup stays gone
    expect((await provider.listInboxIds(false)).length).toBe(300)
    expect(store.cleanup).toEqual([])
  })

  it('keeps the cleanup when the run fails, so it can be tried again', async () => {
    const { service, provider, store } = setupOnce()
    const { count } = await service.cleanupCount('once')
    provider.applyActions = async () => { throw new Error('offline') }
    await expect(service.applyCleanup('once', count)).rejects.toThrow('offline')
    expect(store.cleanup.map((r) => r.id)).toEqual(['once'])
  })

  it('leaves an ordinary cleanup in place after it runs', async () => {
    const { service, store, rule } = setupOnce()
    store.saveCleanupRule({ ...rule, runOnce: false })
    const { count } = await service.cleanupCount('once')
    expect(await service.applyCleanup('once', count)).not.toHaveProperty('ruleRemoved')
    expect(store.cleanup).toHaveLength(1)
  })
})

describe('automatic rules and cleanups', () => {
  const setupAuto = (count = 300) => {
    const provider = new CountingProvider(count)
    const store = new FakeStore()
    const notices: unknown[] = []
    const service = new OrganizerService(() => provider, store as unknown as Store, () => {}, { onAutomatic: (s) => notices.push(s) })
    return { provider, store, service, notices }
  }
  const cleanup = (over: Partial<CleanupRule> = {}): CleanupRule =>
    ({ id: 'a', name: 'Auto ShopMart', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }], auto: true, ...over })

  it('applies an automatic cleanup on its own, labels the activity, and has nothing left to do next time', async () => {
    const { service, provider, store, notices } = setupAuto()
    store.saveCleanupRule(cleanup())
    const before = (await provider.searchInbox!('in:inbox from:(deals@shopmart.example)')).length
    expect(before).toBeGreaterThan(0)

    const status = await service.runAutomatic()
    expect(status).toMatchObject({ runs: 1, needsReview: [], errors: [] })
    expect(store.activity.map((a) => [a.ruleName, a.messageCount])).toEqual([['Auto ShopMart (automatic)', before]])
    expect((await provider.searchInbox!('in:inbox from:(deals@shopmart.example)')).length).toBe(0)
    expect(store.cleanup).toHaveLength(1) // an automatic cleanup stays
    expect(notices).toHaveLength(1)

    await service.runAutomatic()
    expect(store.activity).toHaveLength(1)
    expect(notices).toHaveLength(1) // a run that changes nothing says nothing
  })

  it('starts working as soon as an automatic cleanup is saved', async () => {
    const { service, store } = setupAuto()
    service.saveCleanupRule(cleanup())
    await service.runAutomatic() // joins the run that saving started
    expect(store.activity).toHaveLength(1)
  })

  it('leaves a manual cleanup alone', async () => {
    const { service, store } = setupAuto()
    store.saveCleanupRule(cleanup({ auto: false }))
    await service.runAutomatic()
    expect(store.activity).toEqual([])
  })

  it('will not trash more than the automatic limit, and asks for a review instead', async () => {
    const { service, provider, store } = setupAuto(2_500)
    store.saveCleanupRule(cleanup({ filters: { from: '@' } })) // narrow enough to save, but matches everything
    const status = await service.runAutomatic()
    expect(status.needsReview).toEqual([{ id: 'a', name: 'Auto ShopMart', count: 2_500, kind: 'cleanup' }])
    expect(store.activity).toEqual([])
    expect((await provider.listInboxIds(false)).length).toBe(2_500)

    store.saveCleanupRule(cleanup({ filters: { from: '@' }, actions: [{ type: 'archive' }] })) // archiving isn't limited
    expect((await service.runAutomatic()).needsReview).toEqual([])
    expect((await provider.listInboxIds(false)).length).toBe(0)
  })

  it('reports a rule it cannot run and carries on with the others', async () => {
    const { service, store } = setupAuto()
    store.saveCleanupRule(cleanup({ id: 'bad', name: 'Broken', filters: {}, auto: true }))
    store.saveCleanupRule(cleanup())
    const status = await service.runAutomatic()
    expect(status.errors).toEqual([{ name: 'Broken', message: expect.stringContaining('filter'), kind: 'cleanup' }])
    expect(store.activity).toHaveLength(1)
  })

  it('applies automatic header-based rules to scanned mail, several in one run', async () => {
    const { service, store, provider } = setupAuto()
    await service.overview() // the scan the rules work on
    store.saveRule({ id: 'r1', name: 'Archive daily digest', enabled: true, match: 'all', auto: true,
      conditions: [{ field: 'senderEmail', op: 'equals', value: 'news@dailydigest.example' }], actions: [{ type: 'archive' }] })
    store.saveRule({ id: 'r2', name: 'Read LinkedIn', enabled: true, match: 'all', auto: true,
      conditions: [{ field: 'senderDomain', op: 'equals', value: 'linkedin.com' }], actions: [{ type: 'markRead' }] })
    store.saveRule({ id: 'r3', name: 'Not automatic', enabled: true, match: 'all',
      conditions: [{ field: 'senderEmail', op: 'equals', value: 'mom@family.example' }], actions: [{ type: 'archive' }] })

    const status = await service.runAutomatic()
    expect(status.errors).toEqual([])
    expect(store.activity.map((a) => a.ruleName).sort()).toEqual(['Archive daily digest (automatic)', 'Read LinkedIn (automatic)'])
    expect((await provider.searchInbox!('in:inbox from:(news@dailydigest.example)')).length).toBe(0)
    expect((await provider.searchInbox!('in:inbox from:(mom@family.example)')).length).toBeGreaterThan(0)
  })

  it('never runs two automatic runs at once', async () => {
    const { service, store } = setupAuto()
    store.saveCleanupRule(cleanup())
    const [a, b] = [service.runAutomatic(), service.runAutomatic()]
    expect(a).toBe(b)
    await a
    expect(store.activity).toHaveLength(1)
  })
})

describe('impact', () => {
  const setupImpact = () => {
    const provider = new CountingProvider(300)
    const store = new FakeStore()
    return { provider, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }

  it('totals what was moved, how much space that was, and which rule did it', async () => {
    const { service, store } = setupImpact()
    await service.overview() // the scan is what tells the app each message's size
    store.saveCleanupRule({ id: 'shop', name: 'Shop', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }] })
    store.saveCleanupRule({ id: 'digest', name: 'Digest', filters: { from: 'news@dailydigest.example' }, actions: [{ type: 'archive' }] })
    const shop = await service.cleanupCount('shop')
    const digest = await service.cleanupCount('digest')
    await service.applyCleanup('shop', shop.count)
    await service.applyCleanup('digest', digest.count)

    const { month, all, byRule } = service.impact()
    expect(month).toMatchObject({ messages: shop.count + digest.count, trashed: shop.count, archived: digest.count, runs: 2, automatic: 0 })
    expect(month.bytesTrashed).toBeGreaterThan(0)
    expect(all.messages).toBe(month.messages)
    expect(byRule).toEqual({ shop: { messages: shop.count }, digest: { messages: digest.count } })
  })

  it('stops counting a change once it is undone', async () => {
    const { service, store } = setupImpact()
    store.saveCleanupRule({ id: 'shop', name: 'Shop', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }] })
    const { count } = await service.cleanupCount('shop')
    const entry = await service.applyCleanup('shop', count)
    expect(service.impact().all.messages).toBe(count)
    await service.undo(entry.id as number)
    expect(service.impact().all).toMatchObject({ messages: 0, bytesTrashed: 0, runs: 0 })
    expect(service.impact().byRule).toEqual({})
  })

  it('counts automatic runs and one-sender clean-ups, and keeps one-sender clean-ups out of the per-rule list', async () => {
    const { service, store } = setupImpact()
    store.saveCleanupRule({ id: 'auto', name: 'Auto', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'archive' }], auto: true })
    await service.runAutomatic()
    const sender = await service.senderSummary('news@dailydigest.example')
    await service.cleanSender('news@dailydigest.example', 'markRead', sender.counts.markRead)

    const { all, byRule } = service.impact()
    expect(all.automatic).toBeGreaterThan(0)
    expect(all.runs).toBe(2)
    expect(Object.keys(byRule)).toEqual(['auto'])
  })

  it('counts unsubscribes this month', async () => {
    const { service, store } = setupImpact()
    await service.recordUnsubscribe('News@DailyDigest.example', 'oneClick')
    expect(store.unsubscribes).toMatchObject([{ email: 'news@dailydigest.example', status: 'waiting', method: 'oneClick' }])
    expect(service.impact().month.unsubscribes).toBe(1)
    expect(service.impact().all.unsubscribes).toBe(1)
  })
})

describe('checking that an unsubscribe worked', () => {
  const DAY = 86_400_000
  const setupUnsub = () => {
    const provider = new CountingProvider(300)
    const store = new FakeStore()
    return { provider, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }
  const record = (email: string, daysAgo: number) =>
    ({ email, name: email, at: new Date(Date.now() - daysAgo * DAY).toISOString(), method: 'oneClick' as const, status: 'waiting' as const })

  it('waits a week before judging', async () => {
    const { service, store } = setupUnsub()
    store.recordUnsubscribe(record('news@dailydigest.example', 3))
    expect(await service.checkUnsubscribes()).toBe(0)
    expect(store.unsubscribes[0].status).toBe('waiting')
  })

  it('marks it worked when nothing arrived since', async () => {
    const { service, store } = setupUnsub()
    store.recordUnsubscribe(record('news@dailydigest.example', 0))
    expect(await service.checkUnsubscribes(Date.now() + 8 * DAY)).toBe(1)
    expect(store.unsubscribes[0]).toMatchObject({ status: 'worked' })
    expect(store.cleanup).toEqual([])
    expect(await service.checkUnsubscribes(Date.now() + 9 * DAY)).toBe(0) // settled, so not checked again
  })

  it('archives the sender automatically when mail kept arriving', async () => {
    const { service, store, provider } = setupUnsub()
    store.recordUnsubscribe(record('news@dailydigest.example', 10)) // mail from them in the last 3 days
    expect((await provider.searchInbox!('in:inbox from:(news@dailydigest.example)')).length).toBeGreaterThan(0)

    await service.runAutomatic() // checks first, then runs the cleanup it just made
    expect(store.unsubscribes[0]).toMatchObject({ status: 'still_sending', ruleId: 'unsub-news@dailydigest.example' })
    expect(store.cleanup).toEqual([expect.objectContaining({ id: 'unsub-news@dailydigest.example', auto: true, actions: [{ type: 'archive' }] })])
    expect((await provider.searchInbox!('in:inbox from:(news@dailydigest.example)')).length).toBe(0)
    expect(store.activity[0].ruleName).toContain('still sending after unsubscribe')
  })

  it('does not make a second cleanup for a sender already handled', async () => {
    const { service, store } = setupUnsub()
    store.recordUnsubscribe(record('news@dailydigest.example', 10))
    await service.checkUnsubscribes()
    await service.checkUnsubscribes()
    expect(store.cleanup).toHaveLength(1)
  })
})

describe('free up space guide', () => {
  const MB = 1024 * 1024
  const big = (id: string, mb: number): MailMessage => ({
    id, accountId: 'me@x.com', from: { name: 'Photos Inc', email: 'p@x.example' }, subject: `Holiday ${id}`, date: '2026-01-01T00:00:00Z',
    labels: ['INBOX'], isUnread: false, sizeBytes: mb * MB,
  })

  /** A mailbox where the app is told which messages are huge, large and medium, whatever the query says. */
  class SpaceProvider extends CountingProvider {
    huge = [big('h1', 30), big('h2', 50)]
    large = Array.from({ length: 12 }, (_, i) => big(`l${i}`, 12 + i)) // 12 messages: more than the sample, so the size is an estimate
    quota: { usedBytes: number; limitBytes?: number } | 'fail' = { usedBytes: 14 * 1024 * MB, limitBytes: 15 * 1024 * MB }
    override async searchInbox(query: string) {
      if (query.includes('-larger:25M')) return this.large.map((m) => m.id)
      if (query.includes('larger:25M')) return this.huge.map((m) => m.id)
      if (query.includes('larger:')) return []
      return super.searchInbox(query)
    }
    override async getMessages(ids: string[]) {
      const known = [...this.huge, ...this.large]
      return ids.flatMap((id) => known.filter((m) => m.id === id))
    }
    async getStorageQuota() {
      if (this.quota === 'fail') throw new Error('no permission')
      return { ...this.quota, driveBytes: 0, driveTrashBytes: 0 }
    }
  }
  const setupSpace = () => {
    const provider = new SpaceProvider(0)
    return { provider, store: new FakeStore(), service: new OrganizerService(() => provider, new FakeStore() as unknown as Store) }
  }

  it('lists what is worth clearing, biggest first, with sizes', async () => {
    const { service } = setupSpace()
    const guide = await service.spaceGuide()
    expect(guide.quota).toEqual({ usedBytes: 14 * 1024 * MB, limitBytes: 15 * 1024 * MB })
    expect(guide.candidates.map((c) => c.id)).toEqual(['attachments-10', 'attachments-25']) // by total size, so 12 medium messages outweigh 2 huge ones; empty ones are left out

    const [large, huge] = guide.candidates
    expect(huge).toMatchObject({ count: 2, bytes: 80 * MB, bytesAreEstimate: false })
    expect(huge.samples.map((s) => s.sizeBytes)).toEqual([50 * MB, 30 * MB]) // examples, biggest first
    expect(large.count).toBe(12)
    expect(large.bytesAreEstimate).toBe(true)
    expect(large.bytes).toBeGreaterThan(12 * 12 * MB) // about the average of a sample times 12
    expect(large.bytes).toBeLessThan(12 * 23 * MB)
  })

  it('still lists candidates when Gmail cannot report storage', async () => {
    const { service, provider } = setupSpace()
    provider.quota = 'fail'
    const guide = await service.spaceGuide()
    expect(guide.quota).toBeNull()
    expect(guide.candidates).toHaveLength(2)
  })

  it('moves a candidate to Trash with the app’s own search, and records it', async () => {
    const { provider, store } = setupSpace()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    const entry = await service.cleanSpace('attachments-25', 2)
    expect(entry).toMatchObject({ messageCount: 2, move: 'trash' })
    expect(store.activity[0]).toMatchObject({ ruleName: 'Free up space: Attachments over 25 MB', move: 'trash' })
    expect(store.activity[0].ruleId).toBeUndefined() // not a saved rule
    await expect(service.cleanSpace('anything-else', 1)).rejects.toThrow('isn’t something the guide suggested')
  })

  it('refuses when far more matches than were shown have appeared', async () => {
    const { provider, store } = setupSpace()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    provider.huge = Array.from({ length: 80 }, (_, i) => big(`h${i}`, 30))
    await expect(service.cleanSpace('attachments-25', 2)).rejects.toThrow(/More mail matches now/)
  })

  it('remembers the answer until mail changes', async () => {
    const { service, provider } = setupSpace()
    const first = await service.spaceGuide()
    provider.huge = []
    expect(await service.spaceGuide()).toBe(first) // not searched again
    await service.cleanSpace('attachments-10', 12)
    expect((await service.spaceGuide()).candidates.map((c) => c.id)).toEqual(['attachments-10']) // a clean-up makes it look again
  })
})

describe('suggestions', () => {
  const from = (email: string, total: number, read: number, unsubscribe: boolean): MailMessage[] =>
    Array.from({ length: total }, (_, i) => ({
      id: `${email}-${i}`, accountId: 'me@x.com', from: { name: email.split('@')[0], email }, subject: 's', date: new Date(Date.now() - i * 3_600_000).toISOString(),
      labels: ['INBOX'], isUnread: i >= read, sizeBytes: 1000, ...(unsubscribe && { listUnsubscribe: '<https://x.example/u>' }),
    }))

  class StubProvider extends CountingProvider {
    private mail: MailMessage[]
    constructor(mail: MailMessage[]) { super(0); this.mail = mail }
    override async listInboxIds(unreadOnly: boolean) { return this.mail.filter((m) => !unreadOnly || m.isUnread).map((m) => m.id) }
    override async getMessages(ids: string[]) { return this.mail.filter((m) => ids.includes(m.id)) }
  }

  const setupSuggest = () => {
    const provider = new StubProvider([
      ...from('never@a.example', 20, 0, true), // never opened, offers unsubscribe
      ...from('rare@c.example', 12, 2, true), // opened 2 of 12: 17%, under the newsletter threshold
      ...from('some@b.example', 10, 1, false), // opened 10% of something with no unsubscribe: not rare enough
      ...from('few@d.example', 5, 0, true), // never opened, but only 5 messages
      ...from('read@e.example', 9, 9, true), // all read
    ])
    const store = new FakeStore()
    return { provider, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }

  it('suggests only senders with plenty of mail that is hardly ever opened, with the reason', async () => {
    const { service } = setupSuggest()
    const result = await service.suggestions()
    expect(result.items.map((s) => s.email)).toEqual(['never@a.example', 'rare@c.example'])
    expect(result.items[0]).toMatchObject({ id: 'sender:never@a.example', count: 20, hasUnsubscribe: true, why: 'You haven’t opened any of their 20 emails. They offer an unsubscribe link.' })
    expect(result.items[1].why).toBe('You’ve opened only 2 of their 12 emails. They offer an unsubscribe link.')
    expect(result).toMatchObject({ scanned: 56, inboxTotal: 56, complete: true })
  })

  it('does not suggest a sender that was dismissed or already has a cleanup', async () => {
    const { service, store } = setupSuggest()
    service.dismissSuggestion('sender:rare@c.example')
    store.saveCleanupRule({ id: 'mine', name: 'Mine', filters: { from: 'never@a.example' }, actions: [{ type: 'archive' }] })
    expect((await service.suggestions()).items).toEqual([])
  })

  it('archives a sender from now on: an automatic cleanup that starts right away', async () => {
    const provider = new CountingProvider(300)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    service.autoArchiveSender('News@DailyDigest.example')
    service.autoArchiveSender('news@dailydigest.example') // twice is still one rule
    expect(store.cleanup).toEqual([{ id: 'auto-archive-news@dailydigest.example', name: 'Archive mail from news@dailydigest.example', filters: { from: 'news@dailydigest.example' }, actions: [{ type: 'archive' }], auto: true }])
    await service.runAutomatic()
    expect((await provider.searchInbox!('in:inbox from:(news@dailydigest.example)')).length).toBe(0)
    expect(store.activity[0]).toMatchObject({ move: 'archive', automatic: true })
  })

  it('refuses something that is not an address', async () => {
    const { service } = setupSuggest()
    expect(() => service.autoArchiveSender('a@b.com) OR (in:inbox')).toThrow(/valid sender/)
  })
})

describe('sharing rules', () => {
  const setupShare = () => {
    const store = new FakeStore()
    return { store, service: new OrganizerService(() => new CountingProvider(10), store as unknown as Store) }
  }
  const cleanup = (over: Partial<CleanupRule> = {}): CleanupRule => ({ id: 'c1', name: 'Shop', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }], ...over })

  it('exports every rule and cleanup', () => {
    const { service, store } = setupShare()
    store.saveCleanupRule(cleanup())
    store.saveRule({ id: 'r1', name: 'Receipts', enabled: true, match: 'all', conditions: [{ field: 'category', op: 'equals', value: 'receipt' }], actions: [{ type: 'addLabel', label: 'Receipts' }] })
    const out = service.exportRules()
    expect(out).toMatchObject({ app: 'email-organizer', version: 1 })
    expect(out.cleanupRules.map((r) => r.name)).toEqual(['Shop'])
    expect(out.rules.map((r) => r.name)).toEqual(['Archive old promotions', 'Label receipts', 'Receipts']) // the two default rules, then this one
  })

  it('imports them on another computer with new ids, and a round trip changes nothing', () => {
    const { service: a, store: storeA } = setupShare()
    storeA.saveCleanupRule(cleanup())
    const file = JSON.parse(JSON.stringify(a.exportRules()))
    const { service: b, store: storeB } = setupShare()
    expect(b.importRules(file)).toEqual({ added: 3, skipped: [] }) // the cleanup and A's two default rules
    expect(storeB.cleanup).toHaveLength(1)
    expect(storeB.cleanup[0]).toMatchObject({ name: 'Shop', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' }] })
    expect(storeB.cleanup[0].id).not.toBe('c1')
  })

  it('never lets an imported rule run by itself or carry someone else’s consent', () => {
    const { service, store } = setupShare()
    service.importRules({
      app: 'email-organizer', version: 1, cleanupRules: [cleanup({ auto: true, runOnce: true, allowBroad: true }), cleanup({ name: 'Auto', auto: true })],
      rules: [{ id: 'r', name: 'R', enabled: true, auto: true, match: 'all', conditions: [{ field: 'senderDomain', op: 'equals', value: 'a.com' }], actions: [{ type: 'archive' }] }],
    })
    expect(store.cleanup.some((r) => r.auto || r.runOnce || r.allowBroad)).toBe(false)
    expect(store.rules.some((r) => r.auto)).toBe(false)
  })

  it('skips rules that fail the checks and says why, keeping the good ones', () => {
    const { service, store } = setupShare()
    const result = service.importRules({
      app: 'email-organizer', version: 1,
      cleanupRules: [
        cleanup({ name: 'Good' }),
        cleanup({ name: 'No filter', filters: {} }),
        cleanup({ name: 'Everyday trash', filters: { olderThan: { value: 1, unit: 'y' } }, allowBroad: true }), // consent is stripped, so it's refused
        { name: 'Garbage' } as never,
      ],
      rules: [{ name: 'Bad rule' } as never],
    })
    expect(result.added).toBe(1)
    expect(result.skipped.map((s) => s.name)).toEqual(['No filter', 'Everyday trash', 'Garbage', 'Bad rule'])
    expect(result.skipped.every((s) => s.reason.length > 0)).toBe(true)
    expect(store.cleanup.map((r) => r.name)).toEqual(['Good'])
  })

  it('refuses a file that isn’t a rules file, and reads only so many rules', () => {
    const { service, store } = setupShare()
    for (const bad of [null, 'text', 5, {}, { app: 'something-else', cleanupRules: [] }, { app: 'email-organizer', cleanupRules: 'x' }]) {
      expect(() => service.importRules(bad)).toThrow('isn’t a rules file')
    }
    const many = Array.from({ length: 500 }, (_, i) => cleanup({ name: `r${i}` }))
    expect(service.importRules({ app: 'email-organizer', version: 1, cleanupRules: many, rules: [] }).added).toBe(200)
    expect(store.cleanup).toHaveLength(200)
  })
})

describe('duplicate messages', () => {
  const copy = (id: string, over: Partial<MailMessage> = {}): MailMessage => ({
    id, accountId: 'me@x.com', from: { name: 'Shop', email: 'shop@x.example' }, subject: 'Your order', date: '2026-03-01T10:15:20Z',
    labels: ['INBOX'], isUnread: true, sizeBytes: 4000, ...over,
  })
  class StubProvider extends CountingProvider {
    mail: MailMessage[]
    constructor(mail: MailMessage[]) { super(0); this.mail = mail }
    override async listInboxIds(unreadOnly: boolean) { return this.mail.filter((m) => m.labels.includes('INBOX') && (!unreadOnly || m.isUnread)).map((m) => m.id) }
    override async getMessages(ids: string[]) { return this.mail.filter((m) => ids.includes(m.id)) }
    override async applyActions(ids: string[], actions: Parameters<DemoProvider['applyActions']>[1]) { this.mail = this.mail.map((m) => (ids.includes(m.id) ? applyActionsToMessage(m, actions) : m)) }
  }
  const setupDup = () => {
    const provider = new StubProvider([copy('a', { date: '2026-03-01T10:15:05Z' }), copy('b', { date: '2026-03-01T10:15:40Z' }), copy('c'), copy('solo', { subject: 'Different' })])
    const store = new FakeStore()
    return { provider, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }

  it('reports the extra copies, with sizes and examples', async () => {
    const { service } = setupDup()
    expect(await service.duplicates()).toEqual({
      count: 2, bytes: 8000, groups: 1, scanned: 4, complete: true,
      examples: [{ from: 'Shop', subject: 'Your order', copies: 3 }],
    })
  })

  it('trashes the extras, keeps the newest, and can be undone', async () => {
    const { service, provider, store } = setupDup()
    await service.overview()
    const entry = await service.trashDuplicates(2)
    expect(entry).toMatchObject({ messageCount: 2, move: 'trash', bytes: 8000 })
    expect(store.activity[0].ruleName).toBe('Remove duplicate messages')
    expect(provider.mail.filter((m) => m.labels.includes('INBOX')).map((m) => m.id).sort()).toEqual(['b', 'solo'])
    expect((await service.duplicates()).count).toBe(0)

    await service.undo(entry.id as number)
    expect(provider.mail.filter((m) => m.labels.includes('INBOX'))).toHaveLength(4)
  })

  it('refuses when many more duplicates are found than were shown', async () => {
    const { service, provider } = setupDup()
    provider.mail = [...provider.mail, ...Array.from({ length: 60 }, (_, i) => copy(`n${i}`, { subject: 'Newsletter' }))]
    await expect(service.trashDuplicates(2)).rejects.toThrow(/More duplicates are listed now/)
  })
})

describe('describing an automatic run', () => {
  const entry = (messageCount: number, move: 'trash' | 'archive' | null) => ({ id: 1, at: '', ruleName: 'r', messageCount, undone: false, move })

  it('says what was done in plain words', () => {
    expect(describeRun([])).toBe('')
    expect(describeRun([entry(212, 'archive')])).toBe('Archived 212 messages')
    expect(describeRun([entry(1, 'archive')])).toBe('Archived 1 message')
    expect(describeRun([entry(30, 'trash'), entry(2, 'trash')])).toBe('Moved 32 to Trash')
    expect(describeRun([entry(212, 'archive'), entry(30, 'trash')])).toBe('Archived 212 messages and moved 30 to Trash')
    expect(describeRun([entry(5, null), entry(10, 'archive'), entry(3, 'trash')])).toBe('Archived 10 messages, moved 3 to Trash and updated 5 messages')
  })

  it('reports it on the automation status, empty when nothing changed', async () => {
    const provider = new CountingProvider(300)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    store.saveCleanupRule({ id: 'a', name: 'A', filters: { from: 'news@dailydigest.example' }, actions: [{ type: 'archive' }], auto: true })
    const first = await service.runAutomatic()
    expect(first.lastChanged).toBeGreaterThan(0)
    expect(first.lastSummary).toBe(`Archived ${first.lastChanged} messages`)
    const second = await service.runAutomatic()
    expect(second).toMatchObject({ lastChanged: 0, lastSummary: '' })
  })
})

describe('checking for new mail on its own', () => {
  /** 60 messages, one of them (demo-0) archived at first so it can "arrive" later. */
  const setupPoll = async () => {
    const provider = new HistoryProvider(60)
    const store = new FakeStore()
    await provider.elsewhere('demo-0', { inbox: false })
    const events: ScanProgress[] = []
    const service = new OrganizerService(() => provider, store as unknown as Store, (p) => events.push(p))
    return { provider, store, service, events }
  }

  it('picks up mail that arrived, downloading only that', async () => {
    const { provider, service } = await setupPoll()
    expect((await service.overview()).total).toBe(59)

    await provider.elsewhere('demo-0', { inbox: true })
    provider.downloaded = []
    await service.checkNewMail()
    expect(provider.downloaded).toEqual(['demo-0'])
    expect(await service.overview()).toMatchObject({ total: 60, complete: true, scanning: false })
    expect(provider.downloaded).toEqual(['demo-0']) // looking at the screen needed nothing more
  })

  it('does nothing when nothing arrived, and downloads nothing', async () => {
    const { provider, service } = await setupPoll()
    await service.overview()
    provider.downloaded = []
    provider.listCalls = 0
    await service.checkNewMail()
    expect(provider.downloaded).toEqual([])
    expect(provider.listCalls).toBe(0) // history said nothing changed, so the inbox wasn't listed again
    expect((await service.overview()).total).toBe(59)
  })

  it('never starts the first, slow scan of a mailbox', async () => {
    const { provider, service, events } = await setupPoll()
    await service.checkNewMail()
    expect(events).toEqual([])
    expect(provider.downloaded).toEqual([])
    expect(provider.listCalls).toBe(0)
  })

  it('carries on from a saved checkpoint after a restart', async () => {
    const { provider, store } = await setupPoll()
    await new OrganizerService(() => provider, store as unknown as Store).overview()
    await provider.elsewhere('demo-0', { inbox: true })
    provider.downloaded = []

    const restarted = new OrganizerService(() => provider, store as unknown as Store) // a new session, nothing in memory
    await restarted.checkNewMail()
    expect(provider.downloaded).toEqual(['demo-0'])
    expect((await restarted.overview()).total).toBe(60)
  })

  it('stays quiet when a check fails, and the next screen load still works', async () => {
    const { provider, service } = await setupPoll()
    await service.overview()
    await provider.elsewhere('demo-0', { inbox: true })
    const listChanges = provider.listChanges.bind(provider)
    provider.listChanges = async () => { throw new Error('offline') }
    await expect(service.checkNewMail()).resolves.toBeUndefined() // no error reaches the app

    provider.listChanges = listChanges
    expect((await service.overview()).total).toBe(60) // the failure wasn't left behind to be thrown at the user
  })

  it('refreshes the inbox counts only when mail arrived', async () => {
    const { provider, service } = await setupPoll()
    await service.overview()
    const first = service.inboxCounts()
    expect((await first)!.total).toBe(59)

    await service.checkNewMail()
    expect(service.inboxCounts()).toBe(first) // nothing arrived: the answer is kept

    await provider.elsewhere('demo-0', { inbox: true })
    await service.checkNewMail()
    const second = service.inboxCounts()
    expect(second).not.toBe(first)
    expect((await second)!.total).toBe(60)
  })

  it('does not run two checks at once, or interrupt a scan in progress', async () => {
    const { provider, service } = await setupPoll()
    await service.overview()
    await provider.elsewhere('demo-0', { inbox: true })
    provider.downloaded = []
    await Promise.all([service.checkNewMail(), service.checkNewMail()])
    expect(provider.downloaded).toEqual(['demo-0']) // once, not twice
  })

  it('leaves the built-in demo mailbox alone', async () => {
    const events: ScanProgress[] = []
    await new OrganizerService(() => new DemoProvider(10), new FakeStore() as unknown as Store, (p) => events.push(p)).checkNewMail()
    expect(events).toEqual([])
  })
})

describe('running automatic rules when mail is scanned', () => {
  /** A scanned mailbox in which demo-0 is archived, so it can arrive later; its sender is who the rules are about. */
  const setupArrival = async () => {
    const provider = new HistoryProvider(60)
    const store = new FakeStore()
    await provider.elsewhere('demo-0', { inbox: false })
    const service = new OrganizerService(() => provider, store as unknown as Store)
    const sender = (await provider.getMessages(['demo-0']))[0].from.email
    await service.overview() // the first scan; there are no automatic rules yet
    await service.runAutomatic()
    const inbox = () => provider.searchInbox(`in:inbox from:(${sender})`)
    return { provider, store, service, sender, inbox }
  }
  const saved = (sender: string) => ({ id: 'auto', name: 'Auto', filters: { from: sender }, actions: [{ type: 'archive' as const }], auto: true })

  it('applies a cleanup as soon as a check finds new mail, without waiting for the half hour', async () => {
    const { provider, store, service, sender, inbox } = await setupArrival()
    store.saveCleanupRule(saved(sender)) // saved straight to the store, so saving it doesn't run it
    expect((await inbox()).length).toBeGreaterThan(0)
    expect(store.activity).toEqual([])

    await provider.elsewhere('demo-0', { inbox: true })
    await service.checkNewMail()
    await until(async () => store.activity.length > 0)
    expect((await inbox()).length).toBe(0)
    expect(store.activity[0]).toMatchObject({ ruleName: 'Auto (automatic)', automatic: true })
  })

  it('does not run anything when a check finds nothing new', async () => {
    const { store, service, sender, inbox } = await setupArrival()
    for (let i = 0; i < 5; i++) { await service.checkNewMail(); await new Promise((r) => setTimeout(r, 30)) } // the first scan armed two follow-up looks; let them pass
    store.saveCleanupRule(saved(sender))
    await service.checkNewMail()
    await new Promise((r) => setTimeout(r, 100))
    expect(store.activity).toEqual([])
    expect((await inbox()).length).toBeGreaterThan(0)
  })

  it('also runs when a scan the user started finds new mail', async () => {
    const { provider, store, service, sender, inbox } = await setupArrival()
    store.saveCleanupRule(saved(sender))
    await provider.elsewhere('demo-0', { inbox: true })
    await service.overview(true) // a refresh from the screen, not the background check
    await until(async () => store.activity.length > 0)
    expect((await inbox()).length).toBe(0)
  })

  it('applies automatic rules that work on scanned mail to the newly scanned messages', async () => {
    const { provider, store, service, sender } = await setupArrival()
    store.saveRule({ id: 'r', name: 'Archive sender', enabled: true, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: sender }], actions: [{ type: 'archive' }] })
    await provider.elsewhere('demo-0', { inbox: true })
    await service.checkNewMail()
    await until(async () => store.activity.some((a) => a.ruleName === 'Archive sender (automatic)'))
    expect((await provider.searchInbox(`in:inbox from:(${sender})`)).length).toBe(0)
  })

  it('does not run when the scan was stopped', async () => {
    const provider = new HistoryProvider(450)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    store.saveCleanupRule({ id: 'auto', name: 'Auto', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'archive' }], auto: true })
    provider.onFetch = () => service.cancelScan() // stop after the first chunk
    await service.overview()
    await new Promise((r) => setTimeout(r, 100))
    expect(store.activity).toEqual([])
  })
})


/** A small stateful Gmail: it answers the calls the app makes (listing, search, metadata, history, batchModify) from real state. */
class FakeGmail {
  version = 100
  nextId = 1
  messages: { id: string; labelIds: string[]; from: string; subject: string; internalDate: string; size: number }[] = []
  history: { v: number; record: Record<string, unknown> }[] = []
  modified: { ids: string[]; add: string[]; remove: string[] }[] = []
  searches: string[] = []
  /** a search that hides mail added in the last `lagMs`, like a search index that hasn't caught up yet */
  indexLag = new Set<string>()
  labels = [{ id: 'INBOX', name: 'INBOX' }, { id: 'UNREAD', name: 'UNREAD' }, { id: 'TRASH', name: 'TRASH' }]

  add(from: string, subject = 'Hello', labelIds = ['INBOX', 'UNREAD']) {
    const id = `m${this.nextId++}`
    this.messages.push({ id, labelIds, from, subject, internalDate: String(Date.now() - this.nextId * 1000), size: 2000 })
    return id
  }
  /** mail arriving now: it also goes in the history log */
  arrive(from: string, subject = 'Site is down') {
    const id = this.add(from, subject)
    this.version++
    this.history.push({ v: this.version, record: { messagesAdded: [{ message: { id, labelIds: ['INBOX', 'UNREAD'] } }] } })
    return id
  }
  private ids(filter: (m: FakeGmail['messages'][number]) => boolean) { return this.messages.filter(filter).map((m) => ({ id: m.id })) }

  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/profile') return json({ emailAddress: 'me@x.com', historyId: String(this.version) })
    if (path === '/labels' && init?.method === 'POST') {
      const name = JSON.parse(String(init.body)).name as string
      const label = { id: `Label_${this.labels.length + 1}`, name }
      this.labels.push(label)
      return json(label)
    }
    if (path === '/labels') return json({ labels: this.labels })
    if (path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'))
      return json({ history: this.history.filter((h) => h.v > start).map((h) => h.record), historyId: String(this.version) })
    }
    if (path === '/messages/batchModify' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { ids: string[]; addLabelIds?: string[]; removeLabelIds?: string[] }
      this.modified.push({ ids: body.ids, add: body.addLabelIds ?? [], remove: body.removeLabelIds ?? [] })
      this.version++
      for (const m of this.messages.filter((x) => body.ids.includes(x.id))) {
        m.labelIds = [...m.labelIds.filter((l) => !(body.removeLabelIds ?? []).includes(l)), ...(body.addLabelIds ?? []).filter((l) => !m.labelIds.includes(l))]
        for (const l of body.removeLabelIds ?? []) this.history.push({ v: this.version, record: { labelsRemoved: [{ message: { id: m.id }, labelIds: [l] }] } })
      }
      return new Response(null, { status: 204 })
    }
    if (path === '/messages') {
      const labels = url.searchParams.getAll('labelIds')
      const q = url.searchParams.get('q')
      if (q) {
        this.searches.push(q)
        const from = q.match(/from:\(([^)]*)\)/)?.[1]?.toLowerCase()
        const inInbox = q.includes('in:inbox')
        const notStarred = q.includes('-is:starred')
        const unreadOnly = / is:unread|^is:unread/.test(` ${q}`) && !q.includes('-is:unread')
        return json({ messages: this.ids((m) => !this.indexLag.has(m.id) && (!inInbox || m.labelIds.includes('INBOX')) && !(notStarred && m.labelIds.includes('STARRED')) && (!unreadOnly || m.labelIds.includes('UNREAD')) && (!from || m.from.toLowerCase().includes(from))) })
      }
      return json({ messages: this.ids((m) => labels.every((l) => m.labelIds.includes(l))) })
    }
    const one = path.match(/^\/messages\/(.+)$/)
    if (one) {
      const m = this.messages.find((x) => x.id === one[1])
      if (!m) return new Response('{"error":{"message":"gone"}}', { status: 404 })
      return json({ id: m.id, labelIds: m.labelIds, sizeEstimate: m.size, internalDate: m.internalDate, payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] } })
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${path}`)
  }) as typeof fetch
  provider() { return new GmailProvider({ accountId: 'me@x.com', getAccessToken: async () => 'tok', fetch: this.fetch, sleep: async () => {} }) }
}

describe('new mail through a Gmail-shaped mailbox', () => {
  const SITE = 'Site Monitors <alerts@sitemonitors.example>'
  const setupGmail = async () => {
    const gmail = new FakeGmail()
    for (let i = 0; i < 6; i++) gmail.add(`Friend ${i} <friend${i}@mail.example>`, `Hi ${i}`)
    gmail.add(SITE, 'Site is down (old)')
    const store = new FakeStore()
    const provider = gmail.provider()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    await service.overview() // the first scan
    return { gmail, store, service }
  }

  it('archives a site-monitors email when it arrives, for an automatic cleanup', async () => {
    const { gmail, store, service } = await setupGmail()
    store.saveCleanupRule({ id: 'auto', name: 'Site monitors', filters: { from: 'alerts@sitemonitors.example' }, actions: [{ type: 'archive' }], auto: true })
    const id = gmail.arrive(SITE)

    await service.checkNewMail()
    await until(async () => gmail.modified.length > 0)
    expect(gmail.modified.at(-1)!.ids).toContain(id)
    expect(gmail.modified.at(-1)!.remove).toContain('INBOX')
  })

  it('does the same when the rule is about the sender’s name, as typed into the form', async () => {
    const { gmail, store, service } = await setupGmail()
    store.saveCleanupRule({ id: 'auto', name: 'Site monitors', filters: { from: 'site monitors' }, actions: [{ type: 'archive' }], auto: true })
    const id = gmail.arrive(SITE)
    await service.checkNewMail()
    await until(async () => gmail.modified.length > 0)
    expect(gmail.modified.at(-1)!.ids).toContain(id)
  })

  it('applies an automatic rule that works on scanned mail', async () => {
    const { gmail, store, service } = await setupGmail()
    store.saveRule({ id: 'r', name: 'Site monitors', enabled: true, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: 'alerts@sitemonitors.example' }], actions: [{ type: 'archive' }] })
    const id = gmail.arrive(SITE)
    await service.checkNewMail()
    await until(async () => gmail.modified.length > 0)
    expect(gmail.modified.at(-1)!.ids).toContain(id)
  })
})

describe('automatic rules that must not miss new mail', () => {
  const SITE = 'Site Monitors <alerts@sitemonitors.example>'
  const setupMiss = async () => {
    const gmail = new FakeGmail()
    for (let i = 0; i < 6; i++) gmail.add(`Friend ${i} <friend${i}@mail.example>`, `Hi ${i}`)
    const store = new FakeStore()
    const provider = gmail.provider() // one object, as in the app, so the service recognises its own cached scan
    const service = new OrganizerService(() => provider, store as unknown as Store)
    await service.overview()
    store.saveCleanupRule({ id: 'auto', name: 'Site monitors', filters: { from: 'alerts@sitemonitors.example' }, actions: [{ type: 'archive' }], auto: true })
    return { gmail, store, service }
  }

  it('catches an email that Gmail’s search can’t find yet, on the next check', async () => {
    const { gmail, service } = await setupMiss()
    const id = gmail.arrive(SITE)
    gmail.indexLag.add(id) // history knows about it; search doesn't yet

    await service.checkNewMail() // finds the new mail, runs the rules, and the search comes up empty
    await new Promise((r) => setTimeout(r, 50))
    expect(gmail.modified).toEqual([])

    gmail.indexLag.clear() // the search index catches up
    await service.checkNewMail() // nothing new this time, but the rules are looked at once more
    await until(async () => gmail.modified.length > 0)
    expect(gmail.modified[0].ids).toContain(id)
  })

  it('stops looking again after a couple of checks, so quiet minutes cost nothing', async () => {
    const { gmail, service } = await setupMiss()
    gmail.arrive(SITE)
    await service.checkNewMail()
    await until(async () => gmail.modified.length > 0)
    for (let i = 0; i < 2; i++) { await service.checkNewMail(); await new Promise((r) => setTimeout(r, 30)) } // the two follow-up looks
    const before = gmail.searches.length
    for (let i = 0; i < 3; i++) await service.checkNewMail()
    await new Promise((r) => setTimeout(r, 50))
    expect(gmail.searches.length).toBe(before) // no more rule searches while nothing arrives
  })

  it('does not lose a trigger that arrives while a run is already in progress', async () => {
    const provider = new CountingProvider(30)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    store.saveCleanupRule({ id: 'auto', name: 'Nobody', filters: { from: 'nobody@nowhere.example' }, actions: [{ type: 'archive' }], auto: true })
    const searches: string[] = []
    const hold = gate()
    let first = true
    provider.searchInbox = async (q: string) => { searches.push(q); if (first) { first = false; await hold.promise } return [] }

    const running = service.runAutomatic() // in progress, held inside its first search
    await until(async () => searches.length === 1)
    expect(service.runAutomatic()).toBe(running) // new mail arrives now: still one run at a time...
    hold.open()
    await running
    await until(async () => searches.length === 2) // ...but the rules are checked again afterwards
    await new Promise((r) => setTimeout(r, 50))
    expect(searches).toHaveLength(2)
  })

  it('runs once, not twice, when nothing asked for another pass', async () => {
    const provider = new CountingProvider(30)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    store.saveCleanupRule({ id: 'auto', name: 'Nobody', filters: { from: 'nobody@nowhere.example' }, actions: [{ type: 'archive' }], auto: true })
    let count = 0
    provider.searchInbox = async () => { count++; return [] }
    await service.runAutomatic()
    await new Promise((r) => setTimeout(r, 50))
    expect(count).toBe(1)
  })
})


describe('"Auto-archive future mail" switched to Auto', () => {
  const SITE = 'Site Monitors <alerts@sitemonitors.example>'
  const ADDRESS = 'alerts@sitemonitors.example'

  it('labels and archives a site-monitors email that arrives later', async () => {
    const gmail = new FakeGmail()
    for (let i = 0; i < 6; i++) gmail.add(`Friend ${i} <friend${i}@mail.example>`, `Hi ${i}`)
    const old = gmail.add(SITE, 'Site is down (old)')
    const store = new FakeStore()
    const provider = gmail.provider() // one object, as in the app
    const service = new OrganizerService(() => provider, store as unknown as Store)
    await service.overview() // the app has scanned the inbox

    const rule = service.createArchiveRule(ADDRESS) // the button on a sender's panel
    service.saveRule({ ...rule, auto: true }) // the Auto box on its row, which runs it at once on what is already there
    await until(async () => gmail.modified.some((m) => m.ids.includes(old)))

    const id = gmail.arrive(SITE)
    await service.checkNewMail()
    await until(async () => gmail.modified.some((m) => m.ids.includes(id)))
    const change = gmail.modified.find((m) => m.ids.includes(id))!
    expect(change.remove).toContain('INBOX')
    expect(change.add).toHaveLength(1) // the Subscriptions label
    expect(gmail.labels.some((l) => l.name === 'Subscriptions')).toBe(true)
  })
})

describe('mail whose scan was interrupted', () => {
  it('still runs the automatic rules for mail that an interrupted scan had already saved', async () => {
    const provider = new HistoryProvider(60)
    const store = new FakeStore()
    await provider.elsewhere('demo-0', { inbox: false })
    const service = new OrganizerService(() => provider, store as unknown as Store)
    const sender = (await provider.getMessages(['demo-0']))[0].from.email
    await service.overview() // the first scan
    for (let i = 0; i < 5; i++) { await service.checkNewMail(); await new Promise((r) => setTimeout(r, 30)) } // let the follow-up looks from that scan pass
    store.saveRule({ id: 'r', name: 'Sender', enabled: true, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: sender }], actions: [{ type: 'archive' }] })

    await provider.elsewhere('demo-0', { inbox: true })
    provider.onFetch = () => service.invalidate() // something resets the view while the new mail is being downloaded: the scan stops after saving it
    await service.checkNewMail()
    provider.onFetch = () => {}
    await new Promise((r) => setTimeout(r, 50))
    expect(store.activity).toEqual([]) // the interrupted scan didn't finish, so it ran nothing

    const downloadedSoFar = provider.downloaded.length
    await service.overview() // the next scan: demo-0 is already saved, so this scan downloads nothing
    expect(provider.downloaded).toHaveLength(downloadedSoFar)
    await until(async () => store.activity.length > 0)
    expect(store.activity[0].ruleName).toBe('Sender (automatic)')
  })
})

describe('a scanned-mail rule next to an automatic cleanup', () => {
  it('is applied in the same run, even when a cleanup for someone else acted first', async () => {
    const gmail = new FakeGmail()
    const friend = gmail.add('Friend <friend@mail.example>', 'Hi') // an automatic cleanup will archive this
    gmail.add('Site Monitors <alerts@sitemonitors.example>', 'Site is down (old)')
    const store = new FakeStore()
    const provider = gmail.provider()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    await service.overview()
    for (let i = 0; i < 5; i++) { await service.checkNewMail(); await new Promise((r) => setTimeout(r, 30)) } // let the follow-up looks pass
    // saved straight to the store, so nothing runs until new mail arrives
    store.saveCleanupRule({ id: 'friend', name: 'Archive friend', filters: { from: 'friend@mail.example' }, actions: [{ type: 'archive' }], auto: true })
    store.saveRule({ id: 'site', name: 'Site monitors', enabled: true, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: 'alerts@sitemonitors.example' }], actions: [{ type: 'archive' }] })

    const id = gmail.arrive('Site Monitors <alerts@sitemonitors.example>')
    await service.checkNewMail()
    await until(async () => gmail.modified.some((m) => m.ids.includes(friend))) // the cleanup acted
    await until(async () => gmail.modified.some((m) => m.ids.includes(id))) // and so did the scanned-mail rule, in the same run
  })
})

describe('seeing what the new-mail check is doing', () => {
  const setupStatus = async () => {
    const provider = new HistoryProvider(30)
    const store = new FakeStore()
    const service = new OrganizerService(() => provider, store as unknown as Store)
    await service.overview()
    return { provider, store, service }
  }

  it('records every check, including one that found nothing', async () => {
    const { service } = await setupStatus()
    expect(service.automation().lastCheckedAt).toBeNull()
    await service.checkNewMail()
    const at = service.automation().lastCheckedAt
    expect(at).not.toBeNull()
    expect(Number.isNaN(Date.parse(at!))).toBe(false)
    expect(service.automation().checkError).toBeNull()
  })

  it('says why a check failed, without throwing it, and forgets it once a check works', async () => {
    const { provider, service } = await setupStatus()
    const listChanges = provider.listChanges.bind(provider)
    provider.listChanges = async () => { throw new Error('Gmail API error 429: rate limited') }
    await service.checkNewMail()
    expect(service.automation().checkError).toContain('rate limited')
    expect(service.automation().lastCheckedAt).not.toBeNull()

    provider.listChanges = listChanges
    await new Promise((r) => setTimeout(r, 60)) // the follow-up look at the rules finishes; checks don't overlap a run
    await service.checkNewMail()
    expect(service.automation().checkError).toBeNull()
  })

  it('keeps the last check when an automatic run updates the rest of the status', async () => {
    const { service } = await setupStatus()
    await service.checkNewMail()
    const at = service.automation().lastCheckedAt
    await service.runAutomatic()
    expect(service.automation().lastCheckedAt).toBe(at)
    expect(service.automation().lastRunAt).not.toBeNull()
  })
})

describe('choosing which emails of a suggestion go to Trash', () => {
  /** The fake mailbox answers every search with the whole inbox, so each suggestion lists all of it. */
  const setupChoose = (count = 60) => {
    const gmail = new FakeGmail()
    const ids = Array.from({ length: count }, (_, i) => gmail.add(`Sender ${i} <s${i}@mail.example>`, `Big file ${i}`))
    const store = new FakeStore()
    const provider = gmail.provider()
    return { gmail, ids, store, service: new OrganizerService(() => provider, store as unknown as Store) }
  }
  const BIG: SpaceSource = { kind: 'candidate', id: 'attachments-25' }

  it('lists a suggestion’s emails a page at a time, downloading only that page', async () => {
    const { service, gmail } = setupChoose(60)
    const first = await service.spaceList(BIG, 0)
    expect(first).toMatchObject({ title: 'Attachments over 25 MB', total: 60, offset: 0 })
    expect(first.messages).toHaveLength(50)
    expect(first.messages[0]).toMatchObject({ from: 'Sender 0', email: 's0@mail.example', subject: 'Big file 0', sizeBytes: 2000 })
    const searchesSoFar = gmail.searches.length
    const second = await service.spaceList(BIG, 50)
    expect(second.messages).toHaveLength(10)
    expect(gmail.searches.length).toBe(searchesSoFar) // the next page didn't search again
  })

  it('moves only the chosen emails to Trash, says how much that was, and can be undone', async () => {
    const { service, gmail, ids, store } = setupChoose(10)
    await service.spaceList(BIG, 0)
    const entry = await service.trashSelected(BIG, [ids[1], ids[4], ids[7]])
    expect(entry).toMatchObject({ messageCount: 3, move: 'trash', bytes: 6000 })
    expect(gmail.modified).toEqual([{ ids: [ids[1], ids[4], ids[7]], add: ['TRASH'], remove: ['INBOX'] }])
    expect(store.activity[0].ruleName).toBe('Free up space: Attachments over 25 MB')

    await service.undo(entry.id as number)
    expect(gmail.messages.filter((m) => m.labelIds.includes('INBOX'))).toHaveLength(10)
  })

  it('ignores anything that isn’t part of the suggestion, and refuses when nothing is', async () => {
    const { service, gmail, ids } = setupChoose(5)
    const archived = gmail.add('Old <old@mail.example>', 'Archived', []) // not in the inbox, so not in the suggestion
    const entry = await service.trashSelected(BIG, [ids[0], archived, 'made-up-id', ids[0]])
    expect(entry.messageCount).toBe(1)
    expect(gmail.modified[0].ids).toEqual([ids[0]])
    await expect(service.trashSelected(BIG, ['made-up-id'])).rejects.toThrow('None of those emails are here any more')
  })

  it('needs something chosen, not too much at once, and a real suggestion', async () => {
    const { service } = setupChoose(3)
    await expect(service.trashSelected(BIG, [])).rejects.toThrow('Choose at least one')
    await expect(service.trashSelected(BIG, Array.from({ length: 2001 }, (_, i) => `x${i}`))).rejects.toThrow('up to 2,000')
    await expect(service.spaceList({ kind: 'candidate', id: 'everything' }, 0)).rejects.toThrow('isn’t something the guide suggested')
    await expect(service.trashSelected({ kind: 'candidate', id: 'everything' }, ['a'])).rejects.toThrow('isn’t something the guide suggested')
  })

  it('lists and trashes chosen duplicates, keeping the newest copy', async () => {
    const copy = (id: string, date: string): MailMessage => ({
      id, accountId: 'me@x.com', from: { name: 'Shop', email: 'shop@x.example' }, subject: 'Your order', date, labels: ['INBOX'], isUnread: true, sizeBytes: 4000,
    })
    class Mailbox extends CountingProvider {
      mail = [copy('a', '2026-03-01T10:15:05Z'), copy('b', '2026-03-01T10:15:40Z'), copy('c', '2026-03-01T10:15:20Z')]
      override async listInboxIds(unreadOnly: boolean) { return this.mail.filter((m) => m.labels.includes('INBOX') && (!unreadOnly || m.isUnread)).map((m) => m.id) }
      override async getMessages(ids: string[]) { return this.mail.filter((m) => ids.includes(m.id)) }
      override async applyActions(ids: string[], actions: Parameters<DemoProvider['applyActions']>[1]) { this.mail = this.mail.map((m) => (ids.includes(m.id) ? applyActionsToMessage(m, actions) : m)) }
    }
    const provider = new Mailbox(0)
    const service = new OrganizerService(() => provider, new FakeStore() as unknown as Store)
    await service.overview()
    const list = await service.spaceList({ kind: 'duplicates' }, 0)
    expect(list).toMatchObject({ title: 'Duplicate messages', total: 2 })
    expect(list.messages.map((m) => m.id)).toEqual(['c', 'a']) // the extras, newest first; b, the newest, is kept

    const entry = await service.trashSelected({ kind: 'duplicates' }, ['a', 'b']) // b isn't an extra, so it stays
    expect(entry.messageCount).toBe(1)
    expect(provider.mail.filter((m) => m.labels.includes('INBOX')).map((m) => m.id).sort()).toEqual(['b', 'c'])
  })
})


describe('safety net: what an automatic rule can and cannot do to a real-sized inbox', () => {
  const PROMO = 'Promo <promo@shop.example>'
  const labelsOf = (gmail: FakeGmail) => JSON.stringify(gmail.messages.map((m) => [m.id, [...m.labelIds].sort()]))
  const bulk = (gmail: FakeGmail, n: number, from = PROMO, extra: string[] = []) => Array.from({ length: n }, (_, i) => gmail.add(from, `Offer ${i}`, ['INBOX', 'UNREAD', ...extra]))
  const setupSafety = () => {
    const gmail = new FakeGmail()
    const store = new FakeStore()
    const provider = gmail.provider()
    return { gmail, store, provider, service: new OrganizerService(() => provider, store as unknown as Store) }
  }
  const trashRule = (over: Partial<CleanupRule> = {}): CleanupRule => ({ id: 'auto', name: 'Promo', filters: { from: 'promo@shop.example', keepStarred: true }, actions: [{ type: 'trash' }], auto: true, ...over })

  it('leaves an automatic Trash cleanup that matches too much for review, and touches nothing', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 2_500)
    store.saveCleanupRule(trashRule())
    const before = labelsOf(gmail)

    const status = await service.runAutomatic()
    expect(status.needsReview).toEqual([{ id: 'auto', name: 'Promo', count: 2_500, kind: 'cleanup' }])
    expect(gmail.modified).toEqual([])
    expect(labelsOf(gmail)).toBe(before)
    expect(store.activity).toEqual([])
    await service.runAutomatic() // asking again doesn't change its mind or move anything
    expect(gmail.modified).toEqual([])
  })

  it('runs at exactly the limit, and one over is held back', async () => {
    const atLimit = setupSafety()
    bulk(atLimit.gmail, 2_000)
    atLimit.store.saveCleanupRule(trashRule())
    expect((await atLimit.service.runAutomatic()).needsReview).toEqual([])
    expect(atLimit.gmail.messages.filter((m) => m.labelIds.includes('INBOX'))).toHaveLength(0)

    const over = setupSafety()
    bulk(over.gmail, 2_001)
    over.store.saveCleanupRule(trashRule())
    expect((await over.service.runAutomatic()).needsReview).toHaveLength(1)
    expect(over.gmail.messages.filter((m) => m.labelIds.includes('INBOX'))).toHaveLength(2_001)
  })

  it('lets the user approve a held-back rule by hand, after which new mail is handled automatically', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 2_500)
    store.saveCleanupRule(trashRule())
    await service.runAutomatic()
    const { count } = await service.cleanupCount('auto')
    await service.applyCleanup('auto', count) // the user looked at the preview and chose to
    expect(gmail.messages.filter((m) => m.labelIds.includes('INBOX'))).toHaveLength(0)

    const id = gmail.add(PROMO, 'New offer')
    expect((await service.runAutomatic()).needsReview).toEqual([])
    expect(gmail.messages.find((m) => m.id === id)!.labelIds).toContain('TRASH')
  })

  it('never takes starred mail, and undo puts back exactly what was moved', async () => {
    const { gmail, store, service } = setupSafety()
    const ids = bulk(gmail, 10)
    gmail.messages.filter((m) => ['m2', 'm5', 'm9'].includes(m.id)).forEach((m) => m.labelIds.push('STARRED'))
    store.saveCleanupRule(trashRule())
    const before = labelsOf(gmail)

    await service.runAutomatic()
    const starred = gmail.messages.filter((m) => m.labelIds.includes('STARRED'))
    expect(starred.every((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('TRASH'))).toBe(true)
    expect(gmail.messages.filter((m) => m.labelIds.includes('TRASH'))).toHaveLength(7)
    expect(ids).toHaveLength(10)

    await service.undo(store.activity[0].id as number)
    expect(labelsOf(gmail)).toBe(before) // every message has exactly the labels it started with
  })

  it('undoes an automatic archive and mark-read run exactly, and only once', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 30)
    gmail.messages[3].labelIds = ['INBOX'] // one was already read
    store.saveCleanupRule({ id: 'a', name: 'Tidy', filters: { from: 'promo@shop.example' }, actions: [{ type: 'archive' }, { type: 'markRead' }], auto: true })
    const before = labelsOf(gmail)

    await service.runAutomatic()
    // the rule only takes unread mail (that's what makes undoing it exact), so the one already-read message stays put
    expect(gmail.messages.filter((m) => m.labelIds.includes('INBOX')).map((m) => m.id)).toEqual(['m4'])
    const id = store.activity[0].id as number
    await service.undo(id)
    expect(labelsOf(gmail)).toBe(before)
    await expect(service.undo(id)).rejects.toThrow('Nothing to undo')
  })

  it('refuses to save an automatic Trash cleanup that could reach everyday mail, and would not run one that got in anyway', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 20, 'Friend <friend@mail.example>')
    const broad = { id: 'broad', name: 'Old mail', filters: { olderThan: { value: 1, unit: 'y' as const } }, actions: [{ type: 'trash' as const }], auto: true, allowBroad: true }
    expect(() => service.saveCleanupRule(broad)).toThrow(/Automatic cleanups can’t move everyday mail/)

    store.saveCleanupRule(broad) // e.g. from a damaged or hand-edited database
    const status = await service.runAutomatic()
    expect(status.errors).toEqual([{ name: 'Old mail', message: expect.stringContaining('everyday mail'), kind: 'cleanup' }])
    expect(gmail.modified).toEqual([])
  })

  it('holds back an automatic Trash rule on scanned mail that matches too much', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 2_300)
    service.scanFullInbox()
    await service.overview() // the whole inbox is scanned, so the rule sees all 2,300
    store.saveRule({ id: 'r', name: 'Promo', enabled: true, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: 'promo@shop.example' }], actions: [{ type: 'trash' }] })
    const status = await service.runAutomatic()
    expect(status.needsReview).toEqual([{ id: 'r', name: 'Promo', count: 2_300, kind: 'rule' }])
    expect(gmail.modified).toEqual([])
  })

  it('never runs a rule that is switched off', async () => {
    const { gmail, store, service } = setupSafety()
    bulk(gmail, 5)
    service.scanFullInbox()
    await service.overview()
    store.saveRule({ id: 'r', name: 'Off', enabled: false, match: 'all', auto: true, conditions: [{ field: 'senderEmail', op: 'equals', value: 'promo@shop.example' }], actions: [{ type: 'archive' }] })
    await service.runAutomatic()
    expect(gmail.modified).toEqual([])
  })

  it('stops everything when paused, including runs that new mail would trigger, and starts again when resumed', async () => {
    let paused = true
    const gmail = new FakeGmail()
    const store = new FakeStore()
    const provider = gmail.provider()
    const service = new OrganizerService(() => provider, store as unknown as Store, () => {}, { isPaused: () => paused })
    bulk(gmail, 5)
    await service.overview()
    store.saveCleanupRule({ id: 'a', name: 'Archive promo', filters: { from: 'promo@shop.example' }, actions: [{ type: 'archive' }], auto: true })

    expect((await service.runAutomatic()).paused).toBe(true)
    gmail.arrive(PROMO) // new mail would normally trigger a run
    await service.checkNewMail()
    await new Promise((r) => setTimeout(r, 80))
    expect(gmail.modified).toEqual([])
    expect(service.automation().paused).toBe(true)

    paused = false
    await service.runAutomatic()
    expect(gmail.messages.filter((m) => m.labelIds.includes('INBOX'))).toHaveLength(0)
    expect(service.automation().paused).toBe(false)
  })
})
