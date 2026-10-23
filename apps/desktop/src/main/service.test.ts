import { describe, expect, it } from 'vitest'
import { DemoProvider, buildQuery, type CleanupRule, type InboxChanges, type MailMessage, type Rule } from '@organizer/core'
import type { ScanState, Store } from './db'
import type { ScanProgress } from '../shared'
import { OrganizerService } from './service'

/** In-memory stand-in for Store, so these tests don't need the Electron-built SQLite module. */
class FakeStore {
  rules: Rule[] = []
  cleanup: CleanupRule[] = []
  listCleanupRules() { return this.cleanup }
  saveCleanupRule(r: CleanupRule) { this.cleanup = [...this.cleanup.filter((x) => x.id !== r.id), r] }
  deleteCleanupRule(id: string) { this.cleanup = this.cleanup.filter((x) => x.id !== id) }
  messages = new Map<string, Map<string, MailMessage>>()
  activity: { id: number; undo: unknown; undone: boolean; ruleName: string; messageCount: number; at: string }[] = []
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
  addActivity(ruleName: string, messageCount: number, undo: unknown) {
    const e = { id: this.activity.length + 1, at: 'now', ruleName, messageCount, undo, undone: false }
    this.activity.push(e)
    return e
  }
  takeUndo(id: number) { const e = this.activity.find((a) => a.id === id)!; e.undone = true; return e.undo }
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
