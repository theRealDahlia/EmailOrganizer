import { useEffect, useState } from 'react'
import type { BackgroundPrefs, BackgroundState } from '../../shared'
import { hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const surface = navigator.userAgent.includes('Mac') ? 'menu bar' : 'system tray'

/** Lets automatic rules keep working after the window is closed. Every option is off until the user turns it on. */
export function BackgroundCard() {
  const [state, setState] = useState<BackgroundState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.getBackground().then(setState, () => {}) }, [])
  if (!state) return null

  const change = async (next: Partial<BackgroundPrefs>) => {
    setError(null)
    try { setState(await api.setBackground(next)) } catch (e) { setError(errorText(e)) }
  }
  const { prefs, loginItemSupported } = state

  return (
    <section className="card" style={{ marginTop: 16, ...hue(155) }}>
      <h2>Background</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {prefs.keepRunning
          ? `Automatic rules and cleanups keep running while Sweep sits in your ${surface}.`
          : 'Automatic rules and cleanups only run while Sweep is open. Turn on the options below to keep them working.'}
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={prefs.keepRunning} onChange={(e) => change({ keepRunning: e.target.checked })} style={{ marginTop: 3 }} />
        <span><b>Keep running in the {surface} when I close the window</b><br /><span className="muted">Click its icon to open it again, or choose Quit there to stop it.</span></span>
      </label>
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={prefs.openAtLogin} disabled={!loginItemSupported} onChange={(e) => change({ openAtLogin: e.target.checked })} style={{ marginTop: 3 }} />
        <span>
          <b>Open when I sign in to my computer</b><br />
          <span className="muted">{loginItemSupported ? (prefs.keepRunning ? 'It starts quietly in the ' + surface + '.' : 'Turn on “keep running” too, so it starts quietly instead of opening a window.') : 'Your system doesn’t let apps do this from here.'}</span>
        </span>
      </label>
      <label className="inline" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={prefs.notify} onChange={(e) => change({ notify: e.target.checked })} style={{ marginTop: 3 }} />
        <span><b>Tell me when automatic rules change mail</b><br /><span className="muted">A notification like “Archived 212 messages”, only when the app isn’t in front.</span></span>
      </label>
    </section>
  )
}
