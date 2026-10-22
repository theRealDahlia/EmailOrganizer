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

export interface StorageQuota {
  /** Total used across Gmail, Drive and Photos (what Gmail's footer shows) */
  usedBytes: number
  /** Absent for accounts with unlimited storage */
  limitBytes?: number
  driveBytes: number
  driveTrashBytes: number
}

/** Lets a long operation report that it is alive. */
export interface ScanHooks {
  /** Called with a running count (ids listed so far, or messages processed so far). */
  onProgress?: (count: number) => void
  /** Called when the service asked us to slow down and we are about to wait `ms` before retrying. */
  onWait?: (ms: number) => void
}

/** Everything the app needs from a mail service. Gmail, Graph and IMAP each implement this. */
export interface MailProvider {
  readonly id: string
  /** Identifies the mailbox (the email address; 'demo' for the demo mailbox). */
  readonly accountId: string
  listMessages(cursor?: string): Promise<MailPage>
  /** Ids of every inbox message, newest first. Cheap: no message content is fetched. */
  listInboxIds(unreadOnly: boolean, opts?: ScanHooks): Promise<string[]>
  /**
   * Fetches metadata for the given ids, keeping their order and skipping messages that no longer exist.
   * Stops early (returning what it has) when `signal` is aborted.
   */
  getMessages(ids: string[], opts?: ScanHooks & { signal?: AbortSignal }): Promise<MailMessage[]>
  applyActions(messageIds: string[], actions: MailAction[]): Promise<void>
  /** Account-wide storage; providers that can't report it omit this. */
  getStorageQuota?(): Promise<StorageQuota>
}
