import { useEffect, useState } from 'react'
import { parseListUnsubscribe, type Subscription } from '@organizer/core'
import type { ScanProgress } from '../../shared'
import { ScanProgressPanel } from './ScanProgressPanel'

const api = window.organizer

export function SubscriptionsTab({ progress, onCancel, onGoToRules }: { progress: ScanProgress | null; onCancel: () => void; onGoToRules: () => void }) {
  const [subs, setSubs] = useState<Subscription[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    setError(null)
    api.subscriptions().then(setSubs, (e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  const act = async (email: string, fn: () => Promise<string>) => {
    setBusy(email); setError(null); setConfirming(null)
    try { const msg = await fn(); setDone((d) => ({ ...d, [email]: msg })) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  if (error && !subs) return <div className="notice"><p className="error">{error}</p><button className="btn" onClick={load}>Try again</button></div>
  if (!subs) return <ScanProgressPanel progress={progress} onCancel={onCancel} />

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      <section className="card">
        <h2>Subscriptions <span className="muted">({subs.length})</span></h2>
        <p className="muted">Senders whose mail includes an unsubscribe option, from the messages scanned. Sorted by volume; a low read rate suggests you don't want them.</p>
        {subs.length === 0 && <p>No subscriptions found in the scanned messages.</p>}
        {subs.map((s) => {
          const t = parseListUnsubscribe(s.listUnsubscribe)
          return (
            <div className="row" key={s.email}>
              <div>
                <b>{s.name}</b> <span className="muted">{s.email}</span>
                <div className="muted">
                  {s.count} emails · {Math.round(s.readRate * 100)}% read · last {new Date(s.lastDate).toLocaleDateString()}
                </div>
                {done[s.email] && <div style={{ color: 'var(--ok)' }}>{done[s.email]}</div>}
              </div>
              <div className="actions">
                {s.oneClick && t.https && (confirming === s.email
                  ? <button className="btn primary" disabled={busy === s.email} onClick={() => act(s.email, async () => { await api.unsubscribe(s.email, 'oneClick'); return 'Unsubscribe request sent.' })}>Confirm: unsubscribe</button>
                  : <button className="btn" disabled={!!busy} onClick={() => setConfirming(s.email)}>Unsubscribe</button>)}
                {!s.oneClick && t.https && (
                  <button className="btn" disabled={!!busy} onClick={() => act(s.email, async () => { await api.unsubscribe(s.email, 'openLink'); return 'Opened the sender’s unsubscribe page in your browser.' })}>Open unsubscribe page</button>
                )}
                {!t.https && t.mailto && (
                  <button className="btn" disabled={!!busy} onClick={() => act(s.email, async () => { await api.unsubscribe(s.email, 'openMail'); return 'Opened a pre-filled email in your mail app. Send it to unsubscribe.' })}>Unsubscribe by email</button>
                )}
                <button className="btn" disabled={!!busy} onClick={() => act(s.email, async () => { await api.createArchiveRule(s.email); return 'Rule created. Review and apply it in Rules.' })}>Auto-archive</button>
              </div>
            </div>
          )
        })}
      </section>
      {Object.keys(done).some((k) => done[k].startsWith('Rule created')) && (
        <div className="actions" style={{ marginTop: 12 }}><button className="btn primary" onClick={onGoToRules}>Go to Rules</button></div>
      )}
    </>
  )
}
