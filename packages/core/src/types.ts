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

/** Where an action sends mail: out of the inbox. Everything else leaves mail where it is. */
export type MailMove = 'trash' | 'archive'

/** Whether (and where) these actions move mail. Trash wins when a rule would do both. */
export function mailMove(actions: MailAction[]): MailMove | null {
  if (actions.some((a) => a.type === 'trash')) return 'trash'
  if (actions.some((a) => a.type === 'archive')) return 'archive'
  return null
}

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

/** What changed in the inbox since a checkpoint (net result per message). */
export interface InboxChanges {
  /** Checkpoint to store for next time */
  historyId: string
  /** id -> in the inbox now? Includes mail that arrived, was archived, trashed or deleted. */
  inbox: Map<string, boolean>
  /** id -> unread now? */
  unread: Map<string, boolean>
}

/** Inbox totals as the mail service counts them, so they need no scan. */
export interface InboxCounts {
  total: number
  unread: number
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
  /** Messages this provider can download per minute at its current pace, if it is rate limited. */
  readonly fetchesPerMinute?: number
  listMessages(cursor?: string): Promise<MailPage>
  /** A checkpoint for the mailbox as it is right now, for use with `listChanges`. Optional. */
  getHistoryId?(): Promise<string>
  /**
   * What changed in the inbox since `sinceHistoryId`, or null if that checkpoint is too old to use
   * (the caller must then list the inbox in full). Optional.
   */
  listChanges?(sinceHistoryId: string, hooks?: ScanHooks): Promise<InboxChanges | null>
  /**
   * Ids of inbox mail matching a Gmail search, newest first, found on Google's side without downloading
   * any message. Optional.
   */
  searchInbox?(query: string, hooks?: ScanHooks): Promise<string[]>
  /** Inbox message and unread totals, exact and immediate. Optional. */
  inboxCounts?(): Promise<InboxCounts>
  /** Inbox messages in each Gmail tab (primary, social, promotions, updates, forums), counted without downloading any. Optional. */
  tabCounts?(hooks?: ScanHooks): Promise<Record<string, number>>
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
