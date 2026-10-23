import { useEffect, useRef, useState } from 'react'
import type { ActivityEntry, SpaceListing, SpaceMessage, SpaceSource } from '../../shared'
import { MoveChip } from './Badges'
import { formatBytes } from './format'
import { Icon } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * The emails behind one "Free up space" suggestion, for choosing exactly which go to Trash: tick them one by one, tick
 * every one shown, or (like Gmail) every one the suggestion covers. Nothing moves without a confirmation, and it can be undone.
 */
export function SpaceDetail({ source, onBack, onChanged }: { source: SpaceSource; onBack: (changed: boolean) => void; onChanged: () => void }) {
  const [title, setTitle] = useState('')
  const [total, setTotal] = useState<number | null>(null)
  const [messages, setMessages] = useState<SpaceMessage[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false) // every email in the suggestion, including ones not loaded yet
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ text: string; entry: ActivityEntry; undone?: boolean } | null>(null)
  const changed = useRef(false)
  const selectAllBox = useRef<HTMLInputElement>(null)

  const take = (page: SpaceListing, append: boolean) => {
    setTitle(page.title); setTotal(page.total)
    setMessages((m) => (append ? [...m, ...page.messages] : page.messages))
  }
  const load = (offset: number, append: boolean) => {
    setLoading(true); setError(null)
    api.spaceList(source, offset).then((p) => take(p, append), (e) => setError(errorText(e))).finally(() => setLoading(false))
  }
  useEffect(() => { load(0, false) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const count = allMatching ? total ?? 0 : selected.size
  const allShown = messages.length > 0 && messages.every((m) => selected.has(m.id))
  const someShown = messages.some((m) => selected.has(m.id))
  useEffect(() => { if (selectAllBox.current) selectAllBox.current.indeterminate = !allShown && someShown }, [allShown, someShown])

  const toggle = (id: string) => {
    setAllMatching(false) // un-ticking one email means "these ones", not "all of them"
    setConfirming(false)
    setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  const toggleAllShown = () => {
    setAllMatching(false); setConfirming(false)
    setSelected(allShown ? new Set() : new Set(messages.map((m) => m.id)))
  }

  const moveToTrash = async () => {
    setBusy(true); setError(null); setConfirming(false)
    try {
      const entry = allMatching
        ? source.kind === 'duplicates' ? await api.trashDuplicates(total ?? 0) : await api.cleanSpace(source.id, total ?? 0)
        : await api.trashSelected(source, [...selected])
      changed.current = true
      setDone({ text: `Moved ${plural(entry.messageCount, 'email')} to Trash${entry.bytes ? `, about ${formatBytes(entry.bytes)}` : ''}.`, entry })
      setSelected(new Set()); setAllMatching(false)
      onChanged(); load(0, false)
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const undo = async () => {
    if (!done) return
    setBusy(true)
    try { await api.undo(done.entry.id); setDone({ ...done, text: 'Undone. Those emails are back in your inbox.', undone: true }); onChanged(); load(0, false) }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div className="space-detail">
      <button className="link-btn back-link" onClick={() => onBack(changed.current)}><span className="back-chev"><Icon name="chevron" size={14} /></span> Free up space</button>
      <div className="page-head" style={{ marginTop: 8 }}>
        <div>
          <h1>{title || ' '}</h1>
          <p>{total === null ? 'Loading…' : total === 0 ? 'Nothing left here.' : `${plural(total, 'email')}, newest first. Choose which ones go to Trash.`}</p>
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      {done && (
        <div className="notice sp-done" role="status">
          <Icon name="check" size={16} /><span>{done.text}</span>
          {!done.undone && <button className="btn" disabled={busy} onClick={undo}><Icon name="undo" size={14} /> Undo</button>}
        </div>
      )}

      {total !== null && total > 0 && (
        <section className="card">
          <div className="select-bar">
            <label className="inline select-all">
              <input ref={selectAllBox} type="checkbox" checked={allShown} onChange={toggleAllShown} aria-label="Select every email shown" />
              <span>Select all</span>
            </label>
            <span className="muted" aria-live="polite">{count ? `${plural(count, 'email')} selected` : 'None selected'}</span>
            <span className="select-actions">
              <MoveChip move="trash" />
              <button className="btn danger" disabled={!count || busy} onClick={() => setConfirming(true)}>
                {busy ? 'Moving…' : count ? `Move ${count.toLocaleString()} to Trash` : 'Move to Trash'}
              </button>
            </span>
          </div>

          {allShown && !allMatching && total > messages.length && (
            <div className="select-note">
              All {messages.length.toLocaleString()} shown are selected. <button className="link-btn" onClick={() => setAllMatching(true)}>Select all {total.toLocaleString()}</button>
            </div>
          )}
          {allMatching && (
            <div className="select-note">
              All {total.toLocaleString()} emails are selected, including ones not shown yet. <button className="link-btn" onClick={() => { setAllMatching(false); setSelected(new Set()) }}>Clear selection</button>
            </div>
          )}
          {confirming && (
            <div className="notice danger" style={{ margin: '0 0 12px' }}>
              <b>Move {plural(count, 'email')} to Trash?</b> {source.kind === 'candidate' ? 'Starred mail is kept. ' : ''}Gmail keeps Trash for 30 days, and you can undo from here or Activity.
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="btn danger" disabled={busy} onClick={moveToTrash}>Move to Trash</button>
                <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          )}

          <table className="fixed space-table">
            <colgroup><col style={{ width: 40 }} /><col /><col /><col style={{ width: 110 }} /><col style={{ width: 84 }} /></colgroup>
            <thead><tr><th aria-label="Selected" /><th>From</th><th>Subject</th><th>Date</th><th className="num">Size</th></tr></thead>
            <tbody>
              {messages.map((m) => {
                const on = allMatching || selected.has(m.id)
                return (
                  <tr key={m.id} className={on ? 'picked' : undefined} onClick={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') toggle(m.id) }}>
                    <td><input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`Select ${m.subject || 'email'} from ${m.from}`} /></td>
                    <td><div className="cell-two"><span>{m.from}</span><span className="muted">{m.email}</span></div></td>
                    <td className="cell-subject">{m.subject || <span className="muted">(no subject)</span>}</td>
                    <td className="muted">{shortDate(m.date)}</td>
                    <td className="num">{formatBytes(m.sizeBytes)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {messages.length < total && (
            <div className="show-more">
              <button className="btn" disabled={loading} onClick={() => load(messages.length, true)}>
                {loading ? 'Loading…' : `Show ${Math.min(50, total - messages.length)} more`}
              </button>
              <span className="muted">Showing {messages.length.toLocaleString()} of {total.toLocaleString()}</span>
            </div>
          )}
        </section>
      )}
      {total === null && loading && <p className="muted counting"><span className="spinner" aria-hidden="true" /> Loading emails…</p>}
    </div>
  )
}
