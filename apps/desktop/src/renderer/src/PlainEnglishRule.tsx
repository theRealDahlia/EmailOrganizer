import { useEffect, useState, type FormEvent } from 'react'
import type { AiRuleDraft } from '../../shared'
import { Icon, hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

/** Describe a rule in a sentence. Produces a draft that opens in the normal form, so nothing happens without review. */
export function PlainEnglishRule({ onDraft, onGoToAccount }: { onDraft: (draft: AiRuleDraft) => void; onGoToAccount: () => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.aiStatus().then((s) => setConfigured(s.configured), () => setConfigured(false)) }, [])
  if (configured === null) return null

  if (!configured) {
    return (
      <p className="rule-alt">
        Want to describe rules in plain English? <button className="link-btn" onClick={onGoToAccount}>Add an Anthropic API key</button> (optional).
      </p>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true); setError(null)
    try { onDraft(await api.draftRule(text)); setText('') } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  return (
    <form className="card plain-english" style={hue(270)} onSubmit={submit}>
      <label htmlFor="plain-english">
        <b>Describe a rule</b> <span className="muted">in your own words. You’ll review it before it’s saved.</span>
      </label>
      <div className="pe-row">
        <input id="plain-english" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} disabled={busy}
          placeholder="e.g. Move anything from my landlord to a Housing label" autoComplete="off" />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}><Icon name="check" size={15} /> {busy ? 'Drafting…' : 'Draft rule'}</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      <span className="muted pe-privacy">Only this sentence is sent to Anthropic, never your mail.</span>
    </form>
  )
}
