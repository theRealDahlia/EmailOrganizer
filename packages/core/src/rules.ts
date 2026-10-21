import { CATEGORIES, type Category, type MailAction, type MailMessage } from './types'

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
      case 'trash':
        if (!message.labels.includes('TRASH')) undo.push({ type: 'removeLabel', label: 'TRASH' })
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

type FieldKind = 'text' | 'number' | 'boolean' | 'category'

/** What the rule editor offers for each condition field. */
export const CONDITION_SPECS: Record<Condition['field'], { label: string; ops: string[]; kind: FieldKind }> = {
  senderEmail: { label: 'Sender email', ops: ['equals', 'contains'], kind: 'text' },
  senderDomain: { label: 'Sender domain', ops: ['equals'], kind: 'text' },
  subject: { label: 'Subject', ops: ['contains'], kind: 'text' },
  category: { label: 'Category', ops: ['equals'], kind: 'category' },
  olderThanDays: { label: 'Older than (days)', ops: ['gte'], kind: 'number' },
  isUnread: { label: 'Is unread', ops: ['equals'], kind: 'boolean' },
}

const SYSTEM_LABELS = new Set([
  'INBOX', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
])

/** Returns human-readable problems; an empty list means the rule is safe to save. */
export function validateRule(rule: Rule): string[] {
  const problems: string[] = []
  if (!rule.name.trim()) problems.push('Give the rule a name.')
  if (rule.conditions.length === 0) problems.push('Add at least one condition.')
  if (rule.actions.length === 0) problems.push('Add at least one action.')

  for (const c of rule.conditions) {
    const spec = CONDITION_SPECS[c.field]
    if (!spec || !spec.ops.includes(c.op)) { problems.push(`Invalid condition: ${c.field}.`); continue }
    if (spec.kind === 'text' && !String(c.value).trim()) problems.push(`${spec.label} needs a value.`)
    if (spec.kind === 'number' && !(Number.isInteger(c.value) && (c.value as number) >= 0)) problems.push(`${spec.label} must be a whole number, 0 or more.`)
    if (spec.kind === 'category' && !CATEGORIES.includes(c.value as Category)) problems.push('Pick a category.')
    if (spec.kind === 'boolean' && typeof c.value !== 'boolean') problems.push(`${spec.label} must be yes or no.`)
  }

  for (const a of rule.actions) {
    if ((a.type === 'addLabel' || a.type === 'removeLabel') && !a.label.trim()) problems.push('Label actions need a label name.')
    if (a.type === 'addLabel' && SYSTEM_LABELS.has(a.label.trim().toUpperCase())) problems.push(`"${a.label}" is a built-in Gmail label; choose another name.`)
  }

  // A rule that trashes mail must not be able to match most of the inbox by accident.
  if (rule.actions.some((a) => a.type === 'trash')) {
    const narrow = (c: Condition) =>
      c.field === 'senderEmail' || c.field === 'senderDomain' || c.field === 'subject' ||
      (c.field === 'category' && c.value !== 'personal')
    const ok = rule.match === 'all' ? rule.conditions.some(narrow) : rule.conditions.every(narrow)
    if (rule.conditions.length > 0 && !ok) {
      problems.push(
        rule.match === 'all'
          ? 'Rules that move mail to Trash need a sender, domain, subject, or category condition so they can’t match your whole inbox.'
          : 'With “any”, every condition of a Trash rule must be a sender, domain, subject, or category condition.',
      )
    }
  }
  return problems
}
