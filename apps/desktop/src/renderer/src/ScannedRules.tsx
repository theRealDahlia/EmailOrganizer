import { useEffect, useState } from 'react'
import type { Rule } from '@organizer/core'
import { AUTO_TRASH_LIMIT, type PreviewResult } from '../../shared'
import { MoveChips } from './Badges'
import { formatBytes } from './format'
import { CoverageNote } from './ScanStatus'

const api = window.organizer

const trashes = (rule: Rule) => rule.actions.some((a) => a.type === 'trash')

function describe(rule: Rule): string {
  const c = rule.conditions.map((c) => `${c.field} ${c.op} ${String(c.value)}`).join(rule.match === 'all' ? ' AND ' : ' OR ')
  const a = rule.actions.map((a) => ('label' in a ? `${a.type} "${a.label}"` : a.type === 'trash' ? 'move to Trash' : a.type)).join(', ')
  return `When ${c} → ${a}`
}

/**
 * Rules that match on what the app has downloaded (sender, domain, subject and categories such as Receipts or Travel)
 * rather than on a Gmail search. They sit in the same list as cleanup rules; this holds their state and actions.
 */
export function useScannedRules(onApplied: () => void) {
  const [rules, setRules] = useState<Rule[]>([])
  const [preview, setPreview] = useState<{ rule: Rule; result: PreviewResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Rule | 'new' | null>(null)

  const load = () => api.listRules().then(setRules)
  useEffect(() => { load() }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const replace = (next: Rule) => setRules((rs) => rs.map((r) => (r.id === next.id ? next : r)))

  return {
    rules, preview, busy, error, editing, setEditing, setPreview, load, setError,
    /** Turn a rule's automatic runs on or off; turning them on for Trash needs a yes. */
    toggleAuto: (rule: Rule) => run(async () => {
      const next: Rule = { ...rule, auto: !rule.auto }
      if (!next.auto) delete next.auto
      else if (trashes(next) && !window.confirm(`Turn on automatic runs for “${rule.name}”?\n\nMail that matches will be moved to Trash about every 30 minutes without asking, up to ${AUTO_TRASH_LIMIT.toLocaleString()} messages a run. Every run appears in Activity and can be undone.`)) return
      await api.saveRule(next); replace(next)
    }),
    toggleEnabled: (rule: Rule) => run(async () => { const next = { ...rule, enabled: !rule.enabled }; await api.saveRule(next); replace(next) }),
    startPreview: (rule: Rule) => run(async () => setPreview({ rule, result: await api.preview(rule.id) })),
    remove: (rule: Rule) => run(async () => {
      if (!window.confirm(`Delete the rule "${rule.name}"? Mail already changed by it is not affected.`)) return
      await api.deleteRule(rule.id); setPreview(null); await load()
    }),
    apply: (p: { rule: Rule; result: PreviewResult }) => run(async () => {
      const n = p.result.changes.length
      if (trashes(p.rule) && !window.confirm(`Move ${n} messages to Trash?\n\nYou can undo this from the Activity tab, and Gmail empties Trash after 30 days.`)) return
      await api.apply(p.rule.id); setPreview(null); onApplied()
    }),
  }
}

export type ScannedRules = ReturnType<typeof useScannedRules>

/** One scanned-mail rule as a row of the shared list. `locked` disables the buttons while something else is busy. */
export function ScannedRuleRow({ rule, h, locked, handled }: { rule: Rule; h: ScannedRules; locked: boolean; handled?: number }) {
  return (
    <div className="row">
      <div>
        <label><input type="checkbox" checked={rule.enabled} disabled={locked} onChange={() => h.toggleEnabled(rule)} /> <b>{rule.name}</b></label>
        <span className="pill scanned" title="Matches on mail the app has downloaded (your newest messages, or the whole inbox after a full scan)">Scanned mail</span>
        {rule.auto && rule.enabled && <span className="pill ok" title="Applied on its own, about every 30 minutes while the app is open">Automatic</span>}
        <div className="muted">{describe(rule)} <MoveChips actions={rule.actions} />{handled ? <span className="handled">Handled {handled.toLocaleString()} {handled === 1 ? 'message' : 'messages'}</span> : null}</div>
      </div>
      <div className="actions">
        <label className="auto-toggle" title="Apply this on its own, with no preview">
          <input type="checkbox" checked={!!rule.auto} disabled={locked} onChange={() => h.toggleAuto(rule)} /> Auto
        </label>
        <button className="btn" disabled={locked} onClick={() => h.startPreview(rule)}>Preview</button>
        <button className="btn" disabled={locked || !!h.editing} onClick={() => h.setEditing(rule)}>Edit</button>
        <button className="btn" disabled={locked} onClick={() => h.remove(rule)}>Delete</button>
      </div>
    </div>
  )
}

export function ScannedPreview({ h, scanning }: { h: ScannedRules; scanning: boolean }) {
  const { preview, busy } = h
  if (!preview) return null
  return (
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
        <button className={trashes(preview.rule) ? 'btn danger' : 'btn primary'} disabled={busy || scanning || preview.result.changes.length === 0} onClick={() => h.apply(preview)}>
          {trashes(preview.rule) ? `Move ${preview.result.changes.length} messages to Trash` : `Apply to ${preview.result.changes.length} messages`}
        </button>
        <button className="btn" onClick={() => h.setPreview(null)}>Cancel</button>
      </div>
    </section>
  )
}
