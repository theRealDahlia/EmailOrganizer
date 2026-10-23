import { useEffect, useState } from 'react'
import {
  CLEANUP_PRESETS, GMAIL_TABS, buildQuery, describeFilters, isBroadTrash, validateCleanup,
  type CleanupFilters, type CleanupRule, type MailAction,
} from '@organizer/core'
import { AUTO_TRASH_LIMIT, type CleanupPreview } from '../../shared'
import { AutomationNotice } from './AutomationNotice'
import { MoveChip, MoveChips } from './Badges'
import { formatBytes } from './format'
import { Icon, hue } from './Icons'
import { RuleEditor } from './RuleEditor'
import { TypeToggle, type TypeToggleProps } from './TypeToggle'
import { ScannedPreview, ScannedRuleRow, useScannedRules } from './ScannedRules'

const IDEA_HUES = [330, 200, 12, 155]

type RunMode = 'review' | 'once' | 'auto'
const RUN_MODES: { value: RunMode; icon: string; hue: number; title: string; blurb: string }[] = [
  { value: 'review', icon: 'check', hue: 245, title: 'Review first', blurb: 'Save it, then preview what it would do and apply it yourself.' },
  { value: 'once', icon: 'undo', hue: 28, title: 'Run once, then remove', blurb: 'Runs as soon as you save, with no preview, then deletes itself.' },
  { value: 'auto', icon: 'clock', hue: 155, title: 'Run automatically', blurb: 'Keeps applying itself to new mail, with no preview.' },
]

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const trashes = (r: CleanupRule) => r.actions.some((a) => a.type === 'trash')

function describeActions(actions: MailAction[]): string {
  return actions.map((a) => (a.type === 'addLabel' ? `label “${a.label}”` : a.type === 'trash' ? 'move to Trash' : a.type === 'markRead' ? 'mark read' : a.type)).join(', ')
}

function Editor({ initial, onSave, onCancel, typeToggle }: { initial: CleanupRule; onSave: (r: CleanupRule) => Promise<void>; onCancel: () => void; typeToggle?: TypeToggleProps }) {
  const [name, setName] = useState(initial.name)
  const [f, setF] = useState<CleanupFilters>(initial.filters)
  const hasAction = (t: MailAction['type']) => initial.actions.some((a) => a.type === t)
  const existingLabel = initial.actions.find((a): a is Extract<MailAction, { type: 'addLabel' }> => a.type === 'addLabel')
  const [label, setLabel] = useState(existingLabel?.label ?? '')
  const [archive, setArchive] = useState(hasAction('archive'))
  const [trash, setTrash] = useState(hasAction('trash'))
  const [markRead, setMarkRead] = useState(hasAction('markRead'))
  const [allowBroad, setAllowBroad] = useState(!!initial.allowBroad)
  const [mode, setMode] = useState<RunMode>(initial.runOnce ? 'once' : initial.auto ? 'auto' : 'review')
  const [autoTrashOk, setAutoTrashOk] = useState(!!initial.auto) // an existing automatic rule was already agreed to
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const actions: MailAction[] = []
  if (label.trim()) actions.push({ type: 'addLabel', label: label.trim() })
  if (trash) actions.push({ type: 'trash' })
  else if (archive) actions.push({ type: 'archive' })
  if (markRead) actions.push({ type: 'markRead' })
  const rule: CleanupRule = {
    id: initial.id, name: name.trim(), filters: f, actions,
    ...(allowBroad && { allowBroad: true }), ...(mode === 'once' && { runOnce: true }), ...(mode === 'auto' && { auto: true }),
  }
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
    if (mode === 'auto' && trash && !autoTrashOk) found.push('Tick the box to confirm that matching mail may be moved to Trash automatically.')
    setProblems(found)
    if (found.length) return
    setSaving(true)
    try { await onSave(rule) } catch (e) { setProblems([errorText(e)]) } finally { setSaving(false) }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Cleanup rule</h2>
      {typeToggle && <TypeToggle toggle={typeToggle} name={name} />}
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
          <label className="inline"><input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} /> <span><b>Move to Trash</b> <MoveChip move="trash" /> <span className="muted">frees space. Gmail keeps Trash 30 days, so you can undo.</span></span></label>
          <label className="inline"><input type="checkbox" checked={archive && !trash} disabled={trash} onChange={(e) => setArchive(e.target.checked)} /> <span>Archive (remove from inbox) <MoveChip move="archive" /></span></label>
          <label className="inline"><input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark as read</label>
          <label className="inline">Add label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="(optional)" /></label>
        </div>

        <fieldset className="modes">
          <legend className="muted">How should it run?</legend>
          {RUN_MODES.map((m) => (
            <label key={m.value} className={`mode${mode === m.value ? ' on' : ''}`} style={hue(m.hue)}>
              <input type="radio" name="run-mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} />
              <span className="tile soft"><Icon name={m.icon} size={16} /></span>
              <span className="mode-text"><b>{m.title}</b><span className="muted">{m.blurb}</span></span>
            </label>
          ))}
        </fieldset>
        {mode === 'once' && trash && <div className="muted">Because this moves mail to Trash, you’ll see how many messages it found and confirm before anything moves.</div>}
        {mode === 'auto' && (
          <div className={`notice${trash ? ' danger' : ''}`}>
            Runs a few seconds after you save, then about every 30 minutes while the app is open. Nothing is previewed, so every run appears in Activity and can be undone.
            {trash && <> It moves at most {AUTO_TRASH_LIMIT.toLocaleString()} messages to Trash per run, and leaves bigger matches for you to review.</>}
            {trash && (
              <label className="inline" style={{ marginTop: 8 }}>
                <input type="checkbox" checked={autoTrashOk} onChange={(e) => setAutoTrashOk(e.target.checked)} />
                <span><b>Move matching mail to Trash automatically.</b> I understand nothing asks me first.</span>
              </label>
            )}
          </div>
        )}

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
          <button className="btn primary" disabled={saving} onClick={save}>{mode === 'once' ? 'Save and run once' : mode === 'auto' ? 'Save and turn on' : 'Save rule'}</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  )
}

/** A starting point for the editor, such as the filters for one sender. */
export interface CleanupPrefill { name: string; filters: CleanupFilters; actions: MailAction[] }

export function CleanupTab({ onApplied, scanning, prefill, onPrefillUsed }: { onApplied: () => void; scanning: boolean; prefill?: CleanupPrefill | null; onPrefillUsed?: () => void }) {
  const scanned = useScannedRules(onApplied)
  const [rules, setRules] = useState<CleanupRule[]>([])
  const [editing, setEditing] = useState<CleanupRule | null>(null)
  const [preview, setPreview] = useState<{ rule: CleanupRule; result: CleanupPreview } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  // A run-once cleanup that is waiting for the user to confirm moving mail to Trash.
  const [once, setOnce] = useState<{ rule: CleanupRule; count: number } | null>(null)

  const anyEditing = !!editing || !!scanned.editing
  // What was typed in the rule name, carried across when a new rule switches between the two forms.
  const [carriedName, setCarriedName] = useState('')
  const blankNew = (r: CleanupRule) => !rules.some((x) => x.id === r.id) && Object.keys(r.filters).length === 0 && r.actions.length === 0
  const newBlankRule = (name = ''): CleanupRule => ({ id: crypto.randomUUID(), name, filters: {}, actions: [] })
  /** The "use scanned mail" box: swap a blank new rule between the Gmail-search form and the sort-by-type form. */
  const switchForm = (byType: boolean, name: string) => {
    setCarriedName(name)
    if (byType) { setEditing(null); scanned.setEditing('new') } else { scanned.setEditing(null); setEditing(newBlankRule(name)) }
  }
  const load = () => api.cleanupRules().then(setRules)
  useEffect(() => { load() }, [])
  useEffect(() => {
    if (!prefill) return
    setDone(null)
    setEditing({ id: crypto.randomUUID(), name: prefill.name, filters: prefill.filters, actions: prefill.actions })
    onPrefillUsed?.()
  }, [prefill]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  /** Run a "run once" cleanup now, with no preview: count the matches, confirm only if it trashes, run, remove. */
  const startOnce = (rule: CleanupRule) => run(`once-${rule.id}`, async () => {
    setDone(null); setTyped(''); setPreview(null)
    const { count } = await api.cleanupCount(rule.id)
    if (count === 0) {
      await api.deleteCleanupRule(rule.id); await load()
      setDone('Nothing matched, so nothing was moved. The cleanup was removed.')
      return
    }
    if (trashes(rule)) { setOnce({ rule, count }); return } // moving to Trash always asks, with the count
    await finishOnce(rule, count)
  })

  const finishOnce = async (rule: CleanupRule, count: number, confirmation?: string) => {
    const entry = await api.applyCleanup(rule.id, count, confirmation)
    setOnce(null); await load()
    setDone(`Done: ${entry.messageCount.toLocaleString()} messages ${trashes(rule) ? 'moved to Trash' : 'changed'}. The cleanup was removed. You can undo it from the Activity tab.`)
    onApplied()
  }

  /** Turn a cleanup's automatic runs on or off; turning them on for Trash needs a yes. */
  const toggleAuto = (rule: CleanupRule) => run(`auto-${rule.id}`, async () => {
    const next: CleanupRule = { ...rule, auto: !rule.auto }
    if (!next.auto) delete next.auto
    else {
      const problems = validateCleanup(next)
      if (problems.length) throw new Error(problems[0])
      if (trashes(next) && !window.confirm(`Turn on automatic runs for “${rule.name}”?\n\nMail that matches will be moved to Trash about every 30 minutes without asking, up to ${AUTO_TRASH_LIMIT.toLocaleString()} messages a run. Every run appears in Activity and can be undone.`)) return
    }
    await api.saveCleanupRule(next); await load()
  })

  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Rules ask Gmail to find the mail, so they cover your whole inbox right away. There’s no scan, and the only thing downloaded is a small sample for the preview. Rules tagged “Scanned mail” work differently: they sort mail by type, like receipts or travel, so they only see what the app has already downloaded.
      </p>
      {(error ?? scanned.error) && <div className="notice error">{error ?? scanned.error}</div>}
      {done && <div className="notice" style={{ color: 'var(--ok)' }}>{done}</div>}
      <AutomationNotice active={rules.some((r) => r.auto) || scanned.rules.some((r) => r.auto && r.enabled)} onRan={() => { load(); scanned.load() }} />

      {once && (
        <section className="card run-confirm" style={hue(12)}>
          <h2>Run “{once.rule.name}” once?</h2>
          <p>
            Gmail found <b>{once.count.toLocaleString()}</b> {once.count === 1 ? 'message' : 'messages'} that match. They will be moved to Trash, and then this cleanup is removed.
            {' '}Gmail keeps Trash for 30 days and you can undo from Activity until then.
          </p>
          <p className="muted">Gmail search: <code>{buildQuery(once.rule.filters, once.rule.actions)}</code></p>
          {isBroadTrash(once.rule) && (
            <div className="form" style={{ marginBottom: 12 }}>
              <label>
                This cleanup can reach everyday mail. Type <b>TRASH</b> to enable the button.
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="TRASH" autoComplete="off" spellCheck={false} style={{ maxWidth: 200 }} />
              </label>
            </div>
          )}
          <div className="actions">
            <button className="btn danger" disabled={!!busy || (isBroadTrash(once.rule) && typed.trim().toUpperCase() !== 'TRASH')}
              onClick={() => run('once-apply', () => finishOnce(once.rule, once.count, typed))}>
              {busy === 'once-apply' ? 'Working…' : `Move ${once.count.toLocaleString()} to Trash and remove cleanup`}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setOnce(null)}>Not now, keep it saved</button>
          </div>
        </section>
      )}

      {editing && (
        <Editor
          initial={editing}
          typeToggle={blankNew(editing) ? { checked: false, onChange: switchForm } : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (rule) => {
            await api.saveCleanupRule(rule); setEditing(null); setPreview(null); setOnce(null); await load()
            if (rule.runOnce) void startOnce(rule)
            else if (rule.auto) setDone('Automatic cleanup is on. It starts in a few seconds, and each run appears in Activity.')
          }}
        />
      )}

      {scanned.editing && (
        <RuleEditor
          initial={scanned.editing === 'new' ? null : scanned.editing}
          initialName={carriedName}
          typeToggle={scanned.editing === 'new' ? { checked: true, onChange: switchForm } : undefined}
          onCancel={() => scanned.setEditing(null)}
          onSave={async (rule) => { await window.organizer.saveRule(rule); scanned.setEditing(null); scanned.setPreview(null); await scanned.load() }}
        />
      )}

      <section className="card">
        <div className="row" style={{ paddingTop: 0 }}>
          <h2 style={{ margin: 0 }}>Your rules</h2>
          <button className="btn primary" disabled={anyEditing} onClick={() => { setDone(null); setCarriedName(''); setEditing(newBlankRule()) }}>New rule</button>
        </div>
        {rules.length === 0 && scanned.rules.length === 0 && <p className="muted">None yet. Start from an idea below, or make your own.</p>}
        {rules.map((rule) => (
          <div className="row" key={rule.id}>
            <div>
              <b>{rule.name}</b>
              {rule.runOnce && <span className="pill once" title="Runs one time, then removes itself">Runs once</span>}
              {rule.auto && <span className="pill ok" title="Applied on its own, about every 30 minutes while the app is open">Automatic</span>}
              <div className="muted">{describeFilters(rule.filters)} → {describeActions(rule.actions)} <MoveChips actions={rule.actions} /></div>
            </div>
            <div className="actions">
              {rule.runOnce ? (
                <button className="btn primary" disabled={!!busy || anyEditing} onClick={() => startOnce(rule)}>
                  {busy === `once-${rule.id}` ? 'Searching…' : 'Run now'}
                </button>
              ) : (
                <label className="auto-toggle" title="Apply this on its own, with no preview">
                  <input type="checkbox" checked={!!rule.auto} disabled={!!busy} onChange={() => toggleAuto(rule)} /> Auto
                </label>
              )}
              <button className="btn" disabled={!!busy} onClick={() => run(rule.id, async () => { setDone(null); setTyped(''); setOnce(null); setPreview({ rule, result: await api.previewCleanup(rule.id) }) })}>
                {busy === rule.id ? 'Searching…' : 'Preview'}
              </button>
              <button className="btn" disabled={!!busy || anyEditing} onClick={() => { setDone(null); setEditing(rule) }}>Edit</button>
              <button className="btn" disabled={!!busy} onClick={() => run('delete', async () => {
                if (!window.confirm(`Delete the rule “${rule.name}”? Mail it already changed is not affected.`)) return
                await api.deleteCleanupRule(rule.id); setPreview(null); setOnce(null); await load()
              })}>Delete</button>
            </div>
          </div>
        ))}
        {scanned.rules.map((rule) => <ScannedRuleRow key={rule.id} rule={rule} h={scanned} locked={!!busy || scanned.busy} />)}
      </section>

      <ScannedPreview h={scanned} scanning={scanning} />

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
                setDone(`Done: ${entry.messageCount.toLocaleString()} messages changed.${entry.ruleRemoved ? ' The cleanup was removed.' : ''} You can undo it from the Activity tab.`)
                if (entry.ruleRemoved) await load()
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
          {CLEANUP_PRESETS.map((p, i) => (
            <div className="card idea" key={p.name} style={hue(IDEA_HUES[i % IDEA_HUES.length])}>
              <span className="tile soft"><Icon name={p.actions.some((a) => a.type === 'trash') ? 'cleanup' : 'archive'} size={17} /></span>
              <b>{p.name}</b>
              <MoveChips actions={p.actions} long />
              <p className="muted">{p.blurb}</p>
              <button className="btn" disabled={!!editing} onClick={() => { setDone(null); setEditing({ id: crypto.randomUUID(), name: p.name, filters: p.filters, actions: p.actions }) }}>Use this</button>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
