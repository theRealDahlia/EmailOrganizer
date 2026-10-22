import { describe, expect, it } from 'vitest'
import { GmailProvider, reduceHistory } from './index'

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const provider = (f: typeof fetch) =>
  new GmailProvider({ accountId: 'a', getAccessToken: async () => 't', fetch: f, sleep: async () => {} })

describe('reduceHistory', () => {
  it('keeps the net inbox and unread state in order', () => {
    const { inbox, unread } = reduceHistory([
      { messagesAdded: [{ message: { id: 'new', labelIds: ['INBOX', 'UNREAD'] } }] },
      { labelsRemoved: [{ message: { id: 'old' }, labelIds: ['INBOX'] }] },
      { labelsRemoved: [{ message: { id: 'read' }, labelIds: ['UNREAD'] }] },
      { messagesAdded: [{ message: { id: 'sent', labelIds: ['SENT'] } }] },
      { labelsAdded: [{ message: { id: 'bounce' }, labelIds: ['INBOX'] }] },
      { labelsRemoved: [{ message: { id: 'bounce' }, labelIds: ['INBOX'] }] },
      { messagesDeleted: [{ message: { id: 'gone' } }] },
      { labelsAdded: [{ message: { id: 'trashed' }, labelIds: ['TRASH'] }] },
    ])
    expect(Object.fromEntries(inbox)).toEqual({ new: true, old: false, sent: false, bounce: false, gone: false, trashed: false })
    expect(Object.fromEntries(unread)).toEqual({ new: true, read: false, sent: false })
  })
})

describe('listChanges', () => {
  it('pages through history and returns the newest checkpoint', async () => {
    const urls: URL[] = []
    const f = (async (u: string) => {
      const url = new URL(u); urls.push(url)
      return url.searchParams.get('pageToken')
        ? json({ history: [{ labelsRemoved: [{ message: { id: 'b' }, labelIds: ['INBOX'] }] }], historyId: '300' })
        : json({ history: [{ messagesAdded: [{ message: { id: 'a', labelIds: ['INBOX'] } }] }], nextPageToken: 'p2', historyId: '250' })
    }) as unknown as typeof fetch
    const changes = await provider(f).listChanges('100')
    expect(changes!.historyId).toBe('300')
    expect(Object.fromEntries(changes!.inbox)).toEqual({ a: true, b: false })
    expect(urls[0].searchParams.get('startHistoryId')).toBe('100')
    expect(urls[0].searchParams.getAll('historyTypes')).toHaveLength(4)
  })

  it('reports nothing changed with an empty history', async () => {
    const f = (async () => json({ historyId: '120' })) as unknown as typeof fetch
    const changes = await provider(f).listChanges('120')
    expect(changes).toMatchObject({ historyId: '120' })
    expect(changes!.inbox.size).toBe(0)
  })

  it('returns null when the checkpoint is too old (404), so the caller relists', async () => {
    const f = (async () => json({ error: { message: 'Requested entity was not found.' } }, 404)) as unknown as typeof fetch
    expect(await provider(f).listChanges('1')).toBeNull()
  })

  it('reads the current checkpoint from the profile', async () => {
    const f = (async () => json({ emailAddress: 'x', historyId: '777' })) as unknown as typeof fetch
    expect(await provider(f).getHistoryId()).toBe('777')
  })
})
