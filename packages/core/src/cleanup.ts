import type { MailAction, MailMessage } from './types'

/** Gmail's own inbox tabs, which Gmail assigns itself (this is what `category:` searches). */
export const GMAIL_TABS = ['primary', 'social', 'promotions', 'updates', 'forums'] as const
export type GmailTab = (typeof GMAIL_TABS)[number]

export interface CleanupFilters {
  category?: GmailTab
  olderThan?: { value: number; unit: 'd' | 'm' | 'y' }
  largerThanMB?: number
  from?: string
  subject?: string
  hasAttachment?: boolean
  read?: 'unread' | 'read'
  /** Raw Gmail search terms, for anything the fields above can't say. Always kept inside the inbox. */
  extra?: string
  /** Leave starred mail alone */
  keepStarred?: boolean
  /** Leave mail Gmail marks important alone */
  keepImportant?: boolean
}

/**
 * A rule that finds mail with a Gmail search and acts on whatever matches, without downloading any of it.
 * Searching costs 5 quota units per 500 matches and acting costs 50 per 1,000, so a whole inbox takes seconds.
 */
export interface CleanupRule {
  id: string
  name: string
  filters: CleanupFilters
  actions: MailAction[]
  /**
   * The user knowingly allowed Trash on filters (like age alone) that can reach everyday mail.
   * Such rules also need a typed confirmation each time they run.
   */
  allowBroad?: boolean
  /** Runs one time, without a preview step, and is removed once it has run. */
  runOnce?: boolean
  /** Applied on its own, every so often while the app is open, with no preview step. Never with `runOnce`. */
  auto?: boolean
}

const UNIT_WORD = { d: 'day', m: 'month', y: 'year' } as const

/** Values go inside quotes or parentheses in the query, so remove anything that could break out of them. */
const clean = (v: string) => v.replace(/["(){}\\]/g, ' ').replace(/\s+/g, ' ').trim()

/** `extra` may use parentheses, but they must balance so it can't close the group we wrap it in. */
function balanced(s: string): boolean {
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** Gmail's search form of a label name: lower case, spaces become hyphens. */
export const labelSearchName = (label: string) => clean(label).toLowerCase().replace(/\s+/g, '-')

/**
 * The Gmail search for a rule. Always scoped to the inbox. The query also excludes mail the actions would
 * not change (already read, already labelled), so reversing the actions later is exact for every match.
 */
export function buildQuery(filters: CleanupFilters, actions: MailAction[]): string {
  const q = ['in:inbox']
  if (filters.category) q.push(`category:${filters.category}`)
  if (filters.olderThan && filters.olderThan.value > 0) q.push(`older_than:${Math.floor(filters.olderThan.value)}${filters.olderThan.unit}`)
  if (filters.largerThanMB && filters.largerThanMB > 0) q.push(`larger:${Math.floor(filters.largerThanMB)}M`)
  if (filters.from && clean(filters.from)) q.push(`from:(${clean(filters.from)})`)
  if (filters.subject && clean(filters.subject)) q.push(`subject:("${clean(filters.subject)}")`)
  if (filters.hasAttachment) q.push('has:attachment')
  if (filters.read === 'unread') q.push('is:unread')
  if (filters.read === 'read') q.push('is:read')
  if (filters.extra?.trim() && balanced(filters.extra)) q.push(`(${filters.extra.trim()})`)
  if (filters.keepStarred) q.push('-is:starred')
  if (filters.keepImportant) q.push('-is:important')

  if (actions.some((a) => a.type === 'markRead') && filters.read !== 'unread') q.push('is:unread')
  for (const a of actions) if (a.type === 'addLabel') q.push(`-label:${labelSearchName(a.label)}`)
  return q.join(' ')
}

/** What puts every matched message back as it was, valid because buildQuery only matches mail the actions change. */
export function reverseCleanupActions(actions: MailAction[]): MailAction[] {
  const undo: MailAction[] = []
  for (const a of actions) {
    if (a.type === 'archive') undo.push({ type: 'addLabel', label: 'INBOX' })
    if (a.type === 'trash') undo.push({ type: 'removeLabel', label: 'TRASH' }, { type: 'addLabel', label: 'INBOX' })
    if (a.type === 'markRead') undo.push({ type: 'markUnread' })
    if (a.type === 'addLabel') undo.push({ type: 'removeLabel', label: a.label })
  }
  return undo
}

/** Filters that pick out particular mail, as opposed to age or read state, which reach everyday mail too. */
function isNarrow(f: CleanupFilters): boolean {
  return !!((f.category && f.category !== 'primary') || f.from?.trim() || f.subject?.trim() || (f.largerThanMB ?? 0) >= 5)
}

/** A Trash rule whose filters could reach everyday mail, and so needs explicit opt-in and a typed confirmation. */
export function isBroadTrash(rule: Pick<CleanupRule, 'filters' | 'actions'>): boolean {
  return rule.actions.some((a) => a.type === 'trash') && !isNarrow(rule.filters)
}

const SYSTEM_LABELS = new Set(['INBOX', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'IMPORTANT', 'CHAT'])

export function validateCleanup(rule: CleanupRule): string[] {
  const problems: string[] = []
  const f = rule.filters
  if (!rule.name.trim()) problems.push('Give the rule a name.')
  if (rule.actions.length === 0) problems.push('Choose at least one action.')

  const narrowing = [f.category, f.olderThan?.value, f.largerThanMB, f.from?.trim(), f.subject?.trim(), f.hasAttachment, f.read, f.extra?.trim()]
  if (!narrowing.some(Boolean)) problems.push('Add at least one filter, or this would match your whole inbox.')
  if (f.olderThan && !(Number.isInteger(f.olderThan.value) && f.olderThan.value > 0)) problems.push('“Older than” needs a whole number above 0.')
  if (f.largerThanMB !== undefined && !(Number.isInteger(f.largerThanMB) && f.largerThanMB > 0)) problems.push('“Larger than” needs a whole number of MB above 0.')
  if (f.category && !GMAIL_TABS.includes(f.category)) problems.push('Pick a Gmail category.')
  if (f.extra && !balanced(f.extra)) problems.push('The advanced search has unbalanced parentheses.')

  for (const a of rule.actions) {
    if (a.type === 'addLabel') {
      if (!a.label.trim()) problems.push('Label actions need a label name.')
      else if (SYSTEM_LABELS.has(a.label.trim().toUpperCase())) problems.push(`“${a.label}” is a built-in Gmail label; choose another name.`)
    }
  }

  if (rule.runOnce && rule.auto) problems.push('Choose either “run once” or “run automatically”, not both.')
  // Nothing watches an automatic run, so it can't be allowed to reach everyday mail.
  if (rule.auto && isBroadTrash(rule)) {
    problems.push('Automatic cleanups can’t move everyday mail to Trash. Add a sender, subject, Promotions/Social/Updates/Forums tab, or a size of 5 MB or more.')
  }

  // Moving mail to Trash by age or read state alone can reach everyday mail, so it must be chosen knowingly.
  if (isBroadTrash(rule) && !rule.allowBroad) {
    problems.push('Moving mail to Trash by age or read state alone could reach everyday mail. If that is what you want, tick “Include everyday mail” below.')
  }
  return problems
}

/** Ready-made starting points shown in the app; none are saved or run until the user chooses them. */
export const CLEANUP_PRESETS: { name: string; blurb: string; filters: CleanupFilters; actions: MailAction[] }[] = [
  {
    name: 'Old promotions',
    blurb: 'Promotions tab mail older than a year goes to Trash.',
    filters: { category: 'promotions', olderThan: { value: 1, unit: 'y' }, keepStarred: true },
    actions: [{ type: 'trash' }],
  },
  {
    name: 'Old social notifications',
    blurb: 'Social tab mail older than 3 months goes to Trash.',
    filters: { category: 'social', olderThan: { value: 3, unit: 'm' }, keepStarred: true },
    actions: [{ type: 'trash' }],
  },
  {
    name: 'Big old attachments',
    blurb: 'Mail over 10 MB and older than 2 years goes to Trash, freeing the most space.',
    filters: { largerThanMB: 10, olderThan: { value: 2, unit: 'y' }, keepStarred: true },
    actions: [{ type: 'trash' }],
  },
  {
    name: 'Tidy old updates',
    blurb: 'Updates tab mail older than 6 months is archived, not deleted.',
    filters: { category: 'updates', olderThan: { value: 6, unit: 'm' }, keepStarred: true },
    actions: [{ type: 'archive' }],
  },
]

export function describeFilters(f: CleanupFilters): string {
  const parts: string[] = []
  if (f.category) parts.push(`in the ${f.category} tab`)
  if (f.olderThan) parts.push(`older than ${f.olderThan.value} ${UNIT_WORD[f.olderThan.unit]}${f.olderThan.value === 1 ? '' : 's'}`)
  if (f.largerThanMB) parts.push(`larger than ${f.largerThanMB} MB`)
  if (f.from) parts.push(`from ${f.from}`)
  if (f.subject) parts.push(`subject has “${f.subject}”`)
  if (f.hasAttachment) parts.push('with attachments')
  if (f.read) parts.push(f.read)
  if (f.keepStarred || f.keepImportant) parts.push(`keeping ${[f.keepStarred && 'starred', f.keepImportant && 'important'].filter(Boolean).join(' and ')} mail`)
  if (f.extra) parts.push(`matching ${f.extra}`)
  return parts.length ? `Mail ${parts.join(', ')}` : 'Any inbox mail'
}

/**
 * A small stand-in for Gmail's search, covering only the terms buildQuery produces. It lets the demo
 * mailbox and the tests exercise cleanup rules without Gmail. Real searching happens on Google's side.
 */
export function matchesGmailQuery(m: MailMessage, query: string, now = Date.now()): boolean {
  const tabOf = (): GmailTab => {
    const domain = m.from.email.split('@')[1] ?? ''
    if (/linkedin|facebook|twitter|instagram/.test(domain)) return 'social'
    if (m.listUnsubscribe && /sale|% off|deal|discount/i.test(m.subject)) return 'promotions'
    if (m.listUnsubscribe) return 'updates'
    return 'primary'
  }
  const days = (d: number, unit: string) => d * ({ d: 1, m: 30, y: 365 }[unit] ?? 1)
  const tokens = query.match(/-?[a-z_]+:\([^)]*\)|-?[a-z_]+:"[^"]*"|\([^)]*\)|\S+/gi) ?? []
  return tokens.every((t) => {
    const neg = t.startsWith('-')
    const [key, ...rest] = (neg ? t.slice(1) : t).split(':')
    const val = rest.join(':').replace(/^[("]|[)"]$/g, '')
    let ok: boolean
    switch (key) {
      case 'in': ok = val === 'inbox' ? m.labels.includes('INBOX') : false; break
      case 'is': ok = val === 'unread' ? m.isUnread : val === 'read' ? !m.isUnread : false; break
      case 'category': ok = tabOf() === val; break
      case 'after': ok = Date.parse(m.date) > Number(val) * 1000; break // epoch seconds, as Gmail takes them
      case 'older_than': {
        const mm = val.match(/^(\d+)([dmy])$/)
        ok = !!mm && (now - Date.parse(m.date)) / 86_400_000 > days(Number(mm[1]), mm[2])
        break
      }
      case 'larger': ok = m.sizeBytes > Number(val.replace(/M$/i, '')) * 1024 * 1024; break
      case 'from': ok = m.from.email.toLowerCase().includes(val.toLowerCase()) || m.from.name.toLowerCase().includes(val.toLowerCase()); break
      case 'subject': ok = m.subject.toLowerCase().includes(val.toLowerCase()); break
      case 'has': ok = false; break // the demo mailbox has no attachments
      case 'label': ok = m.labels.some((l) => l.toLowerCase().replace(/\s+/g, '-') === val.toLowerCase()); break
      default: ok = true // a bare parenthesised group (advanced search) isn't evaluated by the stand-in
    }
    return neg ? !ok : ok
  })
}
