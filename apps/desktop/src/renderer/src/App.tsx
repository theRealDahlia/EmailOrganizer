import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { InboxCounts } from '@organizer/core'
import type { AccountStatus, ActivityEntry, OverviewResult, ScanProgress } from '../../shared'
import { CleanupTab, type CleanupPrefill } from './CleanupTab'
import { ScanStatus } from './ScanStatus'
import { StorageMeter } from './StorageMeter'
import { SubscriptionsTab } from './SubscriptionsTab'
import { Avatar, Icon, PAGE_HUE, categoryHue, hue } from './Icons'
import { CountUp } from './Motion'
import { SenderPanel } from './SenderPanel'
import { SendersTab } from './SendersTab'
import { ThemeSwitch } from './ThemeSwitch'
import { ImpactCard } from './ImpactCard'
import { SpaceTab } from './SpaceTab'
import { SuggestionsCard } from './SuggestionsCard'
import { AiKeyCard } from './AiKeyCard'
import { BackgroundCard } from './BackgroundCard'
import { HelpCard } from './HelpCard'
import { Onboarding } from './Onboarding'
import { CommandPalette, type Command } from './CommandPalette'

type Tab = 'overview' | 'space' | 'senders' | 'cleanup' | 'subscriptions' | 'activity' | 'accounts'
const TABS: Tab[] = ['overview', 'space', 'senders', 'cleanup', 'subscriptions', 'activity', 'accounts']
const PAGES: Record<Tab, { title: string; blurb: string }> = {
  overview: { title: 'Overview', blurb: 'What’s filling your inbox, and who it’s from.' },
  space: { title: 'Free up space', blurb: 'See what’s taking room in your Gmail and clear it safely.' },
  senders: { title: 'Senders', blurb: 'Everyone who emails you, and how often.' },
  cleanup: { title: 'Cleanup', blurb: 'Rules that archive, trash or label mail, once or on their own.' },
  subscriptions: { title: 'Subscriptions', blurb: 'Newsletters and senders you can unsubscribe from.' },
  activity: { title: 'Activity', blurb: 'Everything the app has changed. Undo any of it.' },
  accounts: { title: 'Account', blurb: 'Connect Gmail to organize your real inbox.' },
}
const api = window.organizer

const TAB_HUE: Record<string, number> = { primary: 245, social: 200, promotions: 330, updates: 35, forums: 175 }

/** Counts bars against the largest share, so even small groups stay visible. */
function Bars({ rows, hueOf }: { rows: [string, number][]; hueOf: (name: string) => number }) {
  const max = Math.max(1, ...rows.map(([, n]) => n))
  return rows.map(([name, n]) => (
    <div key={name} className="cat-row" style={hue(hueOf(name))}>
      <div className="cat-top"><span className="cat-name">{name[0].toUpperCase() + name.slice(1)}</span><span className="muted">{n.toLocaleString()}</span></div>
      <div className="bar"><i style={{ width: `${(n / max) * 100}%` }} /></div>
    </div>
  ))
}

function OverviewTab({ overview, error, progress, onRescan, onCancel, onScanAll, onChanged, onOpenCleanup, onGoToCleanup }: {
  overview: OverviewResult | null; error: string | null; progress: ScanProgress | null
  onRescan: () => void; onCancel: () => void; onScanAll: () => void; onChanged: () => void
  onOpenCleanup: (email: string, name: string) => void; onGoToCleanup: () => void
}) {
  const [openSender, setOpenSender] = useState<string | null>(null)
  // Totals and tab counts come straight from Gmail, so they show at once while the scan reads senders.
  const [counts, setCounts] = useState<InboxCounts | null>(null)
  const [tabs, setTabs] = useState<Record<string, number> | null | 'loading'>('loading')
  const countsKey = overview ? `${overview.inboxTotal}:${overview.complete}` : ''
  useEffect(() => {
    let current = true
    api.inboxCounts().then((c) => current && setCounts(c), () => current && setCounts(null))
    api.tabCounts().then((t) => current && setTabs(t), () => current && setTabs(null))
    return () => { current = false }
  }, [countsKey])

  if (error) {
    return (
      <div className="notice">
        <p className="error">{error}</p>
        <div className="actions"><button className="btn" onClick={onRescan}>Try again</button></div>
      </div>
    )
  }
  if (!overview) return <p className="muted">Loading…</p>

  const sampled = !overview.complete
  const sample = `your newest ${overview.total.toLocaleString()} messages`
  const cats = Object.entries(overview.byCategory).sort((a, b) => b[1] - a[1])
  const tabRows = tabs && tabs !== 'loading' ? Object.entries(tabs).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : []
  return (
    <>
      {overview.scanning && <ScanStatus progress={progress} compact onCancel={onCancel} />}
      {sampled && !overview.scanning && (
        <div className="card coverage" style={hue(245)}>
          <span className="tile soft"><Icon name="inbox" size={17} /></span>
          <div>
            <b>Senders and subscriptions come from {sample}.</b>
            <div className="muted">Totals and tabs already cover your whole inbox. Scan the rest for exact sender counts{overview.fullScanMinutes ? `, about ${overview.fullScanMinutes.toLocaleString()} min` : ''}. You can keep using the app meanwhile.</div>
          </div>
          <button className="btn primary" onClick={onScanAll}>Scan whole inbox</button>
        </div>
      )}
      <div className="stats">
        <div className="card stat" style={hue(245)}>
          <span className="tile"><Icon name="inbox" /></span>
          <b><CountUp value={counts?.total ?? overview.inboxTotal} /></b>
          <span>messages in inbox</span>
        </div>
        <div className="card stat" style={hue(28)}>
          <span className="tile"><Icon name="unread" /></span>
          <b><CountUp value={counts?.unread ?? overview.unread} /></b>
          <span>{counts || !sampled ? 'unread' : 'unread in newest mail'}</span>
        </div>
        <div className="card stat" style={hue(330)}>
          <span className="tile"><Icon name="subscriptions" /></span>
          <b><CountUp value={overview.subscriptionCount} /></b>
          <span>{sampled ? 'subscriptions found so far' : 'subscriptions'}</span>
        </div>
      </div>
      <SuggestionsCard scanKey={`${overview.total}:${overview.complete}:${overview.scanning}`} onChanged={onChanged} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />
      <div className="grid">
        {tabs === null ? (
          <section className="card">
            <h2>Categories</h2>
            {sampled && <p className="card-sub">In {sample}</p>}
            <Bars rows={cats} hueOf={categoryHue} />
          </section>
        ) : (
          <section className="card">
            <h2>Inbox tabs</h2>
            <p className="card-sub">Your whole inbox, as Gmail sorts it</p>
            {tabs === 'loading'
              ? <p className="muted counting"><span className="spinner" aria-hidden="true" /> Counting your tabs…</p>
              : <Bars rows={tabRows} hueOf={(t) => TAB_HUE[t] ?? categoryHue(t)} />}
          </section>
        )}
        <section className={`card${openSender ? ' wide' : ''}`}>
          <h2>Top senders</h2>
          {sampled && overview.total > 0 && <p className="card-sub">In {sample}</p>}
          {overview.total === 0 && <p className="muted counting"><span className="spinner" aria-hidden="true" /> Reading your newest mail…</p>}
          {overview.total > 0 && <table className="fixed">
            <thead><tr><th>Sender</th><th className="num">Count</th><th className="num">Unread</th></tr></thead>
            <tbody>
              {overview.topSenders.map((s) => {
                const open = openSender === s.email
                return (
                  <Fragment key={s.email}>
                    <tr className={open ? 'open' : undefined}>
                      <td>
                        <button className="sender-toggle" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} options for ${s.name || s.email}`} onClick={() => setOpenSender(open ? null : s.email)}>
                          <Avatar name={s.name || s.email} />
                          <span className="sender"><div>{s.name}<div className="muted">{s.email}</div></div></span>
                          <span className="chev"><Icon name="chevron" size={16} /></span>
                        </button>
                      </td>
                      <td className="num">{s.count.toLocaleString()}</td><td className="num">{s.unread > 0 ? <span className="count-chip" style={hue(28)}>{s.unread.toLocaleString()}</span> : <span className="muted">0</span>}</td>
                    </tr>
                    {open && (
                      <tr className="detail"><td colSpan={3}>
                        <SenderPanel email={s.email} name={s.name} showUnsubscribe onChanged={onChanged} onOpenCleanup={onOpenCleanup} onGoToCleanup={onGoToCleanup} />
                      </td></tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>}
        </section>
      </div>
    </>
  )
}

function ActivityTab({ onUndone }: { onUndone: () => void }) {
  const [items, setItems] = useState<ActivityEntry[]>([])
  const load = useCallback(() => api.activity().then(setItems), [])
  useEffect(() => { load() }, [load])
  return (
    <>
    <ImpactCard refreshKey={items.map((i) => `${i.id}${i.undone}`).join()} />
    <section className="card">
      <h2>Activity</h2>
      {items.length === 0 && <p className="muted">Nothing yet. Changes you apply will appear here, and can be undone.</p>}
      {items.map((a) => (
        <div className="row" key={a.id}>
          <div className="sender">
            <span className="tile soft" style={hue(a.undone ? 220 : 155)}><Icon name={a.undone ? 'activity' : 'archive'} size={17} /></span>
            <div>
              <b>{a.ruleName.replace(/ \(automatic\)$/, '')}</b>{a.ruleName.endsWith(' (automatic)') && <span className="pill ok">Automatic</span>} · {a.messageCount.toLocaleString()} messages
              <div className="muted">{new Date(a.at).toLocaleString()}</div>
            </div>
          </div>
          {a.undone ? <span className="muted">Undone</span>
            : <button className="btn" onClick={async () => { await api.undo(a.id); await load(); onUndone() }}>Undo</button>}
        </div>
      ))}
    </section>
    </>
  )
}

function AccountsTab({ status, onChanged }: { status: AccountStatus | null; onChanged: () => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!status) return null

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null)
    try { await fn(); onChanged() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(null) }
  }
  const saveCreds = () => run('save', async () => {
    await api.saveGoogleCredentials(clientId, clientSecret)
    setClientId(''); setClientSecret('')
  })

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {!status.secureStorage && <div className="notice error">Secure storage (your system keychain) isn't available, so credentials can't be saved.</div>}
      <section className="card">
        <h2>Gmail</h2>
        {status.mode === 'gmail' ? (
          <div className="row">
            <div><b>{status.email}</b><div className="muted">Connected. Tokens are stored in your system keychain.</div></div>
            <div className="actions">
              <button className="btn" disabled={!!busy} onClick={() => run('connect', api.connectGmail)}>{busy === 'connect' ? 'Waiting for browser…' : 'Reconnect'}</button>
              <button className="btn" disabled={!!busy} onClick={() => run('disconnect', api.disconnect)}>Disconnect</button>
            </div>
          </div>
        ) : (
          <>
            <p className="muted">Showing a demo mailbox. Sign in to organize your real inbox. Mail goes straight to this computer; nothing is sent to us.</p>
            {status.hasCredentials ? (
              <div className="actions">
                <button className="btn primary" disabled={!!busy} onClick={() => run('connect', api.connectGmail)}>
                  {busy === 'connect' ? 'Waiting for browser…' : 'Sign in with Google'}
                </button>
              </div>
            ) : (
              <p className="muted">This build has no Google client configured. Open Advanced below to add one.</p>
            )}
          </>
        )}
      </section>
      <BackgroundCard />
      <AiKeyCard secureStorage={status.secureStorage} />
      <HelpCard />
      {status.mode === 'demo' && (
        <details className="card" style={{ marginTop: 16 }} open={!status.hasCredentials}>
          <summary>Advanced: use your own Google OAuth client</summary>
          <div className="form" style={{ marginTop: 12 }}>
            <label>Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} /></label>
            <label>Client secret<input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></label>
            <div className="actions">
              <button className="btn primary" disabled={!!busy || !clientId || !clientSecret} onClick={saveCreds}>Save</button>
            </div>
          </div>
        </details>
      )}
    </>
  )
}

export function App() {
  const [tab, setTab] = useState<Tab>('overview')
  const [overview, setOverview] = useState<OverviewResult | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [status, setStatus] = useState<AccountStatus | null>(null)
  // "Custom cleanup" on a sender opens the Cleanup editor already filled in for them.
  const [prefill, setPrefill] = useState<CleanupPrefill | null>(null)
  // Cmd/Ctrl+K opens the command palette from anywhere.
  // The first-run guide: shown until finished or skipped. Someone who is already connected has no need for it.
  const [onboarded, setOnboarded] = useState<boolean | null>(null)
  const [guide, setGuide] = useState<'checking' | 'show' | 'hide'>('checking')
  useEffect(() => { api.getOnboarded().then(setOnboarded, () => setOnboarded(true)) }, [])
  useEffect(() => {
    if (guide !== 'checking' || onboarded === null || !status) return
    if (onboarded || status.mode === 'gmail') { setGuide('hide'); if (!onboarded) api.setOnboarded(true) } else setGuide('show')
  }, [guide, onboarded, status])
  const finishGuide = (go: Tab) => { api.setOnboarded(true); setGuide('hide'); setTab(go) }
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [sendersSearch, setSendersSearch] = useState<{ text: string } | undefined>(undefined)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((open) => !open) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const openCleanupFor = (email: string, name: string) => {
    setPrefill({ name: `Mail from ${name || email}`, filters: { from: email, keepStarred: true }, actions: [{ type: 'archive' }] })
    setTab('cleanup')
  }

  const refresh = useCallback((force = false) => {
    setOverviewError(null) // the previous overview stays on screen while a rescan starts
    api.overview(force).then(setOverview, (e) => setOverviewError(e instanceof Error ? e.message : String(e)))
  }, [])
  const loadStatus = useCallback(() => { api.accountStatus().then(setStatus) }, [])
  const accountChanged = useCallback(() => { loadStatus(); setOverview(null); setProgress(null); refresh(true) }, [loadStatus, refresh])
  // Listen before the first request so no progress events are missed.
  useEffect(() => api.onScanProgress((p) => {
    setProgress(p)
    if (p.phase === 'done') refresh() // pick up the final result straight away
  }), [refresh])
  useEffect(() => { loadStatus(); refresh() }, [loadStatus, refresh])
  // An automatic rule or cleanup changed mail in the background, so the numbers on screen are out of date.
  useEffect(() => api.onAutomaticRun(() => refresh()), [refresh])
  // While a scan runs, keep the numbers current as messages arrive.
  const scanning = overview?.scanning ?? false
  useEffect(() => {
    if (!scanning) return
    const t = setInterval(() => refresh(), 3000)
    return () => clearInterval(t)
  }, [scanning, refresh])


  // The sidebar's selection pill is one element moved under the active item, so switching pages slides it.
  const navRef = useRef<HTMLElement>(null)
  const [pill, setPill] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const place = () => {
      const el = nav.querySelector<HTMLElement>('[aria-current="page"]')
      if (!el) return
      setPill((prev) => ({
        transform: `translate(${el.offsetLeft}px, ${el.offsetTop}px)`, width: el.offsetWidth, height: el.offsetHeight,
        ...(!prev && { transition: 'none' }), // first placement: appear in place rather than slide in from the corner
      }))
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [tab])

  // Switching pages moves focus to the new page's heading, so keyboard and screen-reader users land where the content starts.
  const mainRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstPage = useRef(true)
  useEffect(() => {
    if (firstPage.current) { firstPage.current = false; return }
    headingRef.current?.focus({ preventScroll: true })
  }, [tab])

  const commands: Command[] = [
    ...TABS.map((t) => ({ id: `go-${t}`, title: PAGES[t].title, group: 'Go to', icon: t === 'space' ? 'space' : t, keywords: PAGES[t].blurb, run: () => setTab(t) })),
    { id: 'new-rule', title: 'New cleanup rule', group: 'Action', icon: 'cleanup', keywords: 'create add rule', run: () => { setPrefill({ name: '', filters: {}, actions: [] }); setTab('cleanup') } },
    { id: 'scan-all', title: 'Scan the whole inbox', group: 'Action', icon: 'inbox', keywords: 'download read senders exact', run: () => { api.scanFullInbox().then(() => refresh()) } },
    { id: 'rescan', title: 'Rescan inbox', group: 'Action', icon: 'inbox', keywords: 'refresh reload', run: () => refresh(true) },
    { id: 'run-auto', title: 'Run automatic rules now', group: 'Action', icon: 'clock', keywords: 'automation', run: () => { api.runAutomaticNow().then(() => refresh(), () => {}) } },
    ...(['light', 'dark', 'system'] as const).map((t) => ({
      id: `theme-${t}`, title: `Use ${t === 'system' ? 'the system' : t} theme`, group: 'Theme', icon: t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor', keywords: 'appearance colour color mode',
      run: () => { api.setTheme(t).then((saved) => window.dispatchEvent(new CustomEvent('theme-changed', { detail: saved })), () => {}) },
    })),
  ]

  const account = status?.mode === 'gmail' ? status.email ?? 'Gmail' : 'Demo mailbox'
  const head = PAGES[tab]
  const modalOpen = guide === 'show' || paletteOpen // what's behind a dialog can't be reached by keyboard or screen reader

  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus() }}>Skip to content</a>
      {guide === 'show' && status && <Onboarding status={status} overview={overview} progress={progress} onAccountChanged={accountChanged} onFinish={finishGuide} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} onSearchSenders={(text) => { setSendersSearch({ text }); setTab('senders') }} />}
      <aside className="sidebar" inert={modalOpen}>
        <div className="brand"><span className="brand-mark"><Icon name="sweep" size={18} /></span><span className="brand-text"><b>Sweep</b><small>Inbox management</small></span></div>
        <nav aria-label="Pages" ref={navRef}>
          {pill && <span className="nav-pill" style={pill} aria-hidden="true" />}
          {TABS.map((t) => (
            <button key={t} className="nav-item" aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>
              <span className="nav-ico" style={hue(PAGE_HUE[t])}><Icon name={t} size={16} /></span>{PAGES[t].title}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ThemeSwitch />
          <StorageMeter refreshKey={`${status?.mode}:${status?.email}:${overview?.total}`} onReconnect={() => setTab('accounts')} />
          <button className="account-chip nav-item" onClick={() => setTab('accounts')} title="Manage account" aria-label={`Manage account: ${account}`}>
            <Avatar name={account} />
            <span style={{ minWidth: 0 }}><b>{account}</b><small>Stays on this computer</small></span>
          </button>
        </div>
      </aside>
      <main className="main" id="main" inert={modalOpen} tabIndex={-1} ref={mainRef}>
        <div className="content" key={tab /* remount so the page's entrance plays on every switch */}>
          <div className="page-head">
            <div><h1 ref={headingRef} tabIndex={-1}>{head.title}</h1><p>{head.blurb}</p></div>
            {tab === 'overview' && overview && !overview.scanning && <button className="btn" onClick={() => refresh(true)}>Rescan inbox</button>}
          </div>
          {tab === 'overview' && <OverviewTab overview={overview} error={overviewError} progress={progress} onRescan={() => refresh(true)} onCancel={() => { api.cancelScan() }}
            onScanAll={() => { api.scanFullInbox().then(() => refresh()) }}
            onChanged={() => refresh()} onOpenCleanup={openCleanupFor} onGoToCleanup={() => setTab('cleanup')} />}
          {tab === 'space' && <SpaceTab onChanged={() => refresh()} onOpenCleanup={openCleanupFor} onGoToCleanup={() => setTab('cleanup')} />}
          {tab === 'senders' && <SendersTab initialQuery={sendersSearch} scanKey={`${overview?.total}:${overview?.scanning}:${overview?.complete}`} progress={progress} onCancel={() => { api.cancelScan() }}
            onScanAll={() => { api.scanFullInbox().then(() => refresh()) }} onChanged={() => refresh()} onOpenCleanup={openCleanupFor} onGoToCleanup={() => setTab('cleanup')} />}
          {tab === 'cleanup' && <CleanupTab onApplied={() => refresh()} scanning={scanning} prefill={prefill} onPrefillUsed={() => setPrefill(null)} onGoToAccount={() => setTab('accounts')} />}
          {tab === 'subscriptions' && <SubscriptionsTab scan={overview} onGoToCleanup={() => setTab('cleanup')} onChanged={() => refresh()} onOpenCleanup={openCleanupFor} />}
                    {tab === 'activity' && <ActivityTab onUndone={() => refresh()} />}
          {tab === 'accounts' && <AccountsTab status={status} onChanged={accountChanged} />}
        </div>
      </main>
    </div>
  )
}
