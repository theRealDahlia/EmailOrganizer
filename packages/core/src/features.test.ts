import { describe, expect, it } from 'vitest'
import { buildSubscriptions, isPublicHttpsUrl, parseListUnsubscribe, validateRule, type MailMessage, type Rule } from './index'

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
