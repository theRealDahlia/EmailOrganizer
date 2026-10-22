import { describe, expect, it } from 'vitest'
import { DemoProvider, GmailProvider, applyActionsToMessage, inverseActions, type MailMessage } from './index'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const provider = (f: typeof fetch) =>
  new GmailProvider({ accountId: 'me@x.com', getAccessToken: async () => 't', fetch: f, sleep: async () => {} })

const meta = (id: string) => ({
  id, labelIds: ['INBOX'], sizeEstimate: 1, internalDate: '1767225600000',
  payload: { headers: [{ name: 'From', value: 'A <a@a.com>' }, { name: 'Subject', value: id }] },
})

describe('listInboxIds', () => {
  it('pages through the whole inbox and filters unread with an AND of labels', async () => {
    const urls: URL[] = []
    const f = (async (u: string) => {
      const url = new URL(u); urls.push(url)
      if (url.pathname.endsWith('/messages')) {
        return url.searchParams.get('pageToken')
          ? json({ messages: [{ id: 'c' }] })
          : json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' })
      }
      throw new Error('unexpected ' + u)
    }) as unknown as typeof fetch

    expect(await provider(f).listInboxIds(false)).toEqual(['a', 'b', 'c'])
    expect(urls[0].searchParams.get('maxResults')).toBe('500')
    expect(urls[0].searchParams.getAll('labelIds')).toEqual(['INBOX'])

    await provider(f).listInboxIds(true)
    expect(urls.at(-1)!.searchParams.getAll('labelIds')).toEqual(['INBOX', 'UNREAD'])
  })
})

describe('getMessages', () => {
  const routes = (gone: string[] = []) => (async (u: string) => {
    const path = new URL(u).pathname
    if (path.endsWith('/labels')) return json({ labels: [{ id: 'INBOX', name: 'INBOX' }] })
    const id = path.split('/').pop()!
    return gone.includes(id) ? json({ error: { message: 'Requested entity was not found.' } }, 404) : json(meta(id))
  }) as unknown as typeof fetch

  it('keeps order and skips messages deleted since listing', async () => {
    const got = await provider(routes(['b'])).getMessages(['a', 'b', 'c'])
    expect(got.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('stops fetching when aborted and returns what it has', async () => {
    const ctrl = new AbortController()
    let fetched = 0
    const f = (async (u: string) => {
      const path = new URL(u).pathname
      if (path.endsWith('/labels')) return json({ labels: [] })
      if (++fetched === 3) ctrl.abort()
      return json(meta(path.split('/').pop()!))
    }) as unknown as typeof fetch
    const ids = Array.from({ length: 50 }, (_, i) => `m${i}`)
    const got = await provider(f).getMessages(ids, { signal: ctrl.signal })
    expect(got.length).toBeGreaterThanOrEqual(3)
    expect(got.length).toBeLessThan(10)
  })
})

describe('applyActionsToMessage', () => {
  const m: MailMessage = {
    id: 'x', accountId: 'a', from: { name: 'A', email: 'a@a.com' }, subject: 's', date: '2026-01-01',
    labels: ['INBOX'], isUnread: true, sizeBytes: 1,
  }
  it('mirrors what the mail service does', () => {
    expect(applyActionsToMessage(m, [{ type: 'archive' }, { type: 'markRead' }, { type: 'addLabel', label: 'R' }]))
      .toMatchObject({ labels: ['R'], isUnread: false })
    expect(applyActionsToMessage(m, [{ type: 'trash' }]).labels).toEqual(['TRASH'])
  })
  it('round-trips with inverseActions', () => {
    const actions = [{ type: 'trash' as const }, { type: 'markRead' as const }]
    const after = applyActionsToMessage(m, actions)
    const back = applyActionsToMessage(after, inverseActions(m, actions))
    expect(back.isUnread).toBe(true)
    expect([...back.labels].sort()).toEqual(['INBOX'])
  })
})

describe('DemoProvider scan API', () => {
  it('lists inbox ids and drops archived messages', async () => {
    const d = new DemoProvider(10)
    await d.applyActions(['demo-0'], [{ type: 'archive' }])
    const ids = await d.listInboxIds(false)
    expect(ids).toHaveLength(9)
    expect((await d.getMessages(ids.slice(0, 2))).map((m) => m.id)).toEqual(ids.slice(0, 2))
  })
})

describe('progress hooks', () => {
  it('reports ids listed so far, per page', async () => {
    const f = (async (u: string) => (new URL(u).searchParams.get('pageToken')
      ? json({ messages: [{ id: 'c' }] })
      : json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }))) as unknown as typeof fetch
    const counts: number[] = []
    await provider(f).listInboxIds(false, { onProgress: (n) => counts.push(n) })
    expect(counts).toEqual([2, 3])
  })

  it('reports each message processed, including ones that 404', async () => {
    const f = (async (u: string) => {
      const path = new URL(u).pathname
      if (path.endsWith('/labels')) return json({ labels: [] })
      return path.endsWith('/b') ? json({ error: { message: 'gone' } }, 404) : json(meta(path.split('/').pop()!))
    }) as unknown as typeof fetch
    const counts: number[] = []
    await provider(f).getMessages(['a', 'b', 'c'], { onProgress: (n) => counts.push(n) })
    expect(counts).toEqual([1, 2, 3])
  })

  it('tells the caller when it is waiting out a rate limit', async () => {
    let n = 0
    const quota = { error: { message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }
    const f = (async (u: string) => {
      const path = new URL(u).pathname
      if (path.endsWith('/labels')) return json({ labels: [] })
      return ++n < 3 ? json(quota, 403) : json(meta('a'))
    }) as unknown as typeof fetch
    const waits: number[] = []
    const got = await provider(f).getMessages(['a'], { onWait: (ms) => waits.push(ms) })
    expect(got).toHaveLength(1)
    expect(waits).toEqual([2000, 4000])
  })
})

describe('pacing', () => {
  const quota = { error: { message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }
  const gmail = (f: typeof fetch, sleeps: number[]) =>
    new GmailProvider({ accountId: 'a', getAccessToken: async () => 't', fetch: f, sleep: async (ms) => { sleeps.push(ms) } })

  it('spaces fetches about 222 ms apart (under 300 fetches a minute)', async () => {
    const f = (async (u: string) => {
      const path = new URL(u).pathname
      return path.endsWith('/labels') ? json({ labels: [] }) : json(meta(path.split('/').pop()!))
    }) as unknown as typeof fetch
    const sleeps: number[] = []
    const p = gmail(f, sleeps)
    expect(p.fetchesPerMinute).toBe(270)
    await p.getMessages(['a', 'b', 'c', 'd'])
    expect(sleeps.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(600) // 4 fetches queued at 222 ms intervals
  })

  it('slows its pace after Google pushes back', async () => {
    let n = 0
    const f = (async (u: string) => {
      const path = new URL(u).pathname
      if (path.endsWith('/labels')) return json({ labels: [] })
      return ++n === 1 ? json(quota, 403) : json(meta('a'))
    }) as unknown as typeof fetch
    const p = gmail(f, [])
    await p.getMessages(['a'])
    expect(p.fetchesPerMinute).toBeLessThan(270)
  })
})
