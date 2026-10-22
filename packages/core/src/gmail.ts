import { AuthExpiredError } from './oauth'
import { StorageScopeError, parseStorageQuota } from './storage'
import type { Address, InboxChanges, MailAction, ScanHooks, MailMessage, MailPage, MailProvider, StorageQuota } from './types'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const METADATA_HEADERS = ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post']
const DRIVE_ABOUT = 'https://www.googleapis.com/drive/v3/about'
const BATCH_MODIFY_LIMIT = 1000
const FETCH_CONCURRENCY = 2
/**
 * Gmail's per-user limit is 6,000 quota units per minute and messages.get costs 20 units
 * (https://developers.google.com/workspace/gmail/api/reference/quota), so at most 300 fetches a minute.
 * Pace at about 90% of that, leaving room for the listing and label calls that share the budget.
 */
const BASE_FETCH_INTERVAL_MS = 222
const MAX_FETCH_INTERVAL_MS = 2000
const LIST_PAGE_SIZE = 500
const MAX_INBOX_IDS = 500_000
const MAX_SEARCH_RESULTS = 200_000
const MAX_RETRIES = 5

export class GmailApiError extends Error {
  constructor(public status: number, message: string) {
    super(`Gmail API error ${status}: ${message}`)
    this.name = 'GmailApiError'
  }
}

export function parseAddress(raw: string): Address {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) {
    const email = m[2].trim()
    return { name: m[1].trim() || email, email }
  }
  const email = raw.trim()
  return { name: email, email }
}

interface HistoryMessage { id: string; labelIds?: string[] }
interface HistoryRecord {
  messagesAdded?: { message: HistoryMessage }[]
  messagesDeleted?: { message: HistoryMessage }[]
  labelsAdded?: { message: HistoryMessage; labelIds?: string[] }[]
  labelsRemoved?: { message: HistoryMessage; labelIds?: string[] }[]
}

/** Folds history records (oldest first) into the net inbox and unread state of every message they mention. */
export function reduceHistory(records: HistoryRecord[]): Pick<InboxChanges, 'inbox' | 'unread'> {
  const inbox = new Map<string, boolean>()
  const unread = new Map<string, boolean>()
  for (const r of records) {
    for (const { message: m } of r.messagesAdded ?? []) {
      inbox.set(m.id, !!m.labelIds?.includes('INBOX'))
      unread.set(m.id, !!m.labelIds?.includes('UNREAD'))
    }
    for (const { message: m } of r.messagesDeleted ?? []) inbox.set(m.id, false)
    for (const { message: m, labelIds = [] } of r.labelsAdded ?? []) {
      if (labelIds.includes('INBOX')) inbox.set(m.id, true)
      if (labelIds.includes('TRASH') || labelIds.includes('SPAM')) inbox.set(m.id, false)
      if (labelIds.includes('UNREAD')) unread.set(m.id, true)
    }
    for (const { message: m, labelIds = [] } of r.labelsRemoved ?? []) {
      if (labelIds.includes('INBOX')) inbox.set(m.id, false)
      if (labelIds.includes('UNREAD')) unread.set(m.id, false)
    }
  }
  return { inbox, unread }
}

interface GmailLabel { id: string; name: string; type?: string }
interface GmailMessageResource {
  id: string
  labelIds?: string[]
  sizeEstimate?: number
  internalDate?: string
  payload?: { headers?: { name: string; value: string }[] }
}

export interface GmailProviderOptions {
  accountId: string
  /** Returns a valid access token; `forceRefresh` is set after a 401. */
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  fetch?: typeof fetch
  pageSize?: number
  sleep?: (ms: number) => Promise<void>
}

export class GmailProvider implements MailProvider {
  readonly id = 'gmail'

  get accountId(): string {
    return this.opts.accountId
  }

  /** Current download pace; drops if Google pushes back, so the caller can show an honest estimate. */
  get fetchesPerMinute(): number {
    return Math.floor(60_000 / this.fetchIntervalMs)
  }

  private labelsById = new Map<string, string>()
  private labelsByName = new Map<string, string>() // lower-case name -> id
  private labelsLoaded = false
  private fetchImpl: typeof fetch
  private sleep: (ms: number) => Promise<void>
  private nextFetchAt = 0
  private fetchIntervalMs = BASE_FETCH_INTERVAL_MS
  private successStreak = 0

  constructor(private opts: GmailProviderOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async getProfileEmail(): Promise<string> {
    const p = await this.request<{ emailAddress: string }>('/profile')
    return p.emailAddress
  }

  /** The mailbox's current history id: a checkpoint for `listChanges`. Costs 1 quota unit. */
  async getHistoryId(): Promise<string> {
    return (await this.request<{ historyId: string }>('/profile')).historyId
  }

  /**
   * What changed in the inbox since a checkpoint (history.list: 2 units a page, versus relisting the whole
   * inbox). Returns null when Google no longer has history that far back, so the caller must relist.
   */
  async listChanges(sinceHistoryId: string, hooks: ScanHooks = {}): Promise<InboxChanges | null> {
    const records: HistoryRecord[] = []
    let historyId = sinceHistoryId
    let pageToken: string | undefined
    try {
      do {
        const q = new URLSearchParams({ startHistoryId: sinceHistoryId, maxResults: '500' })
        for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) q.append('historyTypes', t)
        if (pageToken) q.set('pageToken', pageToken)
        const page = await this.request<{ history?: HistoryRecord[]; nextPageToken?: string; historyId?: string }>(`/history?${q}`, {}, hooks.onWait)
        records.push(...(page.history ?? []))
        historyId = page.historyId ?? historyId
        pageToken = page.nextPageToken
      } while (pageToken)
    } catch (e) {
      if (e instanceof GmailApiError && e.status === 404) return null // checkpoint expired: a full sync is needed
      throw e
    }
    return { historyId, ...reduceHistory(records) }
  }

  /** Reads the account's storage quota via the Drive API (the same figure Gmail's footer shows). */
  async getStorageQuota(): Promise<StorageQuota> {
    try {
      return parseStorageQuota(await this.request<unknown>(`${DRIVE_ABOUT}?fields=storageQuota`))
    } catch (e) {
      if (e instanceof GmailApiError && e.status === 403 && /insufficient/i.test(e.message)) throw new StorageScopeError()
      throw e
    }
  }

  async listMessages(cursor?: string): Promise<MailPage> {
    await this.loadLabels()
    const q = new URLSearchParams({ maxResults: String(this.opts.pageSize ?? 100), labelIds: 'INBOX' })
    if (cursor) q.set('pageToken', cursor)
    const list = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`)
    const messages = await this.getMessages((list.messages ?? []).map((m) => m.id))
    return { messages, nextCursor: list.nextPageToken }
  }

  /** messages.list with a search query: 5 units per 500 matches, and nothing is downloaded. */
  async searchInbox(query: string, hooks: ScanHooks = {}): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({ maxResults: String(LIST_PAGE_SIZE), q: query })
      if (pageToken) q.set('pageToken', pageToken)
      const page = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`, {}, hooks.onWait)
      for (const m of page.messages ?? []) ids.push(m.id)
      hooks.onProgress?.(ids.length)
      pageToken = page.nextPageToken
    } while (pageToken && ids.length < MAX_SEARCH_RESULTS)
    return ids
  }

  async listInboxIds(unreadOnly: boolean, hooks: ScanHooks = {}): Promise<string[]> {
    const ids: string[] = []
    let pageToken: string | undefined
    do {
      const q = new URLSearchParams({ maxResults: String(LIST_PAGE_SIZE) })
      q.append('labelIds', 'INBOX')
      if (unreadOnly) q.append('labelIds', 'UNREAD')
      if (pageToken) q.set('pageToken', pageToken)
      const page = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`, {}, hooks.onWait)
      for (const m of page.messages ?? []) ids.push(m.id)
      hooks.onProgress?.(ids.length)
      pageToken = page.nextPageToken
    } while (pageToken && ids.length < MAX_INBOX_IDS)
    return ids
  }

  async getMessages(ids: string[], opts: ScanHooks & { signal?: AbortSignal } = {}): Promise<MailMessage[]> {
    await this.loadLabels()
    const out: (MailMessage | undefined)[] = new Array(ids.length)
    let next = 0
    let processed = 0
    const worker = async () => {
      while (next < ids.length && !opts.signal?.aborted) {
        const i = next++
        try {
          await this.throttleFetch()
          out[i] = this.toMessage(await this.getMetadata(ids[i], opts.onWait))
        } catch (e) {
          if (!(e instanceof GmailApiError && e.status === 404)) throw e // a 404 means deleted since it was listed
        }
        opts.onProgress?.(++processed)
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker))
    return out.filter((m): m is MailMessage => m !== undefined)
  }

  /** Spaces message fetches out so a full-inbox scan stays inside Gmail's per-minute quota. */
  private async throttleFetch(): Promise<void> {
    const now = Date.now()
    const start = Math.max(now, this.nextFetchAt)
    this.nextFetchAt = start + this.fetchIntervalMs
    if (start > now) await this.sleep(start - now)
  }

  /** Google said slow down: make every in-flight fetch wait, and pace more gently from now on. */
  private noteRateLimited(waitMs: number): void {
    this.nextFetchAt = Math.max(this.nextFetchAt, Date.now() + waitMs)
    this.fetchIntervalMs = Math.min(Math.round(this.fetchIntervalMs * 1.5), MAX_FETCH_INTERVAL_MS)
    this.successStreak = 0
  }

  /** After a long clean run, creep back toward the normal pace. */
  private noteSuccess(): void {
    if (this.fetchIntervalMs > BASE_FETCH_INTERVAL_MS && ++this.successStreak >= 100) {
      this.fetchIntervalMs = Math.max(BASE_FETCH_INTERVAL_MS, Math.round(this.fetchIntervalMs / 1.1))
      this.successStreak = 0
    }
  }

  async applyActions(messageIds: string[], actions: MailAction[]): Promise<void> {
    if (messageIds.length === 0 || actions.length === 0) return
    await this.loadLabels()
    const add = new Set<string>()
    const remove = new Set<string>()
    const setLabel = (id: string, on: boolean) => {
      ;(on ? add : remove).add(id)
      ;(on ? remove : add).delete(id) // later actions win
    }

    for (const a of actions) {
      switch (a.type) {
        case 'archive': setLabel('INBOX', false); break
        case 'trash': setLabel('TRASH', true); setLabel('INBOX', false); break
        case 'markRead': setLabel('UNREAD', false); break
        case 'markUnread': setLabel('UNREAD', true); break
        case 'addLabel': setLabel(await this.ensureLabel(a.label), true); break
        case 'removeLabel': {
          const id = this.labelsByName.get(a.label.toLowerCase())
          if (id) setLabel(id, false)
          break
        }
      }
    }

    for (let i = 0; i < messageIds.length; i += BATCH_MODIFY_LIMIT) {
      await this.request('/messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({
          ids: messageIds.slice(i, i + BATCH_MODIFY_LIMIT),
          addLabelIds: [...add],
          removeLabelIds: [...remove],
        }),
      })
    }
  }

  private async loadLabels(): Promise<void> {
    if (this.labelsLoaded) return
    const { labels = [] } = await this.request<{ labels?: GmailLabel[] }>('/labels')
    labels.forEach((l) => this.rememberLabel(l))
    this.labelsLoaded = true
  }

  private rememberLabel(l: GmailLabel) {
    this.labelsById.set(l.id, l.name)
    this.labelsByName.set(l.name.toLowerCase(), l.id)
  }

  private async ensureLabel(name: string): Promise<string> {
    const existing = this.labelsByName.get(name.toLowerCase())
    if (existing) return existing
    const created = await this.request<GmailLabel>('/labels', {
      method: 'POST',
      body: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
    })
    this.rememberLabel(created)
    return created.id
  }

  private async getMetadata(id: string, onWait?: (ms: number) => void): Promise<GmailMessageResource> {
    const q = new URLSearchParams({ format: 'metadata' })
    METADATA_HEADERS.forEach((h) => q.append('metadataHeaders', h))
    return this.request<GmailMessageResource>(`/messages/${encodeURIComponent(id)}?${q}`, {}, onWait)
  }

  private toMessage(r: GmailMessageResource): MailMessage {
    const header = (name: string) =>
      r.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
    const ids = r.labelIds ?? []
    return {
      id: r.id,
      accountId: this.opts.accountId,
      from: parseAddress(header('From') ?? 'unknown'),
      subject: header('Subject') ?? '(no subject)',
      date: new Date(Number(r.internalDate ?? 0)).toISOString(),
      labels: ids.map((id) => this.labelsById.get(id) ?? id).filter((n) => n !== 'UNREAD'),
      isUnread: ids.includes('UNREAD'),
      sizeBytes: r.sizeEstimate ?? 0,
      listUnsubscribe: header('List-Unsubscribe'),
      oneClickUnsubscribe: /one-click/i.test(header('List-Unsubscribe-Post') ?? ''),
    }
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, onWait?: (ms: number) => void): Promise<T> {
    let forceRefresh = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.getAccessToken(forceRefresh)
      const res = await this.fetchImpl(path.startsWith('https://') ? path : `${API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
      })

      if (res.status === 401 && !forceRefresh) { forceRefresh = true; continue }
      if (res.status === 401) throw new AuthExpiredError()
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } }
        const message = body.error?.message ?? res.statusText
        const reasons = body.error?.errors?.map((e) => e.reason ?? '') ?? []
        // Gmail reports per-user rate limits as 403 (not only 429); back off and retry those too.
        const rateLimited =
          res.status === 429 ||
          (res.status === 403 && (reasons.some((r) => /ratelimit/i.test(r)) || /quota exceeded|rate limit/i.test(message)))
        if ((rateLimited || res.status >= 500) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get('Retry-After'))
          const wait = Math.min(Math.max(retryAfter * 1000 || 0, 2000 * 2 ** attempt), 30_000)
          this.noteRateLimited(wait)
          onWait?.(wait)
          await this.sleep(wait)
          continue
        }
        throw new GmailApiError(res.status, rateLimited ? 'Gmail is rate limiting requests. Wait a minute and try again.' : message)
      }
      this.noteSuccess()
      return (res.status === 204 ? undefined : await res.json()) as T
    }
  }
}
