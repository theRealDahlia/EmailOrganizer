import { applyActionsToMessage } from './rules'
import type { ScanHooks, MailAction, MailMessage, MailPage, MailProvider, StorageQuota } from './types'

const SENDERS = [
  { name: 'Daily Digest', email: 'news@dailydigest.example', subject: 'Your morning briefing', unsub: true },
  { name: 'ShopMart', email: 'deals@shopmart.example', subject: 'Flash sale: 40% off everything', unsub: true },
  { name: 'ShopMart Orders', email: 'orders@shopmart.example', subject: 'Your order has shipped', unsub: false },
  { name: 'SkyAir', email: 'bookings@skyair.example', subject: 'Your flight itinerary', unsub: false },
  { name: 'LinkedIn', email: 'notifications@linkedin.com', subject: 'You appeared in 5 searches', unsub: true },
  { name: 'First Bank', email: 'alerts@firstbank.example', subject: 'Your statement is ready', unsub: false },
  { name: 'Sam Rivera', email: 'sam@work.example', subject: 'Re: Q3 planning', unsub: false },
  { name: 'Mom', email: 'mom@family.example', subject: 'Dinner Sunday?', unsub: false },
]

/** Deterministic fake mailbox so the app is fully usable without Google credentials. */
export class DemoProvider implements MailProvider {
  readonly id = 'demo'
  readonly accountId: string = 'demo'
  private messages: MailMessage[]

  constructor(count = 300, now = Date.now()) {
    this.messages = Array.from({ length: count }, (_, i) => {
      const s = SENDERS[(i * 7 + (i % 3)) % SENDERS.length]
      return {
        id: `demo-${i}`,
        accountId: 'demo',
        from: { name: s.name, email: s.email },
        subject: s.subject,
        date: new Date(now - i * 6 * 3_600_000).toISOString(),
        labels: ['INBOX'],
        isUnread: i % 4 !== 0,
        sizeBytes: 8_000 + ((i * 7919) % 90_000),
        listUnsubscribe: s.unsub
          ? `<https://${s.email.split('@')[1]}/unsubscribe>, <mailto:unsub@${s.email.split('@')[1]}>`
          : undefined,
        oneClickUnsubscribe: s.unsub && s.email.startsWith('news@'),
      }
    })
  }

  async getStorageQuota(): Promise<StorageQuota> {
    const GB = 1024 ** 3
    return { usedBytes: 10.8 * GB, limitBytes: 15 * GB, driveBytes: 2.1 * GB, driveTrashBytes: 0.2 * GB }
  }

  async listMessages(): Promise<MailPage> {
    return { messages: this.messages.map((m) => ({ ...m, labels: [...m.labels] })) }
  }

  async listInboxIds(unreadOnly: boolean, _hooks?: ScanHooks): Promise<string[]> {
    return this.messages.filter((m) => m.labels.includes('INBOX') && (!unreadOnly || m.isUnread)).map((m) => m.id)
  }

  async getMessages(ids: string[], _opts?: ScanHooks & { signal?: AbortSignal }): Promise<MailMessage[]> {
    const byId = new Map(this.messages.map((m) => [m.id, m]))
    return ids.flatMap((id) => (byId.has(id) ? [{ ...byId.get(id)!, labels: [...byId.get(id)!.labels] }] : []))
  }

  async applyActions(ids: string[], actions: MailAction[]): Promise<void> {
    const set = new Set(ids)
    this.messages = this.messages.map((m) => (set.has(m.id) ? applyActionsToMessage(m, actions) : m))
  }
}
