import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SenderStat } from '@organizer/core'
import type { ScanProgress, SendersResult } from '../../shared'
import { Avatar, Icon, hue } from './Icons'
import { ScanStatus } from './ScanStatus'
import { SenderPanel } from './SenderPanel'
import { searchMatcher } from './search'

const api = window.organizer
const PAGE = 50

type Sort = 'count' | 'unread' | 'size' | 'recent' | 'name'
const SORTS: { value: Sort; label: string }[] = [
  { value: 'count', label: 'Most mail' },
  { value: 'unread', label: 'Most unread' },
  { value: 'size', label: 'Largest' },
  { value: 'recent', label: 'Newest' },
  { value: 'name', label: 'A to Z' },
]
const sorters: Record<Sort, (a: SenderStat, b: SenderStat) => number> = {
  count: (a, b) => b.count - a.count,
  unread: (a, b) => b.unread - a.unread || b.count - a.count,
  size: (a, b) => b.bytes - a.bytes,
  recent: (a, b) => b.lastDate.localeCompare(a.lastDate),
  name: (a, b) => (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' }),
}

/**
 * How the page looked when the user last left it: what they searched for, how it's sorted and filtered, how many rows they
 * had opened up, which sender was expanded, and how far they had scrolled. It lives for as long as the app is open, so
 * leaving for another page and coming back finds everything where it was.
 */
interface View { query: string; sort: Sort; subsOnly: boolean; unreadOnly: boolean; shown: number; open: string | null; scrollTop: number }
const remembered: View = { query: '', sort: 'count', subsOnly: false, unreadOnly: false, shown: PAGE, open: null, scrollTop: 0 }
/** The last search sent from the command palette that this page has already acted on, so coming back doesn't repeat it. */
let consumedSearch: object | undefined

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
export function SendersTab({ scanKey, initialQuery, progress, onCancel, onScanAll, onChanged, onOpenCleanup, onGoToCleanup }: {
  /** a search to show, such as one typed in the command palette; the object changes each time so the same text can be sent again */
  initialQuery?: { text: string }
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
  const [query, setQuery] = useState(remembered.query)
  const [sort, setSort] = useState<Sort>(remembered.sort)
  const [subsOnly, setSubsOnly] = useState(remembered.subsOnly)
  const [unreadOnly, setUnreadOnly] = useState(remembered.unreadOnly)
  const [shown, setShown] = useState(remembered.shown)
  const [open, setOpen] = useState<string | null>(remembered.open)
  const restoredScroll = useRef(false)
  const arrivedWithSearch = useRef(!!initialQuery && initialQuery !== consumedSearch)
  const narrow = useNarrow()

  const load = () => {
    setError(null)
    api.senders().then(setData, (e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [scanKey])
  // Changing what's shown starts the list from the top again, but opening the page must keep the rows the user had opened.
  const firstRun = useRef(true)
  useEffect(() => { if (firstRun.current) { firstRun.current = false; return } setShown(PAGE) }, [query, sort, subsOnly, unreadOnly])
  // A search from the command palette replaces what was remembered, and starts at the top.
  useEffect(() => {
    if (!initialQuery || initialQuery === consumedSearch) return
    consumedSearch = initialQuery
    setQuery(initialQuery.text); setSubsOnly(false); setUnreadOnly(false); setOpen(null)
  }, [initialQuery])
  useEffect(() => { Object.assign(remembered, { query, sort, subsOnly, unreadOnly, shown, open }) }, [query, sort, subsOnly, unreadOnly, shown, open])

  // Back to where the user was scrolled, once the rows exist to scroll to; and keep track of it from then on.
  useLayoutEffect(() => {
    if (restoredScroll.current || !data) return
    restoredScroll.current = true
    const main = document.querySelector('.main')
    if (main) main.scrollTop = arrivedWithSearch.current ? 0 : remembered.scrollTop
  }, [data])
  // Taken as the page is torn down, while its content still fills the scroll area. Watching scroll events instead would
  // also record the jump to the top that the next, shorter page causes.
  useLayoutEffect(() => () => {
    const main = document.querySelector('.main')
    if (main && restoredScroll.current) remembered.scrollTop = main.scrollTop
  }, [])

  const rows = useMemo(() => {
    if (!data) return []
    const matches = searchMatcher(query)
    return data.senders
      .filter((s) => matches(`${s.name} ${s.email}`) && (!subsOnly || s.hasUnsubscribe) && (!unreadOnly || s.unread > 0))
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
