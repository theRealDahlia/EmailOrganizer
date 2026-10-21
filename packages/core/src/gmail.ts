import { AuthExpiredError } from './oauth'
import type { Address, MailAction, MailMessage, MailPage, MailProvider } from './types'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const METADATA_HEADERS = ['From', 'Subject', 'List-Unsubscribe', 'List-Unsubscribe-Post']
const BATCH_MODIFY_LIMIT = 1000
const FETCH_CONCURRENCY = 4
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
  private labelsById = new Map<string, string>()
  private labelsByName = new Map<string, string>() // lower-case name -> id
  private labelsLoaded = false
  private fetchImpl: typeof fetch
  private sleep: (ms: number) => Promise<void>

  constructor(private opts: GmailProviderOptions) {
    this.fetchImpl = opts.fetch ?? fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  async getProfileEmail(): Promise<string> {
    const p = await this.request<{ emailAddress: string }>('/profile')
    return p.emailAddress
  }

  async listMessages(cursor?: string): Promise<MailPage> {
    await this.loadLabels()
    const q = new URLSearchParams({ maxResults: String(this.opts.pageSize ?? 100), labelIds: 'INBOX' })
    if (cursor) q.set('pageToken', cursor)
    const list = await this.request<{ messages?: { id: string }[]; nextPageToken?: string }>(`/messages?${q}`)

    const ids = (list.messages ?? []).map((m) => m.id)
    const messages: MailMessage[] = new Array(ids.length)
    let next = 0
    const worker = async () => {
      while (next < ids.length) {
        const i = next++
        messages[i] = this.toMessage(await this.getMetadata(ids[i]))
      }
    }
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker))
    return { messages, nextCursor: list.nextPageToken }
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

  private async getMetadata(id: string): Promise<GmailMessageResource> {
    const q = new URLSearchParams({ format: 'metadata' })
    METADATA_HEADERS.forEach((h) => q.append('metadataHeaders', h))
    return this.request<GmailMessageResource>(`/messages/${encodeURIComponent(id)}?${q}`)
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

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    let forceRefresh = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.getAccessToken(forceRefresh)
      const res = await this.fetchImpl(`${API}${path}`, {
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
          await this.sleep(Math.min(Math.max(retryAfter * 1000 || 0, 2000 * 2 ** attempt), 30_000))
          continue
        }
        throw new GmailApiError(res.status, rateLimited ? 'Gmail is rate limiting requests. Wait a minute and try again.' : message)
      }
      return (res.status === 204 ? undefined : await res.json()) as T
    }
  }
}
