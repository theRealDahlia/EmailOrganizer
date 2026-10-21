import { useCallback, useEffect, useState } from 'react'
import type { Overview, Rule } from '@organizer/core'
import type { AccountStatus, ActivityEntry, PreviewResult } from '../../shared'

type Tab = 'overview' | 'rules' | 'activity' | 'accounts'
const api = window.organizer

function describe(rule: Rule): string {
  const c = rule.conditions.map((c) => `${c.field} ${c.op} ${String(c.value)}`).join(rule.match === 'all' ? ' AND ' : ' OR ')
  const a = rule.actions.map((a) => ('label' in a ? `${a.type} "${a.label}"` : a.type)).join(', ')
  return `When ${c} → ${a}`
}

function OverviewTab({ overview, error, onRescan }: { overview: Overview | null; error: string | null; onRescan: () => void }) {
  if (error) {
    return (
      <div className="notice">
        <p className="error">{error}</p>
        <div className="actions"><button className="btn" onClick={onRescan}>Try again</button></div>
      </div>
    )
  }
  if (!overview) return <p className="muted">Scanning mailbox…</p>
  const cats = Object.entries(overview.byCategory).sort((a, b) => b[1] - a[1])
  return (
    <>
      <div className="stats">
        <div className="card stat"><b>{overview.total}</b><span>messages scanned</span></div>
        <div className="card stat"><b>{overview.unread}</b><span>unread</span></div>
        <div className="card stat"><b>{overview.subscriptions.length}</b><span>subscriptions</span></div>
        <div className="actions" style={{ alignSelf: 'flex-start' }}><button className="btn" onClick={onRescan}>Rescan</button></div>
      </div>
      <div className="grid">
        <section className="card">
          <h2>Categories</h2>
          {cats.map(([name, n]) => (
            <div key={name} style={{ marginBottom: 10 }}>
              <div className="row" style={{ padding: 0, border: 0 }}><span>{name}</span><span className="muted">{n}</span></div>
              <div className="bar"><i style={{ width: `${(n / overview.total) * 100}%` }} /></div>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Top senders</h2>
          <table>
            <thead><tr><th>Sender</th><th className="num">Count</th><th className="num">Unread</th></tr></thead>
            <tbody>
              {overview.topSenders.map((s) => (
                <tr key={s.email}><td>{s.name}<div className="muted">{s.email}</div></td><td className="num">{s.count}</td><td className="num">{s.unread}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </>
  )
}

function RulesTab({ onApplied }: { onApplied: () => void }) {
  const [rules, setRules] = useState<Rule[]>([])
  const [preview, setPreview] = useState<{ rule: Rule; result: PreviewResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { api.listRules().then(setRules) }, [])

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
      <section className="card">
        <h2>Rules</h2>
        {rules.map((rule) => (
          <div className="row" key={rule.id}>
            <div>
              <label><input type="checkbox" checked={rule.enabled} onChange={() => toggle(rule)} /> <b>{rule.name}</b></label>
              <div className="muted">{describe(rule)}</div>
            </div>
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => run(async () => setPreview({ rule, result: await api.preview(rule.id) }))}>Preview</button>
            </div>
          </div>
        ))}
      </section>
      {preview && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Preview: {preview.rule.name}</h2>
          <p>This would change <b>{preview.result.changes.length}</b> messages. Nothing has been changed yet.</p>
          <table>
            <tbody>
              {preview.result.samples.map((m) => (
                <tr key={m.id}><td>{m.from.name}</td><td>{m.subject}</td><td className="muted">{new Date(m.date).toLocaleDateString()}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={busy || preview.result.changes.length === 0}
              onClick={() => run(async () => { await api.apply(preview.rule.id); setPreview(null); onApplied() })}>
              Apply to {preview.result.changes.length} messages
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
          <div><b>{a.ruleName}</b> · {a.messageCount} messages<div className="muted">{new Date(a.at).toLocaleString()}</div></div>
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
  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [status, setStatus] = useState<AccountStatus | null>(null)

  const refresh = useCallback((force = false) => {
    setOverviewError(null)
    api.overview(force).then(setOverview, (e) => setOverviewError(e instanceof Error ? e.message : String(e)))
  }, [])
  const loadStatus = useCallback(() => { api.accountStatus().then(setStatus) }, [])
  const accountChanged = useCallback(() => { loadStatus(); setOverview(null); refresh(true) }, [loadStatus, refresh])
  useEffect(() => { loadStatus(); refresh() }, [loadStatus, refresh])

  return (
    <div className="app">
      <header>
        <h1>Email Organizer</h1>
        <span className="badge">
          {status?.mode === 'gmail' ? status.email : 'Demo mailbox'} · everything stays on this computer
        </span>
      </header>
      <nav role="tablist">
        {(['overview', 'rules', 'activity', 'accounts'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab overview={overview} error={overviewError} onRescan={() => { setOverview(null); refresh(true) }} />}
      {tab === 'rules' && <RulesTab onApplied={() => refresh()} />}
      {tab === 'activity' && <ActivityTab onUndone={() => refresh()} />}
      {tab === 'accounts' && <AccountsTab status={status} onChanged={accountChanged} />}
    </div>
  )
}
