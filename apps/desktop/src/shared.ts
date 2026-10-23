import type { CleanupRule, InboxCounts, MailMessage, Overview, PlannedChange, Rule, SenderStat, StorageQuota, Subscription } from '@organizer/core'

export interface ActivityEntry {
  id: number
  at: string
  ruleName: string
  messageCount: number
  undone: boolean
}

/** Overview of the scanned inbox, plus whether every inbox message was scanned. */
export type OverviewResult = Overview & {
  inboxTotal: number
  /** every inbox message has been scanned */
  complete: boolean
  /** a scan is running now; the figures cover only what has been scanned so far */
  scanning: boolean
  /** about how long downloading the rest of the inbox would take, when it isn't all scanned */
  fullScanMinutes?: number
}

export interface ScanProgress {
  phase: 'listing' | 'fetching' | 'done'
  /** listing: inbox ids found so far; fetching: inbox messages downloaded so far, including earlier scans */
  done: number
  /** listing: unused; fetching: inbox messages in total */
  total: number
  /** messages saved by earlier scans that this one did not need to download again */
  alreadyHad?: number
  /** mail that arrived since the last scan (only known when resuming from a checkpoint) */
  arrived?: number
  /** Google asked the app to slow down and it is waiting before retrying */
  throttled?: boolean
  /** epoch ms when this scan began, so the UI's clock survives tab switches */
  startedAt: number
  /** messages downloaded per minute: measured recently, or the provider's nominal pace at first */
  perMinute?: number
  /** resuming from a saved checkpoint: only checking for new mail, not recounting the inbox */
  resumed?: boolean
  /** the user pressed Stop; the scan is finishing its current step */
  stopping?: boolean
  /** downloading the whole inbox, rather than only the newest mail */
  full?: boolean
}

export type StorageResult =
  | { status: 'ok'; quota: StorageQuota }
  | { status: 'needsReconnect' }
  | { status: 'error'; message: string }

export interface CleanupPreview {
  /** the Gmail search that was run, shown so the user can see exactly what was asked */
  query: string
  count: number
  /** a few of the matching messages */
  samples: MailMessage[]
  /** total size of the matches: exact when few, otherwise extrapolated from a sample */
  bytes: number
  bytesAreEstimate: boolean
  sampled: number
}

/** Every sender found in the scanned mail, with how much of the inbox that covers. */
export interface SendersResult {
  senders: SenderStat[]
  /** inbox messages the counts are based on */
  scanned: number
  inboxTotal: number
  /** every inbox message has been scanned, so the counts are exact */
  complete: boolean
  scanning: boolean
  /** about how long downloading the rest of the inbox would take */
  fullScanMinutes?: number
}

/** One-click clean-ups for everything a single sender has in the inbox. */
export type SenderAction = 'archive' | 'markRead' | 'trash' | 'trashOlder'

/** How many inbox messages each `SenderAction` would change right now, counted by Gmail without downloading mail. */
export interface SenderSummary {
  email: string
  counts: Record<SenderAction, number>
  /** `trashOlder` keeps mail from the last month */
  olderThanMonths: number
}

export type UnsubscribeMethod = 'oneClick' | 'openLink' | 'openMail'

export interface PreviewResult {
  changes: PlannedChange[]
  samples: MailMessage[]
  /** Combined size of the distinct messages the rule would change (Gmail's size estimate). */
  totalBytes: number
  /** what the preview is based on; less than the whole inbox while a scan is running or after it was stopped */
  basis: { scanned: number; inboxTotal: number; complete: boolean; scanning: boolean }
}

export interface AccountStatus {
  mode: 'demo' | 'gmail'
  email?: string
  /** true when the app ships with its own Google client, so users never create one */
  bundledClient: boolean
  /** a usable client exists (bundled or user-supplied) */
  hasCredentials: boolean
  /** false when the OS keychain can't be used, in which case credentials can't be saved */
  secureStorage: boolean
}

/** The only surface the renderer can reach. Implemented in main, exposed through preload. */
export interface OrganizerApi {
  overview(refresh?: boolean): Promise<OverviewResult>
  /** Subscribe to scan progress; returns an unsubscribe function. */
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  /** Stop the current scan. What was scanned is kept and the next scan resumes from there. */
  cancelScan(): Promise<void>
  /** Download every inbox message, not just the newest. Call `overview()` afterwards to follow it. */
  scanFullInbox(): Promise<void>
  /** Exact inbox totals from the mail service, no scan needed; null if unavailable. */
  inboxCounts(): Promise<InboxCounts | null>
  /** Exact inbox mail per Gmail tab, no scan needed; null if unavailable. */
  tabCounts(): Promise<Record<string, number> | null>
  accountStatus(): Promise<AccountStatus>
  storage(): Promise<StorageResult>
  saveGoogleCredentials(clientId: string, clientSecret: string): Promise<void>
  connectGmail(): Promise<void>
  disconnect(): Promise<void>
  listRules(): Promise<Rule[]>
  cleanupRules(): Promise<CleanupRule[]>
  saveCleanupRule(rule: CleanupRule): Promise<void>
  deleteCleanupRule(id: string): Promise<void>
  /** Searches Gmail for the rule's matches; changes nothing. */
  previewCleanup(ruleId: string): Promise<CleanupPreview>
  /** Runs the rule on whatever Gmail finds now, unless far more matches than `expectedCount` appeared. */
  applyCleanup(ruleId: string, expectedCount: number, confirmation?: string): Promise<ActivityEntry>
  /** Every sender in the scanned mail, busiest first, for the Senders page. */
  senders(): Promise<SendersResult>
  /** What each one-click clean-up would change for this sender; found by Gmail search, no scan needed. */
  senderSummary(email: string): Promise<SenderSummary>
  /** Runs one of those clean-ups (undoable from Activity). Refuses if far more matches than `expectedCount` appeared. */
  cleanSender(email: string, action: SenderAction, expectedCount: number): Promise<ActivityEntry>
  /** Opens a search for this sender's inbox mail in Gmail, in the browser. */
  openInGmail(email: string): Promise<void>
  subscriptions(): Promise<Subscription[]>
  unsubscribe(senderEmail: string, method: UnsubscribeMethod): Promise<void>
  /** Creates (but does not run) a rule that archives everything from this sender. */
  createArchiveRule(senderEmail: string): Promise<Rule>
  saveRule(rule: Rule): Promise<void>
  deleteRule(id: string): Promise<void>
  preview(ruleId: string): Promise<PreviewResult>
  apply(ruleId: string): Promise<ActivityEntry>
  activity(): Promise<ActivityEntry[]>
  undo(activityId: number): Promise<void>
}
