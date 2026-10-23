import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { AI_MODEL, AiRules } from './ai'

type Parsed = Record<string, unknown>
const base: Parsed = {
  name: 'Landlord mail to Housing', category: null, from: 'landlord@example.com', subject: null, olderThanValue: null, olderThanUnit: null,
  largerThanMB: null, hasAttachment: false, read: null, keepStarred: true, archive: true, trash: false, markRead: false, label: 'Housing',
  note: 'Adds the Housing label to mail from landlord@example.com and archives it.', cannot: null,
}

/** A stand-in for the SDK client that records what was sent and returns a canned answer (or throws). */
const fake = (answer: { parsed_output?: Parsed | null; stop_reason?: string } | Error) => {
  const calls: Record<string, unknown>[] = []
  const client = { messages: { parse: async (params: Record<string, unknown>) => { calls.push(params); if (answer instanceof Error) throw answer; return { stop_reason: 'end_turn', ...answer } } } }
  const rules = new AiRules(() => 'sk-ant-test-key-0000000000', () => client as never)
  return { calls, rules }
}
const apiError = (Class: unknown, status: number, message = 'x') => Object.assign(Object.create((Class as { prototype: object }).prototype), { status, message })

describe('plain-English rules', () => {
  it('turns a sentence into a reviewable rule', async () => {
    const { rules } = fake({ parsed_output: base })
    const draft = await rules.draft('Move anything from my landlord to a Housing label')
    expect(draft).toEqual({
      name: 'Landlord mail to Housing', filters: { from: 'landlord@example.com', keepStarred: true },
      actions: [{ type: 'addLabel', label: 'Housing' }, { type: 'archive' }],
      note: 'Adds the Housing label to mail from landlord@example.com and archives it.', warnings: [],
    })
  })

  it('sends only the sentence, on the right model, with the answer held to a schema', async () => {
    const { rules, calls } = fake({ parsed_output: base })
    await rules.draft('  Move anything   from my landlord\nto a Housing label ')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ model: AI_MODEL, messages: [{ role: 'user', content: 'Move anything from my landlord to a Housing label' }] })
    expect(calls[0].output_config).toMatchObject({ effort: 'low', format: expect.anything() })
    expect(JSON.stringify(calls[0])).not.toContain('sk-ant') // the key is the client's, never part of the request body
    expect(calls[0]).not.toHaveProperty('tools') // nothing else is offered
    expect(JSON.stringify(Object.keys(calls[0]).sort())).toBe(JSON.stringify(['max_tokens', 'messages', 'model', 'output_config', 'system']))
  })

  it('builds filters from every field, ignoring empty or nonsense values', async () => {
    const { rules } = fake({ parsed_output: { ...base, from: '  ', label: null, archive: false, trash: true, markRead: true, category: 'promotions', subject: 'sale', olderThanValue: 6.9, olderThanUnit: 'm', largerThanMB: 0, hasAttachment: true, read: 'unread' } })
    const draft = await rules.draft('trash old unread promo mail')
    expect(draft.filters).toEqual({ category: 'promotions', subject: 'sale', olderThan: { value: 6, unit: 'm' }, hasAttachment: true, read: 'unread', keepStarred: true })
    expect(draft.actions).toEqual([{ type: 'trash' }, { type: 'markRead' }])
    expect(draft.warnings).toEqual([])
  })

  it('flags a draft that could reach everyday mail instead of hiding it, and never allows it itself', async () => {
    const { rules } = fake({ parsed_output: { ...base, from: null, label: null, archive: false, trash: true, olderThanValue: 1, olderThanUnit: 'y' } })
    const draft = await rules.draft('delete everything older than a year')
    expect(draft.warnings.join(' ')).toMatch(/everyday mail/)
    expect(draft).not.toHaveProperty('allowBroad')
  })

  it('reports something the app cannot do, in the model’s own words', async () => {
    const { rules } = fake({ parsed_output: { ...base, cannot: 'The app can’t reply to email.' } })
    await expect(rules.draft('reply to my boss')).rejects.toThrow('The app can’t reply to email.')
  })

  it('needs a saved key, a sentence of sensible length, and says so', async () => {
    await expect(new AiRules(() => null, () => { throw new Error('should not be called') }).draft('x')).rejects.toThrow(/Add your Anthropic API key/)
    const { rules, calls } = fake({ parsed_output: base })
    await expect(rules.draft('   ')).rejects.toThrow('Describe what you want')
    await expect(rules.draft('a'.repeat(501))).rejects.toThrow('500 characters')
    expect(calls).toEqual([]) // nothing was sent for either
  })

  it('handles a refusal and an answer that did not parse', async () => {
    await expect(fake({ stop_reason: 'refusal', parsed_output: null }).rules.draft('x')).rejects.toThrow('declined')
    await expect(fake({ parsed_output: null }).rules.draft('x')).rejects.toThrow('Couldn’t turn that into a rule')
  })

  it('turns API failures into messages a person can act on', async () => {
    const msg = async (e: Error) => fake(e).rules.draft('x').then(() => '', (r: Error) => r.message)
    expect(await msg(apiError(Anthropic.AuthenticationError, 401))).toBe('Anthropic rejected that API key. Check it in Account.')
    expect(await msg(apiError(Anthropic.RateLimitError, 429))).toMatch(/rate limiting/)
    expect(await msg(apiError(Anthropic.BadRequestError, 400, 'credit balance too low'))).toContain('credit balance too low')
    expect(await msg(apiError(Anthropic.InternalServerError, 500))).toMatch(/error \(500\)/)
    expect(await msg(apiError(Anthropic.APIConnectionError, 0))).toMatch(/Couldn’t reach Anthropic/)
    expect(await msg(new Error('Invalid option: expected one of "primary"|"social"'))).toBe('Couldn’t turn that into a rule. Try saying which mail it applies to and what to do with it.') // a value outside the schema
  })
})
