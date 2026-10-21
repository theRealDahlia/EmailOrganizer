import type { Category, MailMessage } from './types'

export interface SenderStat {
  email: string
  name: string
  count: number
  unread: number
  bytes: number
  hasUnsubscribe: boolean
}

export interface Overview {
  total: number
  unread: number
  byCategory: Record<string, number>
  topSenders: SenderStat[]
  subscriptions: SenderStat[]
}

export function buildOverview(messages: MailMessage[], topN = 10): Overview {
  const senders = new Map<string, SenderStat>()
  const byCategory: Record<string, number> = {}
  let unread = 0

  for (const m of messages) {
    if (m.isUnread) unread++
    const cat: Category | 'uncategorized' = m.category ?? 'uncategorized'
    byCategory[cat] = (byCategory[cat] ?? 0) + 1

    const key = m.from.email.toLowerCase()
    const s = senders.get(key) ?? {
      email: key, name: m.from.name, count: 0, unread: 0, bytes: 0, hasUnsubscribe: false,
    }
    s.count++
    s.bytes += m.sizeBytes
    if (m.isUnread) s.unread++
    if (m.listUnsubscribe) s.hasUnsubscribe = true
    senders.set(key, s)
  }

  const all = [...senders.values()].sort((a, b) => b.count - a.count)
  return {
    total: messages.length,
    unread,
    byCategory,
    topSenders: all.slice(0, topN),
    subscriptions: all.filter((s) => s.hasUnsubscribe).slice(0, topN),
  }
}
