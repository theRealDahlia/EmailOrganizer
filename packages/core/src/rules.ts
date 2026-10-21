import type { Category, MailAction, MailMessage } from './types'

export type Condition =
  | { field: 'senderEmail'; op: 'equals' | 'contains'; value: string }
  | { field: 'senderDomain'; op: 'equals'; value: string }
  | { field: 'subject'; op: 'contains'; value: string }
  | { field: 'category'; op: 'equals'; value: Category }
  | { field: 'olderThanDays'; op: 'gte'; value: number }
  | { field: 'isUnread'; op: 'equals'; value: boolean }

export interface Rule {
  id: string
  name: string
  enabled: boolean
  match: 'all' | 'any'
  conditions: Condition[]
  actions: MailAction[]
}

export interface PlannedChange {
  messageId: string
  ruleId: string
  ruleName: string
  actions: MailAction[]
}

const DAY_MS = 86_400_000

function check(c: Condition, m: MailMessage, now: number): boolean {
  switch (c.field) {
    case 'senderEmail': {
      const email = m.from.email.toLowerCase()
      const v = c.value.toLowerCase()
      return c.op === 'equals' ? email === v : email.includes(v)
    }
    case 'senderDomain':
      return m.from.email.toLowerCase().endsWith(`@${c.value.toLowerCase()}`)
    case 'subject':
      return m.subject.toLowerCase().includes(c.value.toLowerCase())
    case 'category':
      return m.category === c.value
    case 'olderThanDays':
      return (now - Date.parse(m.date)) / DAY_MS >= c.value
    case 'isUnread':
      return m.isUnread === c.value
  }
}

export function ruleMatches(rule: Rule, message: MailMessage, now = Date.now()): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false
  const test = (c: Condition) => check(c, message, now)
  return rule.match === 'all' ? rule.conditions.every(test) : rule.conditions.some(test)
}

/**
 * Dry run: works out what each rule would do without touching the mailbox.
 * Rules are applied in order; every matching rule contributes its actions.
 */
export function planChanges(rules: Rule[], messages: MailMessage[], now = Date.now()): PlannedChange[] {
  const planned: PlannedChange[] = []
  for (const message of messages) {
    for (const rule of rules) {
      if (ruleMatches(rule, message, now)) {
        planned.push({ messageId: message.id, ruleId: rule.id, ruleName: rule.name, actions: rule.actions })
      }
    }
  }
  return planned
}

/** Actions that restore `message` to its current state after `actions` have been applied. */
export function inverseActions(message: MailMessage, actions: MailAction[]): MailAction[] {
  const undo: MailAction[] = []
  for (const a of actions) {
    switch (a.type) {
      case 'archive':
        if (message.labels.includes('INBOX')) undo.push({ type: 'addLabel', label: 'INBOX' })
        break
      case 'markRead':
        if (message.isUnread) undo.push({ type: 'markUnread' })
        break
      case 'markUnread':
        if (!message.isUnread) undo.push({ type: 'markRead' })
        break
      case 'addLabel':
        if (!message.labels.includes(a.label)) undo.push({ type: 'removeLabel', label: a.label })
        break
      case 'removeLabel':
        if (message.labels.includes(a.label)) undo.push({ type: 'addLabel', label: a.label })
        break
    }
  }
  return undo
}
