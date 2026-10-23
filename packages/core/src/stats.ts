import type { Category, MailMessage } from './types'

export interface SenderStat {
  email: string
  name: string
  count: number
  unread: number
  bytes: number
  hasUnsubscribe: boolean
  /** date of the newest message from this sender (ISO 8601) */
  lastDate: string
}

export interface Overview {
  total: number
  unread: number
  byCategory: Record<string, number>
  topSenders: SenderStat[]
  /** the most prolific senders with an unsubscribe option (at most `topN`) */
  subscriptions: SenderStat[]
  /** how many senders have an unsubscribe option in all */
  subscriptionCount: number
}

function tally(messages: MailMessage[]) {
  const senders = new Map<string, SenderStat>()
  const byCategory: Record<string, number> = {}
  let unread = 0

  for (const m of messages) {
    if (m.isUnread) unread++
    const cat: Category | 'uncategorized' = m.category ?? 'uncategorized'
    byCategory[cat] = (byCategory[cat] ?? 0) + 1

    const key = m.from.email.toLowerCase()
    const s = senders.get(key) ?? {
      email: key, name: m.from.name, count: 0, unread: 0, bytes: 0, hasUnsubscribe: false, lastDate: m.date,
    }
    s.count++
    s.bytes += m.sizeBytes
    if (m.isUnread) s.unread++
    if (m.listUnsubscribe) s.hasUnsubscribe = true
    if (m.date > s.lastDate) { s.lastDate = m.date; s.name = m.from.name || s.name } // the newest message has the name they use now
    senders.set(key, s)
  }
  return { senders, byCategory, unread }
}

/** Every sender in `messages`, busiest first. */
export function buildSenders(messages: MailMessage[]): SenderStat[] {
  return [...tally(messages).senders.values()].sort((a, b) => b.count - a.count || a.email.localeCompare(b.email))
}

export function buildOverview(messages: MailMessage[], topN = 10): Overview {
  const { senders, byCategory, unread } = tally(messages)
  const all = [...senders.values()].sort((a, b) => b.count - a.count)
  const subscriptions = all.filter((s) => s.hasUnsubscribe)
  return {
    total: messages.length,
    unread,
    byCategory,
    topSenders: all.slice(0, topN),
    subscriptions: subscriptions.slice(0, topN),
    subscriptionCount: subscriptions.length,
  }
}

export interface DuplicateGroup {
  /** the copy to keep: the newest */
  keep: MailMessage
  /** the others, which add nothing */
  extras: MailMessage[]
}

/**
 * Messages that look like the same one arriving more than once: same sender, subject and size, sent within the same
 * minute. Strict on purpose (a repeated subject like "Your receipt" a day apart is not a duplicate), since all that's
 * known about a message is its headers.
 */
export function findDuplicates(messages: MailMessage[]): DuplicateGroup[] {
  const groups = new Map<string, MailMessage[]>()
  for (const m of messages) {
    const key = [m.from.email.toLowerCase(), m.subject.trim(), m.sizeBytes, m.date.slice(0, 16)].join('\u0000')
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(m)
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const sorted = [...g].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
      return { keep: sorted[0], extras: sorted.slice(1) }
    })
}

export interface Subscription {
  email: string
  name: string
  count: number
  unread: number
  /** 0..1, share of this sender's scanned messages that were read */
  readRate: number
  lastDate: string
  /** raw List-Unsubscribe value from the newest message */
  listUnsubscribe: string
  oneClick: boolean
}

/** Senders that include a List-Unsubscribe header, most prolific first. */
export function buildSubscriptions(messages: MailMessage[]): Subscription[] {
  const bySender = new Map<string, Subscription>()
  for (const m of messages) {
    if (!m.listUnsubscribe) continue
    const key = m.from.email.toLowerCase()
    const cur = bySender.get(key)
    if (!cur) {
      bySender.set(key, {
        email: key, name: m.from.name, count: 1, unread: m.isUnread ? 1 : 0, readRate: 0,
        lastDate: m.date, listUnsubscribe: m.listUnsubscribe, oneClick: !!m.oneClickUnsubscribe,
      })
      continue
    }
    cur.count++
    if (m.isUnread) cur.unread++
    if (m.date > cur.lastDate) {
      cur.lastDate = m.date
      cur.listUnsubscribe = m.listUnsubscribe
      cur.oneClick = !!m.oneClickUnsubscribe
    }
  }
  return [...bySender.values()]
    .map((s) => ({ ...s, readRate: (s.count - s.unread) / s.count }))
    .sort((a, b) => b.count - a.count)
}
