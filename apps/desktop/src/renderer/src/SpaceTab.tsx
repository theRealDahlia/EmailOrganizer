import { Fragment, useEffect, useState } from 'react'
import { formatStorageBytes } from '@organizer/core'
import type { ActivityEntry, DuplicatesResult, SendersResult, SpaceCandidate, SpaceGuide } from '../../shared'
import { MoveChip } from './Badges'
import { formatBytes } from './format'
import { Avatar, Icon, hue } from './Icons'
import { SenderPanel } from './SenderPanel'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const CANDIDATE_HUES: Record<string, number> = { 'attachments-25': 12, 'attachments-10': 28, 'attachments-5': 45, 'promotions-old': 330, 'social-old': 200, 'updates-old': 35 }

/** Where the space goes, and what can safely be cleared. Everything here is inbox mail, and everything moves to Trash. */
export function SpaceTab({ onChanged, onOpenCleanup, onGoToCleanup }: {
  onChanged: () => void
  onOpenCleanup: (email: string, name: string) => void
  onGoToCleanup: () => void
}) {
  const [guide, setGuide] = useState<SpaceGuide | null>(null)
  const [senders, setSenders] = useState<SendersResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<{ text: string; entry: ActivityEntry; undone?: boolean } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [dups, setDups] = useState<DuplicatesResult | null>(null)
  const [confirmDups, setConfirmDups] = useState(false)

  const load = () => {
    setError(null)
    api.spaceGuide().then(setGuide, (e) => setError(errorText(e)))
    api.senders().then(setSenders, () => {})
    api.duplicates().then(setDups, () => {})
  }
  useEffect(load, [])

  const clean = async (c: SpaceCandidate) => {
    setBusy(c.id); setError(null); setConfirming(null)
    try {
      const entry = await api.cleanSpace(c.id, c.count)
      setDone({ text: `Moved ${entry.messageCount.toLocaleString()} messages to Trash${entry.bytes ? `, about ${formatBytes(entry.bytes)}` : ''}.`, entry })
      setGuide(null); onChanged(); load()
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  const cleanDuplicates = async () => {
    if (!dups) return
    setBusy('dups'); setError(null); setConfirmDups(false)
    try {
      const entry = await api.trashDuplicates(dups.count)
      setDone({ text: `Moved ${entry.messageCount.toLocaleString()} duplicate messages to Trash${entry.bytes ? `, about ${formatBytes(entry.bytes)}` : ''}.`, entry })
      setGuide(null); onChanged(); load()
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  const undo = async () => {
    if (!done) return
    setBusy('undo')
    try { await api.undo(done.entry.id); setDone({ ...done, text: 'Undone. Everything is back in your inbox.', undone: true }); setGuide(null); onChanged(); load() }
    catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  if (error && !guide) return <div className="notice"><p className="error">{error}</p><button className="btn" onClick={load}>Try again</button></div>

  const freeable = guide?.candidates.reduce((n, c) => n + c.bytes, 0) ?? 0
  const quota = guide?.quota
  const pct = (bytes: number) => (quota?.limitBytes ? Math.min(100, Math.max(0, Math.round((bytes / quota.limitBytes) * 100))) : null)
  const nowPct = quota ? pct(quota.usedBytes) : null
  const afterPct = quota ? pct(Math.max(0, quota.usedBytes - freeable)) : null
  const bySize = senders ? [...senders.senders].sort((a, b) => b.bytes - a.bytes).slice(0, 8) : []

  return (
    <>
      <section className="card space-hero" style={hue(175)}>
        {!guide ? (
          <p className="muted counting"><span className="spinner" aria-hidden="true" /> Finding what’s taking up room… this can take a few seconds.</p>
        ) : (
          <>
            {quota ? (
              <>
                <h2>You’re using {formatStorageBytes(quota.usedBytes)}{quota.limitBytes ? ` of ${formatStorageBytes(quota.limitBytes)}` : ''}</h2>
                {nowPct !== null && (
                  <div className="meter" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={nowPct}>
                    <i className={nowPct >= 90 ? 'high' : ''} style={{ width: `${nowPct}%` }} />
                  </div>
                )}
              </>
            ) : <h2>Free up space</h2>}
            <p className="space-lead">
              {guide.candidates.length === 0
                ? 'Nothing big in your inbox stands out, so there’s little to clear here.'
                : <>You can move up to <b>{formatBytes(freeable)}</b> to Trash from your inbox{nowPct !== null && afterPct !== null ? <>, taking you from <b>{nowPct}%</b> to about <b>{afterPct}%</b></> : ''}.</>}
            </p>
            <p className="card-sub" style={{ margin: 0 }}>
              Storage is shared with Drive and Photos, and only inbox mail is listed here. Gmail deletes Trash after 30 days, and that’s when the space is freed. Emptying Trash in Gmail frees it right away.
            </p>
          </>
        )}
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}
      {done && (
        <div className="notice sp-done" role="status">
          <Icon name="check" size={16} /><span>{done.text}</span>
          {!done.undone && <button className="btn" disabled={!!busy} onClick={undo}><Icon name="undo" size={14} /> Undo</button>}
        </div>
      )}

      {guide && guide.candidates.length > 0 && (
        <section>
          <h2>What to clear</h2>
          <div className="space-list">
            {guide.candidates.map((c) => (
              <div className="card space-card" key={c.id} style={hue(CANDIDATE_HUES[c.id] ?? 175)}>
                <div className="space-top">
                  <span className="tile soft"><Icon name={c.id.startsWith('attachments') ? 'archive' : 'cleanup'} size={17} /></span>
                  <div className="space-title">
                    <b>{c.title}</b>
                    <span className="muted">{c.blurb}</span>
                  </div>
                  <div className="space-size">
                    <b>{c.bytesAreEstimate ? 'about ' : ''}{formatBytes(c.bytes)}</b>
                    <span className="muted">{c.count.toLocaleString()} {c.count === 1 ? 'message' : 'messages'}</span>
                  </div>
                </div>
                {c.samples.length > 0 && (
                  <ul className="space-samples">
                    {c.samples.map((s, i) => (
                      <li key={i}><span className="s-from">{s.from}</span><span className="s-subject muted">{s.subject}</span><span className="s-size">{formatBytes(s.sizeBytes)}</span></li>
                    ))}
                  </ul>
                )}
                {confirming === c.id ? (
                  <div className="notice danger" style={{ margin: 0 }}>
                    <b>Move {c.count.toLocaleString()} {c.count === 1 ? 'message' : 'messages'} to Trash?</b> Starred mail is kept, and you can undo from here or Activity.
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button className="btn danger" disabled={!!busy} onClick={() => clean(c)}>Move to Trash</button>
                      <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="actions">
                    <button className="btn" disabled={!!busy} onClick={() => setConfirming(c.id)}>
                      {busy === c.id ? 'Moving…' : `Move ${c.count.toLocaleString()} to Trash`}
                    </button>
                    <MoveChip move="trash" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {dups && dups.count > 0 && (
        <section className="card space-card" style={{ marginTop: 16, ...hue(200) }}>
          <div className="space-top">
            <span className="tile soft"><Icon name="copy" size={17} /></span>
            <div className="space-title">
              <b>Duplicate messages</b>
              <span className="muted">The same message arriving more than once: same sender, subject, size and minute. The newest copy of each is kept. Based on {dups.complete ? 'your whole inbox' : `your newest ${dups.scanned.toLocaleString()} messages`}.</span>
            </div>
            <div className="space-size"><b>{formatBytes(dups.bytes)}</b><span className="muted">{dups.count.toLocaleString()} extra {dups.count === 1 ? 'copy' : 'copies'}</span></div>
          </div>
          <ul className="space-samples">
            {dups.examples.map((e, i) => <li key={i}><span className="s-from">{e.from}</span><span className="s-subject muted">{e.subject}</span><span className="s-size">{e.copies} copies</span></li>)}
          </ul>
          {confirmDups ? (
            <div className="notice danger" style={{ margin: 0 }}>
              <b>Move {dups.count.toLocaleString()} extra {dups.count === 1 ? 'copy' : 'copies'} to Trash?</b> One copy of each stays, and you can undo.
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="btn danger" disabled={!!busy} onClick={cleanDuplicates}>Move to Trash</button>
                <button className="btn" onClick={() => setConfirmDups(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="actions">
              <button className="btn" disabled={!!busy} onClick={() => setConfirmDups(true)}>{busy === 'dups' ? 'Moving…' : `Move ${dups.count.toLocaleString()} to Trash`}</button>
              <MoveChip move="trash" />
            </div>
          )}
        </section>
      )}

      {bySize.length > 0 && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Biggest senders</h2>
          {senders && !senders.complete && <p className="card-sub">By size, in your newest {senders.scanned.toLocaleString()} messages. Scan the whole inbox from Senders for exact totals.</p>}
          <table className="fixed senders">
            <thead><tr><th>Sender</th><th className="num">Size</th><th className="num">Mail</th></tr></thead>
            <tbody>
              {bySize.map((s) => {
                const isOpen = open === s.email
                return (
                  <Fragment key={s.email}>
                    <tr className={isOpen ? 'open' : undefined}>
                      <td>
                        <button className="sender-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} options for ${s.name || s.email}`} onClick={() => setOpen(isOpen ? null : s.email)}>
                          <Avatar name={s.name || s.email} />
                          <span className="sender"><div>{s.name || s.email}<div className="muted">{s.name ? s.email : ' '}</div></div></span>
                          <span className="chev"><Icon name="chevron" size={16} /></span>
                        </button>
                      </td>
                      <td className="num"><b>{formatBytes(s.bytes)}</b></td>
                      <td className="num muted">{s.count.toLocaleString()}</td>
                    </tr>
                    {isOpen && (
                      <tr className="detail"><td colSpan={3}>
                        <SenderPanel email={s.email} name={s.name} showUnsubscribe onChanged={() => { onChanged(); load() }} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}
