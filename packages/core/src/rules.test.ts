import { describe, expect, it } from 'vitest'
import { DemoProvider, buildOverview, categorize, planChanges, ruleMatches } from './index'
import type { MailMessage } from './types'
import type { Rule } from './rules'

const NOW = Date.parse('2026-01-31T00:00:00Z')
const msg = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm1', accountId: 'a', from: { name: 'X', email: 'x@shop.example' }, subject: 'Hello',
  date: '2026-01-01T00:00:00Z', labels: ['INBOX'], isUnread: true, sizeBytes: 1, ...over,
})
const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1', name: 'R', enabled: true, match: 'all', conditions: [], actions: [{ type: 'archive' }], ...over,
})

describe('categorize', () => {
  it('detects categories from subject, domain, and unsubscribe header', () => {
    expect(categorize(msg({ subject: 'Your order receipt' }))).toBe('receipt')
    expect(categorize(msg({ from: { name: 'L', email: 'a@linkedin.com' } }))).toBe('social')
    expect(categorize(msg({ listUnsubscribe: '<mailto:u@x>' }))).toBe('newsletter')
    expect(categorize(msg())).toBe('personal')
  })
})

describe('rules', () => {
  it('matches all/any conditions', () => {
    const conds = [
      { field: 'senderDomain', op: 'equals', value: 'shop.example' },
      { field: 'olderThanDays', op: 'gte', value: 60 },
    ] as Rule['conditions']
    expect(ruleMatches(rule({ conditions: conds }), msg(), NOW)).toBe(false)
    expect(ruleMatches(rule({ conditions: conds, match: 'any' }), msg(), NOW)).toBe(true)
  })

  it('ignores disabled and empty rules', () => {
    expect(ruleMatches(rule({ enabled: false, conditions: [{ field: 'isUnread', op: 'equals', value: true }] }), msg(), NOW)).toBe(false)
    expect(ruleMatches(rule(), msg(), NOW)).toBe(false)
  })

  it('plans changes without mutating anything', async () => {
    const provider = new DemoProvider(20, NOW)
    const { messages } = await provider.listMessages()
    const r = rule({ conditions: [{ field: 'senderDomain', op: 'equals', value: 'shopmart.example' }] })
    const plan = planChanges([r], messages, NOW)
    expect(plan.length).toBeGreaterThan(0)
    expect((await provider.listMessages()).messages.every((m) => m.labels.includes('INBOX'))).toBe(true)
  })
})

describe('provider + overview', () => {
  it('applies actions and summarizes', async () => {
    const p = new DemoProvider(10, NOW)
    await p.applyActions(['demo-0'], [{ type: 'archive' }, { type: 'addLabel', label: 'X' }])
    const { messages } = await p.listMessages()
    expect(messages[0].labels).toEqual(['X'])
    const o = buildOverview(messages)
    expect(o.total).toBe(10)
    expect(o.topSenders[0].count).toBeGreaterThan(0)
  })
})
