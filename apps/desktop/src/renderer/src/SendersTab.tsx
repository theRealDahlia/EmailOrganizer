import { Fragment, useEffect, useMemo, useState } from 'react'
import type { SenderStat } from '@organizer/core'
import type { ScanProgress, SendersResult } from '../../shared'
import { Avatar, Icon, hue } from './Icons'
import { ScanStatus } from './ScanStatus'
import { SenderPanel } from './SenderPanel'

const api = window.organizer
const PAGE = 50

type Sort = 'count' | 'unread' | 'recent' | 'name'
const SORTS: { value: Sort; label: string }[] = [
  { value: 'count', label: 'Most mail' },
  { value: 'unread', label: 'Most unread' },
  { value: 'recent', label: 'Newest' },
  { value: 'name', label: 'A to Z' },
]
const sorters: Record<Sort, (a: SenderStat, b: SenderStat) => number> = {
  count: (a, b) => b.count - a.count,
  unread: (a, b) => b.unread - a.unread || b.count - a.count,
  recent: (a, b) => b.lastDate.localeCompare(a.lastDate),
  name: (a, b) => (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }),
}

/** The Latest column is hidden on narrow windows (see styles.css), so the expanded row must span one column fewer. */
function useNarrow(): boolean {
  const query = '(max-width: 760px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

const shortDate = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' })
}

/** Every sender in the scanned mail with how many messages each has sent, and the same quick actions as Overview. */
export function SendersTab({ scanKey, progress, onCancel, onScanAll, onChanged, onOpenCleanup, onGoToCleanup }: {
  /** changes whenever the scan finds more mail, so the list reloads */
  scanKey: string
  progress: ScanProgress | null
  onCancel: () => void
  onScanAll: () => void
  onChanged: () => void
  onOpenCleanup: (email: string, name: string) => void
  onGoToCleanup: () => void
}) {
  const [data, setData] = useState<SendersResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('count')
  const [subsOnly, setSubsOnly] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const [open, setOpen] = useState<string | null>(null)
  const narrow = useNarrow()

  const load = () => {
    setError(null)
    api.senders().then(setData, (e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [scanKey])
  useEffect(() => setShown(PAGE), [query, sort, subsOnly, unreadOnly])

  const rows = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return data.senders
      .filter((s) => (!q || s.email.includes(q) || s.name.toLowerCase().includes(q)) && (!subsOnly || s.hasUnsubscribe) && (!unreadOnly || s.unread > 0))
      .sort(sorters[sort])
  }, [data, query, sort, subsOnly, unreadOnly])

  if (error && !data) return <div className="notice"><p className="error">{error}</p><button className="btn" onClick={load}>Try again</button></div>
  if (!data) return <p className="muted">Counting senders…</p>

  const max = Math.max(1, ...data.senders.map((s) => s.count))
  const sampled = !data.complete
  const filtering = !!query.trim() || subsOnly || unreadOnly

  return (
    <>
      {data.scanning && <ScanStatus progress={progress} compact onCancel={onCancel} />}
      {sampled && !data.scanning && (
        <div className="card coverage" style={hue(245)}>
          <span className="tile soft"><Icon name="inbox" size={17} /></span>
          <div>
            <b>Counts cover your newest {data.scanned.toLocaleString()} messages.</b>
            <div className="muted">The inbox has {data.inboxTotal.toLocaleString()}. Scan the rest for every sender and exact counts{data.fullScanMinutes ? `, about ${data.fullScanMinutes.toLocaleString()} min` : ''}. You can keep using the app meanwhile.</div>
          </div>
          <button className="btn primary" onClick={onScanAll}>Scan whole inbox</button>
        </div>
      )}
      {error && <div className="notice error">{error}</div>}

      <section className="card">
        <div className="filters">
          <label className="filter-search">
            <span>Find a sender</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or address" spellCheck={false} autoComplete="off" />
          </label>
          <label>
            <span>Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="inline"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Has unread</label>
          <label className="inline"><input type="checkbox" checked={subsOnly} onChange={(e) => setSubsOnly(e.target.checked)} /> Can unsubscribe</label>
        </div>

        <p className="card-sub tally" aria-live="polite">
          <b>{rows.length.toLocaleString()}</b> {rows.length === 1 ? 'sender' : 'senders'}{filtering ? ` of ${data.senders.length.toLocaleString()}` : ''}
          {' · '}{rows.reduce((n, s) => n + s.count, 0).toLocaleString()} messages
        </p>

        {rows.length === 0 ? (
          <div className="empty">
            <b>{data.senders.length === 0 ? 'No mail scanned yet' : 'No senders match'}</b>
            <span className="muted">{data.senders.length === 0 ? 'Senders appear here as your inbox is read.' : 'Try a different name or clear a filter.'}</span>
            {filtering && <button className="btn" onClick={() => { setQuery(''); setSubsOnly(false); setUnreadOnly(false) }}>Clear filters</button>}
          </div>
        ) : (
          <table className="fixed senders">
            <thead><tr><th>Sender</th><th className="num">Mail</th><th className="num">Unread</th><th className="num date">Latest</th></tr></thead>
            <tbody>
              {rows.slice(0, shown).map((s) => {
                const isOpen = open === s.email
                return (
                  <Fragment key={s.email}>
                    <tr className={isOpen ? 'open' : undefined}>
                      <td>
                        <button className="sender-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} options for ${s.name || s.email}`} onClick={() => setOpen(isOpen ? null : s.email)}>
                          <Avatar name={s.name || s.email} />
                          <span className="sender"><div>{s.name || s.email}<div className="muted">{s.name ? s.email : ' '}</div></div></span>
                          {s.hasUnsubscribe && <span className="pill" title="Offers an unsubscribe option">newsletter</span>}
                          <span className="chev"><Icon name="chevron" size={16} /></span>
                        </button>
                      </td>
                      <td className="num"><div className="count-cell">{s.count.toLocaleString()}<i className="mini-bar" style={{ width: `${Math.max(4, (s.count / max) * 100)}%` }} /></div></td>
                      <td className="num">{s.unread > 0 ? <span className="count-chip" style={hue(28)}>{s.unread.toLocaleString()}</span> : <span className="muted">0</span>}</td>
                      <td className="num date muted">{shortDate(s.lastDate)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="detail"><td colSpan={narrow ? 3 : 4}>
                        <SenderPanel email={s.email} name={s.name} showUnsubscribe onChanged={() => { onChanged(); load() }} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}

        {rows.length > shown && (
          <div className="show-more">
            <button className="btn" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</button>
            <button className="btn" onClick={() => setShown(rows.length)}>Show all {rows.length.toLocaleString()}</button>
          </div>
        )}
      </section>
    </>
  )
}
