import { useCallback, useEffect, useState } from 'react'
import type { Rule } from '@organizer/core'
import type { AccountStatus, ActivityEntry, OverviewResult, PreviewResult, ScanProgress } from '../../shared'
import { RuleEditor } from './RuleEditor'
import { CleanupTab } from './CleanupTab'
import { formatBytes } from './format'
import { CoverageNote, ScanStatus } from './ScanStatus'
import { StorageMeter } from './StorageMeter'
import { SubscriptionsTab } from './SubscriptionsTab'
import { Avatar, Icon, PAGE_HUE, categoryHue, hue } from './Icons'

type Tab = 'overview' | 'cleanup' | 'subscriptions' | 'rules' | 'activity' | 'accounts'
const TABS: Tab[] = ['overview', 'cleanup', 'subscriptions', 'rules', 'activity', 'accounts']
const PAGES: Record<Tab, { title: string; blurb: string }> = {
  overview: { title: 'Overview', blurb: 'What’s filling your inbox, and who it’s from.' },
  cleanup: { title: 'Cleanup', blurb: 'Find old, large or noisy mail and clear it in one go.' },
  subscriptions: { title: 'Subscriptions', blurb: 'Newsletters and senders you can unsubscribe from.' },
  rules: { title: 'Rules', blurb: 'Keep your inbox tidy automatically.' },
  activity: { title: 'Activity', blurb: 'Everything the app has changed. Undo any of it.' },
  accounts: { title: 'Account', blurb: 'Connect Gmail to organize your real inbox.' },
}
const api = window.organizer

const trashes = (rule: Rule) => rule.actions.some((a) => a.type === 'trash')

function describe(rule: Rule): string {
  const c = rule.conditions.map((c) => `${c.field} ${c.op} ${String(c.value)}`).join(rule.match === 'all' ? ' AND ' : ' OR ')
  const a = rule.actions.map((a) => ('label' in a ? `${a.type} "${a.label}"` : a.type === 'trash' ? 'move to Trash' : a.type)).join(', ')
  return `When ${c} → ${a}`
}

function OverviewTab({ overview, error, progress, onRescan, onCancel }: {
  overview: OverviewResult | null; error: string | null; progress: ScanProgress | null; onRescan: () => void; onCancel: () => void
}) {
  if (error) {
    return (
      <div className="notice">
        <p className="error">{error}</p>
        <div className="actions"><button className="btn" onClick={onRescan}>Try again</button></div>
      </div>
    )
  }
  if (!overview) return <p className="muted">Loading…</p>
  // Nothing to show yet (first-ever scan): the status card is the whole page.
  if (overview.scanning && overview.total === 0) return <ScanStatus progress={progress} onCancel={onCancel} />

  const cats = Object.entries(overview.byCategory).sort((a, b) => b[1] - a[1])
  return (
    <>
      {overview.scanning && <div style={{ marginBottom: 16 }}><ScanStatus progress={progress} compact onCancel={onCancel} /></div>}
      {!overview.complete && !overview.scanning && (
        <div className="notice">
          Scan stopped: showing {overview.total.toLocaleString()} of {overview.inboxTotal.toLocaleString()} inbox messages (the newest first).{' '}
          <button className="btn" onClick={onRescan}>Resume scan</button>
        </div>
      )}
      <div className="stats">
        <div className="card stat" style={hue(245)}>
          <span className="tile"><Icon name="inbox" /></span>
          <b>{overview.total.toLocaleString()}</b>
          <span>{overview.complete && !overview.scanning ? 'messages in inbox' : `of ${overview.inboxTotal.toLocaleString()} scanned`}</span>
        </div>
        <div className="card stat" style={hue(28)}>
          <span className="tile"><Icon name="unread" /></span>
          <b>{overview.unread.toLocaleString()}</b><span>unread</span>
        </div>
        <div className="card stat" style={hue(330)}>
          <span className="tile"><Icon name="subscriptions" /></span>
          <b>{overview.subscriptions.length}</b><span>subscriptions</span>
        </div>
      </div>
      <div className="grid">
        <section className="card">
          <h2>Categories</h2>
          {cats.map(([name, n]) => (
            <div key={name} className="cat-row" style={hue(categoryHue(name))}>
              <div className="cat-top"><span className="cat-name">{name[0].toUpperCase() + name.slice(1)}</span><span className="muted">{n.toLocaleString()}</span></div>
              <div className="bar"><i style={{ width: `${(n / overview.total) * 100}%` }} /></div>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Top senders</h2>
          <table className="fixed">
            <thead><tr><th>Sender</th><th className="num">Count</th><th className="num">Unread</th></tr></thead>
            <tbody>
              {overview.topSenders.map((s) => (
                <tr key={s.email}>
                  <td><div className="sender"><Avatar name={s.name || s.email} /><div>{s.name}<div className="muted">{s.email}</div></div></div></td>
                  <td className="num">{s.count.toLocaleString()}</td><td className="num">{s.unread > 0 ? <span className="count-chip" style={hue(28)}>{s.unread.toLocaleString()}</span> : <span className="muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}

function RulesTab({ onApplied, scanning }: { onApplied: () => void; scanning: boolean }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [preview, setPreview] = useState<{ rule: Rule; result: PreviewResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)

  const loadRules = () => api.listRules().then(setRules)
  useEffect(() => { loadRules() }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const toggle = (rule: Rule) => run(async () => {
    const next = { ...rule, enabled: !rule.enabled }
    await api.saveRule(next)
    setRules((rs) => rs.map((r) => (r.id === rule.id ? next : r)))
  })

  return (
    <>
      {error && <div className="notice error">{error}</div>}
      {editing && (
        <RuleEditor
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (rule) => { await api.saveRule(rule); setEditing(null); setPreview(null); await loadRules() }}
        />
      )}
      <section className="card">
        <div className="row" style={{ paddingTop: 0 }}>
          <h2 style={{ margin: 0 }}>Rules</h2>
          <button className="btn primary" disabled={!!editing} onClick={() => setEditing('new')}>New rule</button>
        </div>
        {rules.length === 0 && <p className="muted">No rules yet.</p>}
        {rules.map((rule) => (
          <div className="row" key={rule.id}>
            <div>
              <label><input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} /> <b>{rule.name}</b></label>
              <div className="muted">{describe(rule)}</div>
            </div>
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => run(async () => setPreview({ rule, result: await api.preview(rule.id) }))}>Preview</button>
              <button className="btn" disabled={busy || !!editing} onClick={() => setEditing(rule)}>Edit</button>
              <button className="btn" disabled={busy} onClick={() => run(async () => {
                if (!window.confirm(`Delete the rule "${rule.name}"? Mail already changed by it is not affected.`)) return
                await api.deleteRule(rule.id); setPreview(null); await loadRules()
              })}>Delete</button>
            </div>
          </div>
        ))}
      </section>
      {preview && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Preview: {preview.rule.name}</h2>
          <p>This would change <b>{preview.result.changes.length}</b> messages. Nothing has been changed yet.</p>
          <CoverageNote scan={{ total: preview.result.basis.scanned, inboxTotal: preview.result.basis.inboxTotal, complete: preview.result.basis.complete, scanning: preview.result.basis.scanning }} />
          {scanning && <div className="notice">A scan is running, so rules can’t be applied until it finishes or you stop it. You can still preview.</div>}
          {trashes(preview.rule) && (
            <div className="notice danger">
              <b>These messages would be moved to Trash</b>, about <b>{formatBytes(preview.result.totalBytes)}</b> in size.
              Gmail keeps Trash for 30 days and then deletes it permanently, which is when the space is freed. You can undo from the Activity tab until then.
              Check the list below carefully.
            </div>
          )}
          <table>
            <tbody>
              {preview.result.samples.map((m) => (
                <tr key={m.id}><td>{m.from.name}</td><td>{m.subject}</td><td className="muted">{new Date(m.date).toLocaleDateString()}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className={trashes(preview.rule) ? 'btn danger' : 'btn primary'} disabled={busy || scanning || preview.result.changes.length === 0}
              onClick={() => run(async () => {
                const n = preview.result.changes.length
                if (trashes(preview.rule) && !window.confirm(`Move ${n} messages to Trash?\n\nYou can undo this from the Activity tab, and Gmail empties Trash after 30 days.`)) return
                await api.apply(preview.rule.id); setPreview(null); onApplied()
              })}>
              {trashes(preview.rule) ? `Move ${preview.result.changes.length} messages to Trash` : `Apply to ${preview.result.changes.length} messages`}
            </button>
            <button className="btn" onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </section>
      )}
    </>
  )
}

function ActivityTab({ onUndone }: { onUndone: () => void }) {
  const [items, setItems] = useState<ActivityEntry[]>([])
  const load = useCallback(() => api.activity().then(setItems), [])
  useEffect(() => { load() }, [load])
  return (
    <section className="card">
      <h2>Activity</h2>
      {items.length === 0 && <p className="muted">Nothing yet. Changes you apply will appear here, and can be undone.</p>}
      {items.map((a) => (
        <div className="row" key={a.id}>
          <div className="sender">
            <span className="tile soft" style={hue(a.undone ? 220 : 155)}><Icon name={a.undone ? 'activity' : 'archive'} size={17} /></span>
            <div><b>{a.ruleName}</b> · {a.messageCount.toLocaleString()} messages<div className="muted">{new Date(a.at).toLocaleString()}</div></div>
          </div>
          {a.undone ? <span className="muted">Undone</span>
            : <button className="btn" onClick={async () => { await api.undo(a.id); await load(); onUndone() }}>Undo</button>}
        </div>
      ))}
    </section>
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
  // While a scan runs, keep the numbers current as messages arrive.
  const scanning = overview?.scanning ?? false
  useEffect(() => {
    if (!scanning) return
    const t = setInterval(() => refresh(), 3000)
    return () => clearInterval(t)
  }, [scanning, refresh])


  const account = status?.mode === 'gmail' ? status.email ?? 'Gmail' : 'Demo mailbox'
  const head = PAGES[tab]

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="subscriptions" size={16} /></span>Email Organizer</div>
        <nav role="tablist" aria-orientation="vertical">
          {TABS.map((t) => (
            <button key={t} role="tab" className="nav-item" aria-selected={tab === t} onClick={() => setTab(t)}>
              <span className="nav-ico" style={hue(PAGE_HUE[t])}><Icon name={t} size={16} /></span>{PAGES[t].title}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <StorageMeter refreshKey={`${status?.mode}:${status?.email}:${overview?.total}`} onReconnect={() => setTab('accounts')} />
          <button className="account-chip nav-item" onClick={() => setTab('accounts')} title="Manage account">
            <Avatar name={account} />
            <span style={{ minWidth: 0 }}><b>{account}</b><small>Stays on this computer</small></span>
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="content">
          <div className="page-head">
            <div><h1>{head.title}</h1><p>{head.blurb}</p></div>
            {tab === 'overview' && overview?.complete && !overview.scanning && <button className="btn" onClick={() => refresh(true)}>Rescan inbox</button>}
          </div>
          {tab === 'overview' && <OverviewTab overview={overview} error={overviewError} progress={progress} onRescan={() => refresh(true)} onCancel={() => { api.cancelScan() }} />}
          {tab === 'cleanup' && <CleanupTab onApplied={() => refresh()} />}
          {tab === 'subscriptions' && <SubscriptionsTab scan={overview} onGoToRules={() => setTab('rules')} />}
          {tab === 'rules' && <RulesTab onApplied={() => refresh()} scanning={scanning} />}
          {tab === 'activity' && <ActivityTab onUndone={() => refresh()} />}
          {tab === 'accounts' && <AccountsTab status={status} onChanged={accountChanged} />}
        </div>
      </main>
    </div>
  )
}
