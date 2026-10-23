import { describe, expect, it } from 'vitest'
import { inverseActions, buildOverview, buildSenders, buildSubscriptions, isPublicHttpsUrl, parseListUnsubscribe, validateRule, type MailMessage, type Rule } from './index'

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r', name: 'Test', enabled: true, match: 'all',
  conditions: [{ field: 'senderDomain', op: 'equals', value: 'a.com' }], actions: [{ type: 'archive' }], ...over,
})

describe('validateRule', () => {
  it('accepts a good rule', () => expect(validateRule(rule())).toEqual([]))
  it('flags missing pieces', () => {
    expect(validateRule(rule({ name: ' ', conditions: [], actions: [] })).length).toBe(3)
  })
  it('flags empty values, bad numbers, bad categories', () => {
    const r = rule({ conditions: [
      { field: 'subject', op: 'contains', value: '  ' },
      { field: 'olderThanDays', op: 'gte', value: -1 },
      { field: 'category', op: 'equals', value: 'bogus' as never },
    ] })
    expect(validateRule(r)).toHaveLength(3)
  })
  it('rejects built-in Gmail label names', () => {
    expect(validateRule(rule({ actions: [{ type: 'addLabel', label: 'inbox' }] }))).toHaveLength(1)
    expect(validateRule(rule({ actions: [{ type: 'addLabel', label: 'Receipts' }] }))).toEqual([])
  })
})

describe('trash rules', () => {
  const trash = (over: Partial<Rule> = {}) => rule({ actions: [{ type: 'trash' }], ...over })
  it('accepts trash with a narrow condition', () => expect(validateRule(trash())).toEqual([]))
  it('rejects trash on broad conditions only', () => {
    expect(validateRule(trash({ conditions: [{ field: 'olderThanDays', op: 'gte', value: 30 }] }))).toHaveLength(1)
    expect(validateRule(trash({ conditions: [{ field: 'isUnread', op: 'equals', value: true }] }))).toHaveLength(1)
    expect(validateRule(trash({ conditions: [{ field: 'category', op: 'equals', value: 'personal' }] }))).toHaveLength(1)
  })
  it('allows broad conditions alongside a narrow one when matching all', () => {
    expect(validateRule(trash({ conditions: [
      { field: 'category', op: 'equals', value: 'promotion' }, { field: 'olderThanDays', op: 'gte', value: 30 },
    ] }))).toEqual([])
  })
  it('with "any", every condition must be narrow', () => {
    expect(validateRule(trash({ match: 'any', conditions: [
      { field: 'senderDomain', op: 'equals', value: 'a.com' }, { field: 'olderThanDays', op: 'gte', value: 30 },
    ] }))).toHaveLength(1)
  })
  it('inverse of trash restores inbox membership', () => {
    const m = { id: 'x', accountId: 'a', from: { name: 'A', email: 'a@a.com' }, subject: 's', date: '2026-01-01', labels: ['INBOX'], isUnread: false, sizeBytes: 1 }
    expect(inverseActions(m, [{ type: 'trash' }])).toEqual([{ type: 'removeLabel', label: 'TRASH' }, { type: 'addLabel', label: 'INBOX' }])
  })
})

describe('unsubscribe', () => {
  it('parses https and mailto targets', () => {
    expect(parseListUnsubscribe('<mailto:u@x.com?subject=unsub>, <https://x.com/u?id=1>')).toEqual({
      mailto: 'mailto:u@x.com?subject=unsub', https: 'https://x.com/u?id=1',
    })
  })
  it('refuses unsafe URLs from untrusted headers', () => {
    for (const bad of ['http://x.com/u', 'https://localhost/u', 'https://127.0.0.1/u', 'https://192.168.1.1/u',
      'https://[::1]/u', 'https://user:pw@x.com/u', 'https://printer.local/u', 'https://intranet/u', 'javascript:alert(1)']) {
      expect(isPublicHttpsUrl(bad), bad).toBe(false)
    }
    expect(parseListUnsubscribe('<https://127.0.0.1/u>')).toEqual({})
    expect(isPublicHttpsUrl('https://news.example.com/unsub')).toBe(true)
  })
})

describe('buildSubscriptions', () => {
  const m = (id: string, unread: boolean, date: string, unsub = '<https://s.com/u>'): MailMessage => ({
    id, accountId: 'a', from: { name: 'S', email: 'News@S.com' }, subject: 's', date, labels: [], isUnread: unread,
    sizeBytes: 1, listUnsubscribe: unsub,
  })
  it('groups by sender, computes read rate, uses the newest header', () => {
    const subs = buildSubscriptions([
      m('1', true, '2026-01-01'), m('2', false, '2026-01-03', '<https://s.com/new>'), m('3', true, '2026-01-02'),
      { ...m('4', true, '2026-01-04'), listUnsubscribe: undefined, from: { name: 'P', email: 'p@x.com' } },
    ])
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ email: 'news@s.com', count: 3, unread: 2, listUnsubscribe: '<https://s.com/new>' })
    expect(subs[0].readRate).toBeCloseTo(1 / 3)
  })
})

describe('buildSenders', () => {
  const msg = (id: string, email: string, name: string, date: string, unread = false): MailMessage => ({
    id, accountId: 'a', from: { name, email }, subject: 's', date, labels: ['INBOX'], isUnread: unread, sizeBytes: 10,
  })

  it('lists every sender with counts, busiest first, ignoring address case', () => {
    const senders = buildSenders([
      msg('1', 'A@x.com', 'Old Name', '2026-01-01T00:00:00Z', true),
      msg('2', 'b@x.com', 'B', '2026-02-01T00:00:00Z'),
      msg('3', 'a@x.com', 'New Name', '2026-03-01T00:00:00Z'),
    ])
    expect(senders.map((s) => [s.email, s.count, s.unread])).toEqual([['a@x.com', 2, 1], ['b@x.com', 1, 0]])
  })

  it('reports the newest message date and the name from it', () => {
    const [a] = buildSenders([msg('1', 'a@x.com', 'Old Name', '2026-01-01T00:00:00Z'), msg('2', 'a@x.com', 'New Name', '2026-03-01T00:00:00Z'), msg('3', 'a@x.com', 'Mid', '2026-02-01T00:00:00Z')])
    expect(a).toMatchObject({ lastDate: '2026-03-01T00:00:00Z', name: 'New Name' })
  })

  it('has no limit, unlike the overview', () => {
    const many = Array.from({ length: 40 }, (_, i) => msg(String(i), `s${i}@x.com`, `S${i}`, '2026-01-01T00:00:00Z'))
    expect(buildSenders(many)).toHaveLength(40)
    expect(buildOverview(many).topSenders).toHaveLength(10)
  })
})
