import { useEffect, useState } from 'react'
import { AUTO_TRASH_LIMIT, type AutomationStatus } from '../../shared'
import { Icon, hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

/**
 * What the automatic rules and cleanups are up to: when they last ran, what they left for review (matches
 * over the automatic limit) and what couldn't run. Shown only while something is automatic.
 */
export function AutomationNotice({ active, onRan }: { active: boolean; onRan?: () => void }) {
  const [status, setStatus] = useState<AutomationStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.automation().then(setStatus, () => {})
    // the time of the last check moves every minute without any event, so look again now and then
    const timer = setInterval(() => { api.automation().then(setStatus, () => {}) }, 30_000)
    const off = api.onAutomaticRun((s) => { setStatus(s); onRan?.() })
    return () => { clearInterval(timer); off() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!active || !status) return null

  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  const runNow = async () => {
    setRunning(true); setError(null)
    try { setStatus(await api.runAutomaticNow()); onRan?.() } catch (e) { setError(errorText(e)) } finally { setRunning(false) }
  }

  return (
    <div className="card automation" style={hue(155)}>
      <div className="automation-head">
        <span className="tile soft"><Icon name="clock" size={17} /></span>
        <div>
          <b>Automatic rules are on</b>
          <div className="muted">
            {status.lastCheckedAt ? `Last looked for new mail at ${time(status.lastCheckedAt)}. ` : 'Looks for new mail every minute. '}
            {status.lastRunAt ? `Last ran at ${time(status.lastRunAt)}. ` : 'Runs shortly after launch. '}
            They run when new mail arrives and about every 30 minutes, while the app is open, and each run shows in Activity.
          </div>
        </div>
        <button className="btn" disabled={running} onClick={runNow}>{running ? 'Running…' : 'Run now'}</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {status.checkError && (
        <div className="notice error" role="status"><b>Couldn’t look for new mail.</b> {status.checkError} It tries again every minute.</div>
      )}
      {status.needsReview.map((r) => (
        <div key={r.id} className="notice danger" role="status">
          <b>“{r.name}” is waiting for you.</b> It matches {r.count.toLocaleString()} messages, more than the {AUTO_TRASH_LIMIT.toLocaleString()} an automatic run will move to Trash. Preview it and apply it yourself, and automatic runs will handle new mail after that.
        </div>
      ))}
      {status.errors.map((r) => (
        <div key={r.name} className="notice error" role="status"><b>“{r.name}” couldn’t run.</b> {r.message}</div>
      ))}
    </div>
  )
}
