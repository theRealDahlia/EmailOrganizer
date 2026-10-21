import {
  buildOverview, buildSubscriptions, categorize, inverseActions, parseListUnsubscribe, planChanges, validateRule,
  type MailMessage, type MailProvider, type Rule, type Subscription, type UnsubscribeTargets,
} from '@organizer/core'
import type { ActivityEntry, PreviewResult } from '../shared'
import type { Store, UndoStep } from './db'

/** Cap on how much of the inbox is scanned per session (most recent first). */
const MAX_MESSAGES = 200

const DEFAULT_RULES: Rule[] = [
  {
    id: 'default-promos', name: 'Archive old promotions', enabled: true, match: 'all',
    conditions: [{ field: 'category', op: 'equals', value: 'promotion' }, { field: 'olderThanDays', op: 'gte', value: 14 }],
    actions: [{ type: 'addLabel', label: 'Promotions' }, { type: 'archive' }],
  },
  {
    id: 'default-receipts', name: 'Label receipts', enabled: true, match: 'all',
    conditions: [{ field: 'category', op: 'equals', value: 'receipt' }],
    actions: [{ type: 'addLabel', label: 'Receipts' }],
  },
]

/** App logic, kept independent of Electron so it can be tested and reused. */
export class OrganizerService {
  private cache: { provider: MailProvider; messages: MailMessage[] } | null = null

  constructor(private getProvider: () => MailProvider, private store: Store) {
    if (store.listRules().length === 0) DEFAULT_RULES.forEach((r) => store.saveRule(r))
  }

  /** Drop cached messages, e.g. after the account changes or mail is modified. */
  invalidate(): void {
    this.cache = null
  }

  private async messages(): Promise<MailMessage[]> {
    const provider = this.getProvider()
    if (this.cache?.provider === provider) return this.cache.messages

    const messages: MailMessage[] = []
    let cursor: string | undefined
    do {
      const page = await provider.listMessages(cursor)
      messages.push(...page.messages)
      cursor = page.nextCursor
    } while (cursor && messages.length < MAX_MESSAGES)

    const categorized = messages.map((m) => ({ ...m, category: categorize(m) }))
    this.cache = { provider, messages: categorized }
    return categorized
  }

  async overview(refresh = false) {
    if (refresh) this.invalidate()
    return buildOverview(await this.messages())
  }

  saveRule(rule: Rule): void {
    const problems = validateRule(rule)
    if (problems.length) throw new Error(problems.join(' '))
    this.store.saveRule(rule)
  }

  async subscriptions(): Promise<Subscription[]> {
    return buildSubscriptions(await this.messages())
  }

  /** Where an unsubscribe can be sent. Re-derived from scanned mail so the renderer can't supply URLs. */
  async unsubscribeTargets(senderEmail: string): Promise<UnsubscribeTargets & { oneClick: boolean }> {
    const sub = (await this.subscriptions()).find((s) => s.email === senderEmail.toLowerCase())
    if (!sub) throw new Error('No unsubscribe information for that sender.')
    return { ...parseListUnsubscribe(sub.listUnsubscribe), oneClick: sub.oneClick }
  }

  /** RFC 8058 one-click: a single POST, no cookies or credentials, redirects not followed. */
  async oneClickUnsubscribe(senderEmail: string): Promise<void> {
    const t = await this.unsubscribeTargets(senderEmail)
    if (!t.https || !t.oneClick) throw new Error('This sender does not support one-click unsubscribe.')
    const res = await fetch(t.https, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok && !(res.status >= 300 && res.status < 400)) throw new Error(`The sender's server refused the request (${res.status}).`)
  }

  createArchiveRule(senderEmail: string): Rule {
    const email = senderEmail.toLowerCase()
    const rule: Rule = {
      id: `archive-${email}`,
      name: `Archive mail from ${email}`,
      enabled: true,
      match: 'all',
      conditions: [{ field: 'senderEmail', op: 'equals', value: email }],
      actions: [{ type: 'addLabel', label: 'Subscriptions' }, { type: 'archive' }],
    }
    this.saveRule(rule)
    return rule
  }

  private requireRule(id: string): Rule {
    const rule = this.store.listRules().find((r) => r.id === id)
    if (!rule) throw new Error(`Unknown rule: ${id}`)
    return rule
  }

  async preview(ruleId: string): Promise<PreviewResult> {
    const messages = await this.messages()
    const changes = planChanges([this.requireRule(ruleId)], messages)
    const ids = new Set(changes.map((c) => c.messageId))
    return { changes, samples: messages.filter((m) => ids.has(m.id)).slice(0, 8) }
  }

  async apply(ruleId: string): Promise<ActivityEntry> {
    const rule = this.requireRule(ruleId)
    const messages = await this.messages()
    const byId = new Map(messages.map((m) => [m.id, m]))
    const changes = planChanges([rule], messages)

    const undo: UndoStep[] = []
    for (const c of changes) {
      const inverse = inverseActions(byId.get(c.messageId)!, c.actions)
      if (inverse.length) undo.push({ messageIds: [c.messageId], actions: inverse })
    }
    await this.getProvider().applyActions(changes.map((c) => c.messageId), rule.actions)
    this.invalidate()
    return this.store.addActivity(rule.name, changes.length, undo)
  }

  async undo(activityId: number): Promise<void> {
    const steps = this.store.takeUndo(activityId)
    if (!steps) throw new Error('Nothing to undo')
    for (const s of steps) await this.getProvider().applyActions(s.messageIds, s.actions)
    this.invalidate()
  }
}
