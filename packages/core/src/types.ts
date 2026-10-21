export type Category =
  | 'newsletter'
  | 'promotion'
  | 'receipt'
  | 'travel'
  | 'social'
  | 'finance'
  | 'work'
  | 'personal'

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
  category?: Category
}

export type MailAction =
  | { type: 'addLabel'; label: string }
  | { type: 'archive' }
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
