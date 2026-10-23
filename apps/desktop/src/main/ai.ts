import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import { GMAIL_TABS, validateCleanup, type CleanupFilters, type CleanupRule, type MailAction } from '@organizer/core'
import type { AiRuleDraft } from '../shared'

export const AI_MODEL = 'claude-opus-5-5'
const MAX_SENTENCE = 500
const NOT_A_RULE = 'Couldn’t turn that into a rule. Try saying which mail it applies to and what to do with it.'

/** What Claude fills in. Flat and fully typed, so the answer is checked against this schema before the app looks at it. */
const Draft = z.object({
  name: z.string().describe('A short name for the rule, like "Landlord mail to Housing".'),
  category: z.enum(GMAIL_TABS).nullable().describe('Only when the user names a Gmail tab. Exactly one of: primary, social, promotions, updates, forums. Otherwise null.'),
  from: z.string().nullable().describe('A sender name, email address or domain, exactly as the user gave it.'),
  subject: z.string().nullable().describe('Words the subject must contain.'),
  olderThanValue: z.number().nullable(),
  olderThanUnit: z.enum(['d', 'm', 'y']).nullable().describe('Exactly one of: d (days), m (months), y (years). Null when there is no age.'),
  largerThanMB: z.number().nullable(),
  hasAttachment: z.boolean(),
  read: z.enum(['read', 'unread']).nullable().describe('Exactly one of: read, unread. Null when the user did not say.'),
  keepStarred: z.boolean().describe('True unless the user says starred mail may be touched.'),
  archive: z.boolean().describe('Take the mail out of the inbox.'),
  trash: z.boolean().describe('Move the mail to Trash. Only if the user clearly asks to delete or trash it.'),
  markRead: z.boolean(),
  label: z.string().nullable().describe('A Gmail label to add, if the user asks for one.'),
  note: z.string().describe('One plain sentence saying what the rule does, so the user can check it.'),
  cannot: z.string().nullable().describe('If the request cannot be made into a rule, one sentence saying why. Otherwise null.'),
})

const SYSTEM = `You turn one sentence about how a person wants their email handled into a rule for a mail-cleanup app.

You only ever see that one sentence: never any email, address book or account. Do not ask questions and do not assume anything about the person's mail. Fill in only what the sentence says.

How the rule works: it finds mail in the inbox with these filters (all must hold) and then does the chosen actions. "Move X to a label" means adding the label and archiving. Never choose trash unless the person clearly asks to delete or trash mail; archiving is the safe default for "get rid of", "clear out" and "hide".

If the sentence cannot be expressed with these filters and actions (for example "reply to my boss", "summarize my mail" or "forward invoices"), set "cannot" to one sentence explaining what the app can't do, and leave the rest empty.`

type Client = Pick<Anthropic, 'messages'>

/** Turns an Anthropic error into something a person can act on, without leaking request details. */
function friendly(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new Error('Anthropic rejected that API key. Check it in Account.')
  if (e instanceof Anthropic.RateLimitError) return new Error('Anthropic is rate limiting this key. Try again in a minute.')
  if (e instanceof Anthropic.APIConnectionError) return new Error('Couldn’t reach Anthropic. Check your internet connection and try again.')
  if (e instanceof Anthropic.BadRequestError) return new Error(`Anthropic couldn’t process that: ${e.message}`)
  if (e instanceof Anthropic.APIError) return new Error(`Anthropic returned an error (${e.status ?? 'unknown'}). Try again in a moment.`)
  // Anything else came from reading the answer back (a value outside the schema), not from the network.
  return new Error(NOT_A_RULE)
}

/**
 * Drafts a cleanup rule from a sentence. Opt-in: it needs the user's own Anthropic API key, and the only thing sent is
 * the sentence they typed. The result is a draft for the user to review in the normal rule form, never a saved rule.
 */
export class AiRules {
  constructor(
    private getKey: () => string | null,
    private makeClient: (apiKey: string) => Client = (apiKey) => new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 }),
  ) {}

  async draft(sentence: string): Promise<AiRuleDraft> {
    const key = this.getKey()
    if (!key) throw new Error('Add your Anthropic API key in Account to describe rules in plain English.')
    const text = sentence.replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('Describe what you want the rule to do.')
    if (text.length > MAX_SENTENCE) throw new Error(`Keep it to ${MAX_SENTENCE} characters or fewer.`)

    let response
    try {
      response = await this.makeClient(key).messages.parse({
        model: AI_MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: text }],
        output_config: { effort: 'low', format: zodOutputFormat(Draft) },
      })
    } catch (e) {
      throw friendly(e)
    }
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to draft that rule. Try wording it differently, or use the form.')
    const d = response.parsed_output
    if (!d) throw new Error(NOT_A_RULE)
    if (d.cannot) throw new Error(d.cannot)

    const filters: CleanupFilters = {}
    if (d.category) filters.category = d.category
    if (d.from?.trim()) filters.from = d.from.trim()
    if (d.subject?.trim()) filters.subject = d.subject.trim()
    if (d.olderThanValue && d.olderThanValue > 0 && d.olderThanUnit) filters.olderThan = { value: Math.floor(d.olderThanValue), unit: d.olderThanUnit }
    if (d.largerThanMB && d.largerThanMB > 0) filters.largerThanMB = Math.floor(d.largerThanMB)
    if (d.hasAttachment) filters.hasAttachment = true
    if (d.read) filters.read = d.read
    if (d.keepStarred) filters.keepStarred = true

    const actions: MailAction[] = []
    if (d.label?.trim()) actions.push({ type: 'addLabel', label: d.label.trim() })
    if (d.trash) actions.push({ type: 'trash' })
    else if (d.archive) actions.push({ type: 'archive' })
    if (d.markRead) actions.push({ type: 'markRead' })

    // Never allowBroad: a draft that could reach everyday mail is flagged, and the user decides in the form.
    const rule: CleanupRule = { id: 'draft', name: d.name.trim() || 'New rule', filters, actions }
    return { name: rule.name, filters, actions, note: d.note.trim(), warnings: validateCleanup(rule) }
  }
}
