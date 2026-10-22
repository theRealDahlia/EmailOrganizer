import type { CleanupRule, MailMessage, Overview, PlannedChange, Rule, StorageQuota, Subscription } from '@organizer/core'

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
}

export interface ScanProgress {
  phase: 'listing' | 'fetching' | 'done'
  /** listing: inbox ids found so far; fetching: new messages downloaded so far */
  done: number
  /** new messages to download in total (already-cached ones are not counted) */
  total: number
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
  applyCleanup(ruleId: string, expectedCount: number): Promise<ActivityEntry>
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
