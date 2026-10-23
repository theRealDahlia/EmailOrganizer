import { describe, expect, it } from 'vitest'
import {
  CLEANUP_PRESETS, isBroadTrash, DemoProvider, GmailProvider, applyActionsToMessage, buildQuery, describeFilters,
  mailMove, matchesGmailQuery, reverseCleanupActions, validateCleanup, type CleanupRule, type MailMessage,
} from './index'

const rule = (over: Partial<CleanupRule> = {}): CleanupRule => ({
  id: 'r', name: 'R', filters: { category: 'promotions' }, actions: [{ type: 'archive' }], ...over,
})

describe('buildQuery', () => {
  it('turns filters into a Gmail search that is always scoped to the inbox', () => {
    expect(buildQuery({ category: 'promotions', olderThan: { value: 1, unit: 'y' } }, [{ type: 'trash' }]))
      .toBe('in:inbox category:promotions older_than:1y')
    expect(buildQuery({ largerThanMB: 10, from: 'news.example.com', hasAttachment: true }, []))
      .toBe('in:inbox larger:10M from:(news.example.com) has:attachment')
    expect(buildQuery({ read: 'read', subject: 'invoice' }, [])).toBe('in:inbox subject:("invoice") is:read')
  })

  it('can leave starred and important mail out', () => {
    expect(buildQuery({ olderThan: { value: 9, unit: 'm' }, keepStarred: true, keepImportant: true }, [{ type: 'trash' }]))
      .toBe('in:inbox older_than:9m -is:starred -is:important')
    expect(describeFilters({ olderThan: { value: 9, unit: 'm' }, keepStarred: true })).toBe('Mail older than 9 months, keeping starred mail')
  })

  it('excludes mail the actions would not change, so undo is exact', () => {
    const q = buildQuery({ category: 'social' }, [{ type: 'markRead' }, { type: 'addLabel', label: 'Old Stuff' }])
    expect(q).toBe('in:inbox category:social is:unread -label:old-stuff')
  })

  it('cannot be talked out of the inbox or out of its own quotes', () => {
    const q = buildQuery({ from: 'a) OR in:anywhere (', subject: 'x") OR in:trash ("', extra: 'in:anywhere' }, [])
    expect(q.startsWith('in:inbox ')).toBe(true)
    expect(q).toBe('in:inbox from:(a OR in:anywhere) subject:("x OR in:trash") (in:anywhere)')
    // unbalanced advanced input is dropped rather than closing the wrapper
    expect(buildQuery({ extra: 'a) OR in:anywhere (' }, [])).toBe('in:inbox')
  })
})

describe('validateCleanup', () => {
  it('accepts a normal rule and the presets', () => {
    expect(validateCleanup(rule())).toEqual([])
    for (const p of CLEANUP_PRESETS) expect(validateCleanup({ id: 'p', name: p.name, filters: p.filters, actions: p.actions }), p.name).toEqual([])
  })
  it('refuses a rule that would match the whole inbox', () => {
    expect(validateCleanup(rule({ filters: {} }))).toContain('Add at least one filter, or this would match your whole inbox.')
  })
  it('refuses Trash on filters that could reach everyday mail, unless the user opts in', () => {
    for (const filters of [{ olderThan: { value: 2, unit: 'y' as const } }, { read: 'read' as const }, { category: 'primary' as const }, { largerThanMB: 1 }]) {
      const trash = rule({ filters, actions: [{ type: 'trash' }] })
      expect(isBroadTrash(trash), JSON.stringify(filters)).toBe(true)
      expect(validateCleanup(trash), JSON.stringify(filters)).toHaveLength(1)
      expect(validateCleanup({ ...trash, allowBroad: true }), JSON.stringify(filters)).toEqual([])
    }
    expect(isBroadTrash(rule({ filters: { from: 'spam.example' }, actions: [{ type: 'trash' }] }))).toBe(false)
    expect(isBroadTrash(rule({ filters: { olderThan: { value: 9, unit: 'm' } }, actions: [{ type: 'archive' }] }))).toBe(false)
    expect(validateCleanup(rule({ filters: { from: 'spam.example' }, actions: [{ type: 'trash' }] }))).toEqual([])
    expect(validateCleanup(rule({ filters: { largerThanMB: 10 }, actions: [{ type: 'trash' }] }))).toEqual([])
  })
  it('checks numbers, labels and parentheses', () => {
    expect(validateCleanup(rule({ filters: { olderThan: { value: 0, unit: 'd' } } })).length).toBeGreaterThan(0)
    expect(validateCleanup(rule({ actions: [{ type: 'addLabel', label: 'inbox' }] }))).toHaveLength(1)
    expect(validateCleanup(rule({ filters: { extra: 'a)(' } })).some((p) => /parentheses/.test(p))).toBe(true)
    expect(describeFilters({ category: 'promotions', olderThan: { value: 1, unit: 'y' } })).toBe('Mail in the promotions tab, older than 1 year')
  })
})

describe('reverseCleanupActions', () => {
  it('puts back exactly what the actions changed', () => {
    const m: MailMessage = {
      id: 'x', accountId: 'a', from: { name: 'A', email: 'a@a.com' }, subject: 's', date: '2020-01-01',
      labels: ['INBOX'], isUnread: true, sizeBytes: 1,
    }
    const actions = [{ type: 'trash' as const }, { type: 'markRead' as const }, { type: 'addLabel' as const, label: 'Old' }]
    const back = applyActionsToMessage(applyActionsToMessage(m, actions), reverseCleanupActions(actions))
    expect(back.isUnread).toBe(true)
    expect([...back.labels].sort()).toEqual(['INBOX'])
  })
})

describe('searchInbox', () => {
  const json = (b: unknown) => new Response(JSON.stringify(b))
  it('pages through matches with the query and downloads nothing', async () => {
    const urls: URL[] = []
    const f = (async (u: string) => {
      const url = new URL(u); urls.push(url)
      return url.searchParams.get('pageToken') ? json({ messages: [{ id: 'c' }] }) : json({ messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' })
    }) as unknown as typeof fetch
    const gmail = new GmailProvider({ accountId: 'a', getAccessToken: async () => 't', fetch: f, sleep: async () => {} })
    expect(await gmail.searchInbox('in:inbox category:promotions')).toEqual(['a', 'b', 'c'])
    expect(urls).toHaveLength(2)
    expect(urls.every((u) => u.pathname.endsWith('/messages'))).toBe(true) // never the per-message endpoint
    expect(urls[0].searchParams.get('q')).toBe('in:inbox category:promotions')
  })
})

describe('demo stand-in for Gmail search', () => {
  it('finds mail by the terms buildQuery produces', async () => {
    const d = new DemoProvider(120)
    const q = buildQuery({ category: 'promotions', olderThan: { value: 7, unit: 'd' } }, [{ type: 'archive' }])
    const ids = await d.searchInbox(q)
    const all = (await d.getMessages(await d.listInboxIds(false)))
    const matches = all.filter((m) => ids.includes(m.id))
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((m) => /sale|deal|%|discount/i.test(m.subject) && matchesGmailQuery(m, q))).toBe(true)
    expect(await d.searchInbox('in:inbox -label:inbox')).toEqual([])
  })
})

describe('run once and automatic cleanups', () => {
  const base = { id: 'r', name: 'Shop', filters: { from: 'deals@shopmart.example' }, actions: [{ type: 'trash' as const }] }

  it('does not allow both at once', () => {
    expect(validateCleanup({ ...base, runOnce: true, auto: true })).toContain('Choose either “run once” or “run automatically”, not both.')
    expect(validateCleanup({ ...base, runOnce: true })).toEqual([])
    expect(validateCleanup({ ...base, auto: true })).toEqual([])
  })

  it('does not allow an automatic Trash rule that could reach everyday mail', () => {
    const broad = { id: 'b', name: 'Old', filters: { olderThan: { value: 1, unit: 'y' as const } }, actions: [{ type: 'trash' as const }], allowBroad: true }
    expect(validateCleanup(broad)).toEqual([])
    expect(validateCleanup({ ...broad, auto: true }).join(' ')).toMatch(/Automatic cleanups can’t move everyday mail/)
    expect(validateCleanup({ ...broad, runOnce: true })).toEqual([]) // run once is still allowed, behind the typed confirmation
  })
})

describe('mailMove', () => {
  it('says where an action list moves mail', () => {
    expect(mailMove([{ type: 'trash' }])).toBe('trash')
    expect(mailMove([{ type: 'archive' }, { type: 'addLabel', label: 'x' }])).toBe('archive')
    expect(mailMove([{ type: 'trash' }, { type: 'archive' }])).toBe('trash')
    expect(mailMove([{ type: 'markRead' }, { type: 'addLabel', label: 'x' }])).toBeNull()
  })
})
