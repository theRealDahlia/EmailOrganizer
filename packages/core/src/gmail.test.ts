import { describe, expect, it, vi } from 'vitest'
import { GmailProvider, parseAddress } from './gmail'
import { AuthExpiredError, GoogleTokenSource, buildAuthUrl, createPkce, exchangeCode } from './oauth'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Routes requests by "METHOD /path" and records them. */
function fakeFetch(routes: Record<string, (body: any, url: URL) => Response | Promise<Response>>) {
  const calls: { key: string; body: any }[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace('/gmail/v1/users/me', '')}`
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    calls.push({ key, body })
    const route = routes[key]
    if (!route) throw new Error(`unexpected request: ${key}`)
    return route(body, url)
  }) as typeof fetch
  return { impl, calls }
}

const provider = (f: typeof fetch) =>
  new GmailProvider({ accountId: 'me@x.com', getAccessToken: async () => 'tok', fetch: f, sleep: async () => {} })

const LABELS = { labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'UNREAD', name: 'UNREAD' }, { id: 'Label_1', name: 'Receipts' }] }

describe('parseAddress', () => {
  it('handles common From formats', () => {
    expect(parseAddress('"Ann Lee" <ann@x.com>')).toEqual({ name: 'Ann Lee', email: 'ann@x.com' })
    expect(parseAddress('Bob <bob@x.com>')).toEqual({ name: 'Bob', email: 'bob@x.com' })
    expect(parseAddress('<c@x.com>')).toEqual({ name: 'c@x.com', email: 'c@x.com' })
    expect(parseAddress('d@x.com')).toEqual({ name: 'd@x.com', email: 'd@x.com' })
  })
})

describe('GmailProvider', () => {
  it('lists inbox metadata and maps it to MailMessage', async () => {
    const { impl } = fakeFetch({
      'GET /labels': () => json(LABELS),
      'GET /messages': () => json({ messages: [{ id: 'a' }], nextPageToken: 'p2' }),
      'GET /messages/a': () => json({
        id: 'a', labelIds: ['INBOX', 'UNREAD', 'Label_1'], sizeEstimate: 1234, internalDate: '1767225600000',
        payload: { headers: [
          { name: 'From', value: 'Shop <hi@shop.com>' }, { name: 'Subject', value: 'Your receipt' },
          { name: 'List-Unsubscribe', value: '<mailto:u@shop.com>' },
        ] },
      }),
    })
    const page = await provider(impl).listMessages()
    expect(page.nextCursor).toBe('p2')
    expect(page.messages[0]).toMatchObject({
      id: 'a', accountId: 'me@x.com', subject: 'Your receipt', isUnread: true, sizeBytes: 1234,
      from: { name: 'Shop', email: 'hi@shop.com' }, labels: ['INBOX', 'Receipts'], date: '2026-01-01T00:00:00.000Z',
      listUnsubscribe: '<mailto:u@shop.com>',
    })
  })

  it('translates actions into one batchModify, creating missing labels', async () => {
    const { impl, calls } = fakeFetch({
      'GET /labels': () => json(LABELS),
      'POST /labels': (b) => json({ id: 'Label_9', name: b.name }),
      'POST /messages/batchModify': () => new Response(null, { status: 204 }),
    })
    await provider(impl).applyActions(['a', 'b'], [
      { type: 'addLabel', label: 'Promotions' }, { type: 'archive' }, { type: 'markRead' }, { type: 'addLabel', label: 'receipts' },
    ])
    const modify = calls.find((c) => c.key === 'POST /messages/batchModify')!
    expect(modify.body).toEqual({
      ids: ['a', 'b'], addLabelIds: ['Label_9', 'Label_1'], removeLabelIds: ['INBOX', 'UNREAD'],
    })
    expect(calls.filter((c) => c.key === 'POST /labels')).toHaveLength(1)
  })

  it('lets later actions override earlier ones (undo ordering)', async () => {
    const { impl, calls } = fakeFetch({
      'GET /labels': () => json(LABELS),
      'POST /messages/batchModify': () => new Response(null, { status: 204 }),
    })
    await provider(impl).applyActions(['a'], [{ type: 'archive' }, { type: 'addLabel', label: 'INBOX' }])
    expect(calls.at(-1)!.body).toMatchObject({ addLabelIds: ['INBOX'], removeLabelIds: [] })
  })

  it('refreshes once on 401, then reports expired auth', async () => {
    const tokens: boolean[] = []
    const f = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const p = new GmailProvider({
      accountId: 'x', fetch: f, sleep: async () => {},
      getAccessToken: async (force) => { tokens.push(!!force); return 't' },
    })
    await expect(p.getProfileEmail()).rejects.toBeInstanceOf(AuthExpiredError)
    expect(tokens).toEqual([false, true])
  })

  it('treats a 403 quota error as retryable', async () => {
    let n = 0
    const quota = { error: { message: "Quota exceeded for quota metric 'Total Query Cost'", errors: [{ reason: 'rateLimitExceeded' }] } }
    const f = (async () => (++n < 3 ? json(quota, 403) : json({ emailAddress: 'me@x.com' }))) as unknown as typeof fetch
    expect(await provider(f).getProfileEmail()).toBe('me@x.com')
    expect(n).toBe(3)
  })

  it('does not retry a real 403 permission error', async () => {
    let n = 0
    const f = (async () => { n++; return json({ error: { message: 'Insufficient Permission' } }, 403) }) as unknown as typeof fetch
    await expect(provider(f).getProfileEmail()).rejects.toThrow('Insufficient Permission')
    expect(n).toBe(1)
  })

  it('retries on 429 then succeeds', async () => {
    let n = 0
    const f = (async () => (++n < 3 ? new Response('{}', { status: 429 }) : json({ emailAddress: 'me@x.com' }))) as unknown as typeof fetch
    expect(await provider(f).getProfileEmail()).toBe('me@x.com')
  })
})

describe('oauth', () => {
  it('creates an S256 PKCE pair and auth URL', async () => {
    const { verifier, challenge } = await createPkce()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const expected = Buffer.from(digest).toString('base64url')
    expect(challenge).toBe(expected)

    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1234', challenge, state: 's' }))
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope')).toContain('gmail.modify')
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('state')).toBe('s')
  })

  it('exchanges a code and sends the verifier', async () => {
    let sent: URLSearchParams | undefined
    const f = (async (_u: unknown, init: RequestInit) => {
      sent = init.body as URLSearchParams
      return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    }) as unknown as typeof fetch
    const t = await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', verifier: 'v', redirectUri: 'http://127.0.0.1:1' }, f, 1000)
    expect(t).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 3_601_000 })
    expect(sent!.get('code_verifier')).toBe('v')
  })

  it('maps invalid_grant to AuthExpiredError and keeps the refresh token on refresh', async () => {
    const bad = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch
    const src = new GoogleTokenSource({ clientId: 'c', clientSecret: 's' }, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, () => {}, bad)
    await expect(src.getAccessToken()).rejects.toBeInstanceOf(AuthExpiredError)

    const onUpdate = vi.fn()
    const ok = (async () => json({ access_token: 'new', expires_in: 3600 })) as unknown as typeof fetch
    const src2 = new GoogleTokenSource({ clientId: 'c', clientSecret: 's' }, { accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, onUpdate, ok, () => 0)
    expect(await src2.getAccessToken()).toBe('new')
    expect(onUpdate).toHaveBeenCalledWith({ accessToken: 'new', refreshToken: 'r', expiresAt: 3_600_000 })
    expect(await src2.getAccessToken()).toBe('new') // cached, no second refresh
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })
})
