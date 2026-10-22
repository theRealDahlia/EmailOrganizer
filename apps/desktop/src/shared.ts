import type { MailMessage, Overview, PlannedChange, Rule, StorageQuota, Subscription } from '@organizer/core'

export interface ActivityEntry {
  id: number
  at: string
  ruleName: string
  messageCount: number
  undone: boolean
}

export type StorageResult =
  | { status: 'ok'; quota: StorageQuota }
  | { status: 'needsReconnect' }
  | { status: 'error'; message: string }

export type UnsubscribeMethod = 'oneClick' | 'openLink' | 'openMail'

export interface PreviewResult {
  changes: PlannedChange[]
  samples: MailMessage[]
  /** Combined size of the distinct messages the rule would change (Gmail's size estimate). */
  totalBytes: number
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
  overview(refresh?: boolean): Promise<Overview>
  accountStatus(): Promise<AccountStatus>
  storage(): Promise<StorageResult>
  saveGoogleCredentials(clientId: string, clientSecret: string): Promise<void>
  connectGmail(): Promise<void>
  disconnect(): Promise<void>
  listRules(): Promise<Rule[]>
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
