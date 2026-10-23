import { useEffect, useMemo, useState } from 'react'
import { parseListUnsubscribe, type Subscription } from '@organizer/core'
import type { OverviewResult, UnsubscribeRecord } from '../../shared'
import { CoverageNote } from './ScanStatus'
import { Avatar, Icon } from './Icons'
import { SenderPanel } from './SenderPanel'
import { UnsubStatus } from './Badges'

const api = window.organizer

export function SubscriptionsTab({ scan, onGoToCleanup, onChanged, onOpenCleanup }: {
  scan: OverviewResult | null; onGoToCleanup: () => void; onChanged: () => void; onOpenCleanup: (email: string, name: string) => void
}) {
  const [openSender, setOpenSender] = useState<string | null>(null)
  const [subs, setSubs] = useState<Subscription[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statuses, setStatuses] = useState<Record<string, UnsubscribeRecord>>({})
  const loadStatuses = () => api.unsubscribeStatus().then((list) => setStatuses(Object.fromEntries(list.map((r) => [r.email, r]))), () => {})
  useEffect(() => { loadStatuses() }, [])

  const load = () => {
    setError(null)
    api.subscriptions().then(setSubs, (e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [scan?.total]) // reload as a running scan finds more messages

  const act = async (email: string, fn: () => Promise<string>) => {
    setBusy(email); setError(null); setConfirming(null)
    try { const msg = await fn(); setDone((d) => ({ ...d, [email]: msg })); loadStatuses() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (subs ?? []).filter((s) => !q || s.email.includes(q) || s.name.toLowerCase().includes(q))
  }, [subs, query])

  if (error && !subs) return <div className="notice"><p className="error">{error}</p><button className="btn" onClick={load}>Try again</button></div>
  if (!subs) return <p className="muted">Looking for subscriptions…</p>

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      <section className="card">
        <h2>Subscriptions <span className="muted">({subs.length})</span></h2>
        {scan && <CoverageNote scan={scan} />}
        <p className="muted">Senders whose mail includes an unsubscribe option, from the messages scanned. Sorted by volume; a low read rate suggests you don't want them.</p>
        {subs.length === 0 && <p>No subscriptions found in the scanned messages.</p>}
        {subs.length > 0 && (
          <div className="filters">
            <label className="filter-search">
              <span>Find a subscription</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or address" spellCheck={false} autoComplete="off" />
            </label>
            <p className="card-sub tally" style={{ margin: '0 0 8px' }} aria-live="polite">
              <b>{matches.length.toLocaleString()}</b> {matches.length === 1 ? 'subscription' : 'subscriptions'}{query.trim() ? ` of ${subs.length.toLocaleString()}` : ''}
            </p>
          </div>
        )}
        {subs.length > 0 && matches.length === 0 && (
          <div className="empty">
            <b>No subscriptions match “{query.trim()}”</b>
            <span className="muted">Check the spelling, or try part of the sender’s address.</span>
            <button className="btn" onClick={() => setQuery('')}>Clear search</button>
          </div>
        )}
        {matches.map((s) => {
          const t = parseListUnsubscribe(s.listUnsubscribe)
          return (
            <div className={`row${openSender === s.email ? ' open' : ''}`} key={s.email}>
              <button className="sender-toggle" style={{ flex: '1 1 280px' }} aria-expanded={openSender === s.email}
                aria-label={`${openSender === s.email ? 'Hide' : 'Show'} options for ${s.name || s.email}`}
                onClick={() => setOpenSender(openSender === s.email ? null : s.email)}>
                <Avatar name={s.name || s.email} />
                <span className="sender">
                  <div>
                    <b>{s.name}</b> <span className="muted">{s.email}</span>
                    <div className="muted">
                      {s.count} emails · {Math.round(s.readRate * 100)}% read{s.readRate < 0.2 && <> <span className="pill warn">rarely read</span></>} · last {new Date(s.lastDate).toLocaleDateString()}
                    </div>
                    {statuses[s.email] && <div style={{ marginTop: 2 }}><UnsubStatus record={statuses[s.email]} /></div>}
                    {done[s.email] && <div style={{ color: 'var(--ok)' }}>{done[s.email]}</div>}
                  </div>
                </span>
                <span className="chev"><Icon name="chevron" size={16} /></span>
              </button>
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
                <button className="btn" disabled={!!busy} onClick={() => act(s.email, async () => { await api.createArchiveRule(s.email); return 'Rule created. Review and apply it in Cleanup.' })}>Auto-archive</button>
              </div>
              {openSender === s.email && <SenderPanel email={s.email} name={s.name} onChanged={onChanged} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />}
            </div>
          )
        })}
      </section>
      {Object.keys(done).some((k) => done[k].startsWith('Rule created')) && (
        <div className="actions" style={{ marginTop: 12 }}><button className="btn primary" onClick={onGoToCleanup}>Go to Cleanup</button></div>
      )}
    </>
  )
}
