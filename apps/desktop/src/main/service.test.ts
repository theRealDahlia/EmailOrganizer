import { describe, expect, it } from 'vitest'
import { DemoProvider, type MailMessage, type Rule } from '@organizer/core'
import type { Store } from './db'
import type { ScanProgress } from '../shared'
import { OrganizerService } from './service'

/** In-memory stand-in for Store, so these tests don't need the Electron-built SQLite module. */
class FakeStore {
  rules: Rule[] = []
  messages = new Map<string, Map<string, MailMessage>>()
  activity: { id: number; undo: unknown; undone: boolean; ruleName: string; messageCount: number; at: string }[] = []
  private acct = (a: string) => this.messages.get(a) ?? this.messages.set(a, new Map()).get(a)!
  listRules() { return this.rules }
  saveRule(r: Rule) { this.rules = [...this.rules.filter((x) => x.id !== r.id), r] }
  loadMessages(a: string) { return new Map(this.acct(a)) }
  getMessages(a: string, ids: string[]) { return ids.flatMap((id) => (this.acct(a).has(id) ? [this.acct(a).get(id)!] : [])) }
  upsertMessages(a: string, ms: MailMessage[]) { ms.forEach((m) => this.acct(a).set(m.id, m)) }
  deleteMessages(a: string, ids: string[]) { ids.forEach((id) => this.acct(a).delete(id)) }
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

/** A mailbox whose listing and downloads can be held open, to look at the app mid-scan. */
class BlockingProvider extends CountingProvider {
  holdListing: Promise<void> | null = null
  holdDownloads: Promise<void> | null = null
  override async listInboxIds(unreadOnly: boolean, hooks?: Parameters<DemoProvider['listInboxIds']>[1]) {
    await this.holdListing
    return super.listInboxIds(unreadOnly, hooks)
  }
  override async getMessages(ids: string[], opts?: { signal?: AbortSignal }) {
    await this.holdDownloads
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
    expect(events.at(-1)).toMatchObject({ phase: 'done', total: 0 })
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
