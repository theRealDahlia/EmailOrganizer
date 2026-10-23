import type { CleanupFilters, CleanupRule, InboxCounts, MailAction, MailMessage, Overview, PlannedChange, Rule, SenderStat, StorageQuota, Subscription } from '@organizer/core'

/**
 * An automatic run won't move more than this many messages to Trash in one go. A bigger match is left for the
 * user to preview and apply, because nobody is watching an automatic run and a mistaken rule shouldn't empty an inbox.
 */
export const AUTO_TRASH_LIMIT = 2_000

/** Light, dark, or follow the operating system. */
export const THEME_PREFS = ['system', 'light', 'dark'] as const
export type ThemePref = (typeof THEME_PREFS)[number]

export interface ActivityEntry {
  id: number
  at: string
  ruleName: string
  messageCount: number
  undone: boolean
  /** a run-once cleanup finished and was removed */
  ruleRemoved?: boolean
  /** the saved rule or cleanup that made this change, when there was one */
  ruleId?: string
  /** about how much mail this moved, in bytes (from messages the app already knew the size of) */
  bytes?: number
  /** an automatic run made this change */
  automatic?: boolean
  /** where it sent the mail, if it moved any */
  move?: 'trash' | 'archive' | null
}

/** What the app has done for the user over a period. Undone changes are not counted. */
export interface ImpactTotals {
  /** messages archived, trashed, labelled or marked read by rules and clean-ups */
  messages: number
  /** about how much mail was moved to Trash, in bytes (Gmail frees the space once Trash is emptied) */
  bytesTrashed: number
  trashed: number
  archived: number
  /** messages handled by automatic runs */
  automatic: number
  runs: number
  unsubscribes: number
}

export interface ImpactSummary {
  month: ImpactTotals
  all: ImpactTotals
  /** every saved rule or cleanup's lifetime total, for showing "handled N messages" on its row */
  byRule: Record<string, { messages: number }>
}

/** Messages that look like the same one arriving more than once. Based on the scanned mail. */
export interface DuplicatesResult {
  /** how many extra copies could go, keeping the newest of each */
  count: number
  bytes: number
  groups: number
  examples: { from: string; subject: string; copies: number }[]
  scanned: number
  complete: boolean
}

/** Everything the user has set up, as a file they can keep, move to another computer or share. */
export interface RulesExport {
  app: 'email-organizer'
  version: 1
  exportedAt: string
  cleanupRules: CleanupRule[]
  rules: Rule[]
}

export interface ImportResult {
  added: number
  skipped: { name: string; reason: string }[]
}

/** A rule drafted from a sentence. Nothing is saved: the user reviews it in the normal rule form. */
export interface AiRuleDraft {
  name: string
  filters: CleanupFilters
  actions: MailAction[]
  /** the rule in one plain sentence, so the user can check it matches what they meant */
  note: string
  /** things the form will refuse to save as drafted (for example a Trash rule that is too broad) */
  warnings: string[]
}

/** A sender the user barely reads, offered as a candidate for an archive rule or an unsubscribe. */
export interface Suggestion {
  /** stable, so a dismissal sticks */
  id: string
  email: string
  name: string
  count: number
  unread: number
  hasUnsubscribe: boolean
  bytes: number
  /** the reason, in plain words */
  why: string
}

export interface SuggestionsResult {
  items: Suggestion[]
  /** inbox messages the suggestions are based on */
  scanned: number
  inboxTotal: number
  complete: boolean
}

/** One thing worth clearing to free storage, found with a Gmail search. */
export interface SpaceCandidate {
  id: string
  title: string
  blurb: string
  count: number
  /** about how much space these take: exact for a handful, otherwise worked out from a sample */
  bytes: number
  bytesAreEstimate: boolean
  /** the biggest few of the sampled messages, as examples */
  samples: { from: string; subject: string; date: string; sizeBytes: number }[]
}

export interface SpaceGuide {
  /** the account's storage (shared with Drive and Photos); null when Gmail can't report it */
  quota: { usedBytes: number; limitBytes?: number } | null
  /** biggest first */
  candidates: SpaceCandidate[]
}

export type UnsubscribeStatus = 'waiting' | 'worked' | 'still_sending'

/** An unsubscribe the user asked for, and whether the sender really stopped. */
export interface UnsubscribeRecord {
  email: string
  name: string
  /** ISO time the unsubscribe was sent or opened */
  at: string
  method: 'oneClick' | 'openLink' | 'openMail'
  status: UnsubscribeStatus
  checkedAt?: string
  /** the automatic archive cleanup made because they kept sending */
  ruleId?: string
}

/** What the background runner of automatic rules and cleanups has done and left for the user. */
export interface AutomationStatus {
  /** ISO time of the last automatic run, if there has been one this session */
  lastRunAt: string | null
  /** matches that were more than an automatic run will move, left for the user to preview and apply */
  needsReview: { id: string; name: string; count: number; kind: 'cleanup' | 'rule' }[]
  /** rules that couldn't run, with why */
  errors: { name: string; message: string; kind: 'cleanup' | 'rule' }[]
  /** how many automatic runs have changed mail so far this session */
  runs: number
  /** messages the last run changed, and a plain sentence about it ("Archived 212 messages and moved 30 to Trash"); empty when it changed none */
  lastChanged: number
  lastSummary: string
  /** ISO time the app last looked for new mail on its own, even if there was none */
  lastCheckedAt: string | null
  /** why the last check failed (offline, rate limited, signed out), or null if it worked; checks never show errors themselves */
  checkError: string | null
}

/** What the app keeps doing when its window is closed. All off until the user turns them on. */
export interface BackgroundPrefs {
  /** start when the user signs in to their computer */
  openAtLogin: boolean
  /** stay in the menu bar or tray after the window closes, so automatic rules keep running */
  keepRunning: boolean
  /** show a notification when an automatic run changed mail while the app wasn't in front */
  notify: boolean
}

export interface BackgroundState {
  prefs: BackgroundPrefs
  /** the operating system can start apps at login (macOS and Windows) */
  loginItemSupported: boolean
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
  /** The saved colour theme choice. */
  getTheme(): Promise<ThemePref>
  /** Saves the choice and applies it to every window straight away. Returns what was saved. */
  setTheme(theme: ThemePref): Promise<ThemePref>
  /** How many inbox messages a cleanup would change right now, found by Gmail search: no download, no preview. */
  cleanupCount(ruleId: string): Promise<{ count: number; query: string }>
  /** Extra copies of the same message, found in the scanned mail. */
  duplicates(): Promise<DuplicatesResult>
  /** Moves the extra copies to Trash (undoable), keeping the newest of each. */
  trashDuplicates(expectedCount: number): Promise<ActivityEntry>
  getBackground(): Promise<BackgroundState>
  /** Changes what runs in the background, takes effect straight away, and returns the new state. */
  setBackground(prefs: Partial<BackgroundPrefs>): Promise<BackgroundState>
  /** Saves every rule and cleanup to a file the user picks. Null if they cancel. */
  exportRules(): Promise<{ path: string; count: number } | null>
  /** Adds the rules from a file the user picks. Imported rules are never automatic or run-once. Null if they cancel. */
  importRules(): Promise<ImportResult | null>
  /** Whether an Anthropic API key is saved, which switches on plain-English rules. */
  aiStatus(): Promise<{ configured: boolean }>
  saveAiKey(key: string): Promise<void>
  removeAiKey(): Promise<void>
  /** Drafts a rule from a sentence. Only that sentence leaves the computer. Throws a readable message on failure. */
  draftRule(sentence: string): Promise<AiRuleDraft>
  /** Senders the user barely reads, with the reason. Based on the scanned mail. */
  suggestions(): Promise<SuggestionsResult>
  /** Hides a suggestion for good. */
  dismissSuggestion(id: string): Promise<void>
  /** Creates an automatic cleanup that archives this sender's mail, and starts it. Safe: archiving is undoable. */
  autoArchiveSender(email: string): Promise<void>
  /** What is worth clearing to free space, biggest first. Found by Gmail search, so it covers the whole inbox. */
  spaceGuide(): Promise<SpaceGuide>
  /** Moves one candidate's mail to Trash (undoable). Refuses if far more matches than `expectedCount` appeared. */
  cleanSpace(id: string, expectedCount: number): Promise<ActivityEntry>
  /** What the app has done, this month and all time, and what each rule has handled. */
  impact(): Promise<ImpactSummary>
  /** Unsubscribes the user has sent, and whether each sender stopped. */
  unsubscribeStatus(): Promise<UnsubscribeRecord[]>
  /** What automatic rules and cleanups have done, and what they left for review. */
  automation(): Promise<AutomationStatus>
  /** Runs every automatic rule and cleanup now instead of waiting for the next scheduled run. */
  runAutomaticNow(): Promise<AutomationStatus>
  /** Called after an automatic run that changed mail; returns an unsubscribe function. */
  onAutomaticRun(cb: (status: AutomationStatus) => void): () => void
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
