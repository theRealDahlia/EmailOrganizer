import { useEffect, useState } from 'react'
import type { SuggestionsResult } from '../../shared'
import { MoveChip } from './Badges'
import { formatBytes } from './format'
import { Avatar, Icon, hue } from './Icons'
import { SenderPanel } from './SenderPanel'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const SHOWN = 3

/** Senders the user barely reads, each with the reason and a one-click fix. Nothing happens unless a button is pressed. */
export function SuggestionsCard({ scanKey, onChanged, onOpenCleanup, onGoToCleanup }: {
  /** changes when the scan finds more mail, so suggestions are worked out again */
  scanKey: string
  onChanged: () => void
  onOpenCleanup: (email: string, name: string) => void
  onGoToCleanup: () => void
}) {
  const [result, setResult] = useState<SuggestionsResult | null>(null)
  const [gone, setGone] = useState<Set<string>>(new Set())
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.suggestions().then(setResult, () => {}) }, [scanKey])

  const items = (result?.items ?? []).filter((s) => !gone.has(s.id))
  if (!result || (items.length === 0 && !notice)) return null
  const visible = all ? items : items.slice(0, SHOWN)

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id); setError(null)
    try { await fn(); setGone((g) => new Set(g).add(id)) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <section className="card suggestions" style={hue(155)}>
      <div className="impact-head">
        <div>
          <h2>Suggestions</h2>
          {items.length > 0 && <p className="card-sub" style={{ margin: 0 }}>Senders you hardly ever open{result.complete ? '' : `, in your newest ${result.scanned.toLocaleString()} messages`}. Nothing changes until you choose.</p>}
        </div>
      </div>
      {notice && (
        <div className="notice sp-done" role="status">
          <Icon name="check" size={16} /><span>{notice}</span><button className="btn" onClick={onGoToCleanup}>Go to Cleanup</button>
        </div>
      )}
      {error && <div className="notice error" role="alert">{error}</div>}
      {visible.map((s) => (
        <div className="suggestion" key={s.id}>
          <div className="row">
            <div className="sender" style={{ flex: '1 1 260px' }}>
              <Avatar name={s.name} />
              <div>
                <b>{s.name}</b> <span className="muted">{s.email}</span>
                <div className="muted">{s.why}{s.bytes > 0 ? ` About ${formatBytes(s.bytes)} of your mail.` : ''}</div>
              </div>
            </div>
            <div className="actions">
              <button className="btn primary" disabled={!!busy} title="Archives what’s there now, and archives anything new from them automatically. You can undo it, and turn it off in Cleanup."
                onClick={() => act(s.id, async () => {
                  await api.autoArchiveSender(s.email)
                  setNotice(`Mail from ${s.name} is being archived, and new mail will be archived automatically.`)
                  onChanged()
                })}>
                {busy === s.id ? 'Working…' : 'Archive from now on'}
              </button>
              <MoveChip move="archive" />
              <button className="btn" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>More options</button>
              <button className="btn" disabled={!!busy} onClick={() => act(s.id, () => api.dismissSuggestion(s.id))}>Not now</button>
            </div>
          </div>
          {open === s.id && <SenderPanel email={s.email} name={s.name} showUnsubscribe onChanged={onChanged} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />}
        </div>
      ))}
      {items.length > SHOWN && (
        <div className="show-more"><button className="btn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${items.length - SHOWN} more`}</button></div>
      )}
    </section>
  )
}
