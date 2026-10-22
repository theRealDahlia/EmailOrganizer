import { useEffect, useState } from 'react'
import {
  CLEANUP_PRESETS, GMAIL_TABS, buildQuery, describeFilters, isBroadTrash, validateCleanup,
  type CleanupFilters, type CleanupRule, type MailAction,
} from '@organizer/core'
import type { CleanupPreview } from '../../shared'
import { formatBytes } from './format'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const trashes = (r: CleanupRule) => r.actions.some((a) => a.type === 'trash')

function describeActions(actions: MailAction[]): string {
  return actions.map((a) => (a.type === 'addLabel' ? `label “${a.label}”` : a.type === 'trash' ? 'move to Trash' : a.type === 'markRead' ? 'mark read' : a.type)).join(', ')
}

function Editor({ initial, onSave, onCancel }: { initial: CleanupRule; onSave: (r: CleanupRule) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial.name)
  const [f, setF] = useState<CleanupFilters>(initial.filters)
  const hasAction = (t: MailAction['type']) => initial.actions.some((a) => a.type === t)
  const existingLabel = initial.actions.find((a): a is Extract<MailAction, { type: 'addLabel' }> => a.type === 'addLabel')
  const [label, setLabel] = useState(existingLabel?.label ?? '')
  const [archive, setArchive] = useState(hasAction('archive'))
  const [trash, setTrash] = useState(hasAction('trash'))
  const [markRead, setMarkRead] = useState(hasAction('markRead'))
  const [allowBroad, setAllowBroad] = useState(!!initial.allowBroad)
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const actions: MailAction[] = []
  if (label.trim()) actions.push({ type: 'addLabel', label: label.trim() })
  if (trash) actions.push({ type: 'trash' })
  else if (archive) actions.push({ type: 'archive' })
  if (markRead) actions.push({ type: 'markRead' })
  const rule: CleanupRule = { id: initial.id, name: name.trim(), filters: f, actions, ...(allowBroad && { allowBroad: true }) }
  const broad = isBroadTrash({ filters: f, actions })

  const set = <K extends keyof CleanupFilters>(key: K, value: CleanupFilters[K] | '' | undefined) =>
    setF((cur) => {
      const next = { ...cur }
      if (value === '' || value === undefined || value === false) delete next[key]
      else next[key] = value as CleanupFilters[K]
      return next
    })
  const whole = (v: string) => (v === '' ? undefined : Math.max(0, Math.floor(Number(v))) || undefined)

  const save = async () => {
    const found = validateCleanup(rule)
    setProblems(found)
    if (found.length) return
    setSaving(true)
    try { await onSave(rule) } catch (e) { setProblems([errorText(e)]) } finally { setSaving(false) }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Cleanup rule</h2>
      <div className="form" style={{ maxWidth: 640 }}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Old promotions" /></label>

        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Find inbox mail that is…</div>
          <div className="cond">
            <label className="inline">In the tab
              <select value={f.category ?? ''} onChange={(e) => set('category', (e.target.value || undefined) as CleanupFilters['category'])}>
                <option value="">any</option>
                {GMAIL_TABS.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
              </select>
            </label>
            <label className="inline">Older than
              <input type="number" min={0} style={{ width: 70 }} value={f.olderThan?.value ?? ''}
                onChange={(e) => { const v = whole(e.target.value); set('olderThan', v ? { value: v, unit: f.olderThan?.unit ?? 'm' } : undefined) }} />
              <select value={f.olderThan?.unit ?? 'm'} onChange={(e) => f.olderThan && set('olderThan', { ...f.olderThan, unit: e.target.value as 'd' | 'm' | 'y' })}>
                <option value="d">days</option><option value="m">months</option><option value="y">years</option>
              </select>
            </label>
            <label className="inline">Larger than
              <input type="number" min={0} style={{ width: 70 }} value={f.largerThanMB ?? ''} onChange={(e) => set('largerThanMB', whole(e.target.value))} /> MB
            </label>
          </div>
          <div className="cond">
            <input placeholder="From (name, address or domain)" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} spellCheck={false} />
            <input placeholder="Subject contains" value={f.subject ?? ''} onChange={(e) => set('subject', e.target.value)} />
          </div>
          <div className="cond">
            <label className="inline"><input type="checkbox" checked={!!f.hasAttachment} onChange={(e) => set('hasAttachment', e.target.checked)} /> Has an attachment</label>
            <label className="inline">Read state
              <select value={f.read ?? ''} onChange={(e) => set('read', (e.target.value || undefined) as CleanupFilters['read'])}>
                <option value="">any</option><option value="read">read</option><option value="unread">unread</option>
              </select>
            </label>
          </div>
          <div className="cond">
            <label className="inline"><input type="checkbox" checked={!!f.keepStarred} onChange={(e) => set('keepStarred', e.target.checked)} /> Keep starred mail</label>
            <label className="inline"><input type="checkbox" checked={!!f.keepImportant} onChange={(e) => set('keepImportant', e.target.checked)} /> Keep mail Gmail marks important</label>
          </div>
          <details>
            <summary className="muted">Advanced: add your own Gmail search terms</summary>
            <input style={{ width: '100%', marginTop: 8 }} placeholder="e.g. from:(a OR b) -subject:receipt" value={f.extra ?? ''} onChange={(e) => set('extra', e.target.value)} spellCheck={false} />
          </details>
        </div>

        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Then:</div>
          <label className="inline"><input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} /> <span><b>Move to Trash</b> <span className="muted">frees space. Gmail keeps Trash 30 days, so you can undo.</span></span></label>
          <label className="inline"><input type="checkbox" checked={archive && !trash} disabled={trash} onChange={(e) => setArchive(e.target.checked)} /> Archive (remove from inbox)</label>
          <label className="inline"><input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark as read</label>
          <label className="inline">Add label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="(optional)" /></label>
        </div>

        {broad && (
          <div className="notice danger">
            <b>This rule can reach everyday mail.</b> With only age or read state as filters, it would move all matching mail to Trash, including receipts and personal mail. Starred mail is safest to keep, and you can undo for 30 days.
            <label className="inline" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={allowBroad} onChange={(e) => setAllowBroad(e.target.checked)} />
              <span><b>Include everyday mail.</b> I understand. I’ll be asked to type TRASH before it runs.</span>
            </label>
          </div>
        )}
        <div className="muted">Gmail search: <code>{buildQuery(f, actions)}</code></div>
        {problems.length > 0 && <div className="error">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
        <div className="actions">
          <button className="btn primary" disabled={saving} onClick={save}>Save rule</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  )
}

export function CleanupTab({ onApplied }: { onApplied: () => void }) {
  const [rules, setRules] = useState<CleanupRule[]>([])
  const [editing, setEditing] = useState<CleanupRule | null>(null)
  const [preview, setPreview] = useState<{ rule: CleanupRule; result: CleanupPreview } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  const load = () => api.cleanupRules().then(setRules)
  useEffect(() => { load() }, [])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Cleanup rules ask Gmail to find the mail, so they work on your whole inbox right away. No scan is needed, and nothing is downloaded except a small sample for the preview.
      </p>
      {error && <div className="notice error">{error}</div>}
      {done && <div className="notice" style={{ color: 'var(--ok)' }}>{done}</div>}

      {editing && (
        <Editor
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={async (rule) => { await api.saveCleanupRule(rule); setEditing(null); setPreview(null); await load() }}
        />
      )}

      <section className="card">
        <div className="row" style={{ paddingTop: 0 }}>
          <h2 style={{ margin: 0 }}>Your cleanup rules</h2>
          <button className="btn primary" disabled={!!editing} onClick={() => { setDone(null); setEditing({ id: crypto.randomUUID(), name: '', filters: {}, actions: [] }) }}>New rule</button>
        </div>
        {rules.length === 0 && <p className="muted">None yet. Start from an idea below, or make your own.</p>}
        {rules.map((rule) => (
          <div className="row" key={rule.id}>
            <div>
              <b>{rule.name}</b>
              <div className="muted">{describeFilters(rule.filters)} → {describeActions(rule.actions)}</div>
            </div>
            <div className="actions">
              <button className="btn" disabled={!!busy} onClick={() => run(rule.id, async () => { setDone(null); setTyped(''); setPreview({ rule, result: await api.previewCleanup(rule.id) }) })}>
                {busy === rule.id ? 'Searching…' : 'Preview'}
              </button>
              <button className="btn" disabled={!!busy || !!editing} onClick={() => { setDone(null); setEditing(rule) }}>Edit</button>
              <button className="btn" disabled={!!busy} onClick={() => run('delete', async () => {
                if (!window.confirm(`Delete the rule “${rule.name}”? Mail it already changed is not affected.`)) return
                await api.deleteCleanupRule(rule.id); setPreview(null); await load()
              })}>Delete</button>
            </div>
          </div>
        ))}
      </section>

      {preview && (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>Preview: {preview.rule.name}</h2>
          <p>
            Gmail found <b>{preview.result.count.toLocaleString()}</b> matching messages.
            {preview.result.count > 0 && <> About <b>{formatBytes(preview.result.bytes)}</b>{preview.result.bytesAreEstimate ? ` (estimated from ${preview.result.sampled} sampled)` : ''}.</>}
            {' '}Nothing has been changed yet.
          </p>
          {trashes(preview.rule) && preview.result.count > 0 && (
            <div className="notice danger">
              <b>These messages would be moved to Trash.</b> Gmail keeps Trash for 30 days and then deletes it permanently, which is when the space is freed. You can undo from the Activity tab until then.
            </div>
          )}
          {preview.result.samples.length > 0 && (
            <table>
              <tbody>
                {preview.result.samples.map((m) => (
                  <tr key={m.id}><td>{m.from.name}</td><td>{m.subject}</td><td className="muted">{new Date(m.date).toLocaleDateString()}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">Gmail search: <code>{preview.result.query}</code></p>
          {isBroadTrash(preview.rule) && preview.result.count > 0 && (
            <div className="form" style={{ marginBottom: 12 }}>
              <label>
                This rule can reach everyday mail. Look over the examples, then type <b>TRASH</b> to enable the button.
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="TRASH" autoComplete="off" spellCheck={false} style={{ maxWidth: 200 }} />
              </label>
            </div>
          )}
          <div className="actions">
            <button
              className={trashes(preview.rule) ? 'btn danger' : 'btn primary'}
              disabled={!!busy || preview.result.count === 0 || (isBroadTrash(preview.rule) && typed.trim().toUpperCase() !== 'TRASH')}
              onClick={() => run('apply', async () => {
                const n = preview.result.count
                if (trashes(preview.rule) && !isBroadTrash(preview.rule) && !window.confirm(`Move ${n.toLocaleString()} messages to Trash?\n\nYou can undo this from the Activity tab, and Gmail empties Trash after 30 days.`)) return
                const entry = await api.applyCleanup(preview.rule.id, n, typed)
                setPreview(null)
                setDone(`Done: ${entry.messageCount.toLocaleString()} messages changed. You can undo it from the Activity tab.`)
                onApplied()
              })}
            >
              {busy === 'apply' ? 'Working…' : trashes(preview.rule) ? `Move ${preview.result.count.toLocaleString()} messages to Trash` : `Apply to ${preview.result.count.toLocaleString()} messages`}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </section>
      )}

      <section style={{ marginTop: 24 }}>
        <h2>Ideas to start from</h2>
        <div className="grid">
          {CLEANUP_PRESETS.map((p) => (
            <div className="card" key={p.name}>
              <b>{p.name}</b>
              <p className="muted" style={{ margin: '4px 0 12px' }}>{p.blurb}</p>
              <button className="btn" disabled={!!editing} onClick={() => { setDone(null); setEditing({ id: crypto.randomUUID(), name: p.name, filters: p.filters, actions: p.actions }) }}>Use this</button>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
