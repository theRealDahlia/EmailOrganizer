export type Category =
  | 'newsletter'
  | 'promotion'
  | 'receipt'
  | 'travel'
  | 'social'
  | 'finance'
  | 'work'
  | 'personal'

export const CATEGORIES: Category[] = [
  'newsletter', 'promotion', 'receipt', 'travel', 'social', 'finance', 'work', 'personal',
]

export interface Address {
  name: string
  email: string
}

export interface MailMessage {
  id: string
  accountId: string
  from: Address
  subject: string
  date: string // ISO 8601
  labels: string[]
  isUnread: boolean
  sizeBytes: number
  listUnsubscribe?: string
  /** List-Unsubscribe-Post advertises RFC 8058 one-click unsubscribe */
  oneClickUnsubscribe?: boolean
  category?: Category
}

export type MailAction =
  | { type: 'addLabel'; label: string }
  | { type: 'archive' }
  /** Moves to Trash. Recoverable until Gmail empties Trash after 30 days; never a permanent delete. */
  | { type: 'trash' }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'removeLabel'; label: string }

export interface MailPage {
  messages: MailMessage[]
  nextCursor?: string
}

/** Everything the app needs from a mail service. Gmail, Graph and IMAP each implement this. */
export interface MailProvider {
  readonly id: string
  listMessages(cursor?: string): Promise<MailPage>
  applyActions(messageIds: string[], actions: MailAction[]): Promise<void>
}
