import { useState } from 'react'
import { Icon, hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

/** A way to ask for help without sending anything anywhere: the app gathers the facts, and the user chooses to share them. */
export function HelpCard() {
  const [state, setState] = useState<'idle' | 'working' | 'copied'>('idle')
  const [error, setError] = useState<string | null>(null)

  const copy = async () => {
    setState('working'); setError(null)
    try {
      await navigator.clipboard.writeText(await api.diagnostics())
      setState('copied'); setTimeout(() => setState('idle'), 2500)
    } catch (e) { setError(errorText(e)); setState('idle') }
  }

  return (
    <section className="card" style={{ marginTop: 16, ...hue(200) }}>
      <h2>Help</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        If something isn’t working, copy the diagnostics and paste them into an email. Nothing is sent anywhere by the app, and you see everything before you share it.
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn" disabled={state === 'working'} onClick={copy}>
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} /> {state === 'copied' ? 'Copied' : 'Copy diagnostics'}
        </button>
      </div>
      <div className="actions" style={{ marginTop: 8 }}>
        <button className="btn" onClick={() => { api.setOnboarded(false).then(() => window.location.reload()) }}>Show the welcome guide again</button>
      </div>
      <details style={{ marginTop: 12 }}>
        <summary className="muted">What’s in the diagnostics</summary>
        <p className="muted" style={{ marginBottom: 0 }}>
          <b>Included:</b> the app and system version, how many messages and rules there are, whether automatic rules are on, when the last check ran, and the last few error messages with email addresses and tokens removed.<br />
          <b>Never included:</b> email addresses, senders, subjects, message contents, rule names, or your sign-in.
        </p>
      </details>
    </section>
  )
}
