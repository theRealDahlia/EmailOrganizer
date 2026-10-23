import { useEffect, useState } from 'react'
import { Icon, hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

/** Opt-in switch for plain-English rules: the user's own Anthropic API key, kept encrypted in the system keychain. */
export function AiKeyCard({ secureStorage }: { secureStorage: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () => api.aiStatus().then((s) => setConfigured(s.configured), () => setConfigured(false))
  useEffect(() => { load() }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn(); setKey(''); await load() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  if (configured === null) return null
  return (
    <section className="card" style={{ marginTop: 16, ...hue(270) }}>
      <h2>Plain-English rules <span className="pill scanned">Optional</span></h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Describe a rule in a sentence, like “move anything from my landlord to a Housing label”, and review the draft before it’s saved.
        When you do, only that sentence is sent to Anthropic, using your own API key. Your mail is never sent. Each draft usually costs a cent or two on your Anthropic account.
      </p>
      {!secureStorage && <div className="notice error">Secure storage (your system keychain) isn’t available, so a key can’t be saved.</div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {configured ? (
        <div className="row" style={{ padding: 0, border: 0 }}>
          <div><span className="tile soft" style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 8 }}><Icon name="check" size={16} /></span><b>API key saved.</b> <span className="muted">Describe rules on the Cleanup page.</span></div>
          <button className="btn" disabled={busy} onClick={() => run(() => api.removeAiKey())}>Remove key</button>
        </div>
      ) : (
        <div className="form">
          <label>Anthropic API key
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false} disabled={!secureStorage} />
          </label>
          <div className="actions"><button className="btn primary" disabled={busy || !key.trim() || !secureStorage} onClick={() => run(() => api.saveAiKey(key))}>Save key</button></div>
        </div>
      )}
    </section>
  )
}
