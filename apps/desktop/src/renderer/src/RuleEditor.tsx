import { useState } from 'react'
import { CATEGORIES, CONDITION_SPECS, validateRule, type Category, type Condition, type MailAction, type Rule } from '@organizer/core'

const FIELDS = Object.keys(CONDITION_SPECS) as Condition['field'][]
const OP_LABEL: Record<string, string> = { equals: 'is', contains: 'contains', gte: 'at least' }

function defaultCondition(field: Condition['field']): Condition {
  switch (field) {
    case 'category': return { field, op: 'equals', value: 'newsletter' }
    case 'olderThanDays': return { field, op: 'gte', value: 30 }
    case 'isUnread': return { field, op: 'equals', value: true }
    case 'senderEmail': return { field, op: 'contains', value: '' }
    case 'senderDomain': return { field, op: 'equals', value: '' }
    case 'subject': return { field, op: 'contains', value: '' }
  }
}

function ValueInput({ c, onChange }: { c: Condition; onChange: (c: Condition) => void }) {
  const set = (value: unknown) => onChange({ ...c, value } as Condition)
  switch (CONDITION_SPECS[c.field].kind) {
    case 'number':
      return <input type="number" min={0} value={Number(c.value)} onChange={(e) => set(e.target.valueAsNumber || 0)} />
    case 'category':
      return <select value={String(c.value)} onChange={(e) => set(e.target.value as Category)}>{CATEGORIES.map((k) => <option key={k}>{k}</option>)}</select>
    case 'boolean':
      return <select value={String(c.value)} onChange={(e) => set(e.target.value === 'true')}><option value="true">yes</option><option value="false">no</option></select>
    default:
      return <input value={String(c.value)} onChange={(e) => set(e.target.value)} placeholder={c.field === 'senderDomain' ? 'example.com' : ''} spellCheck={false} />
  }
}

/** Form for creating or editing a rule. Actions the form can't show are kept as they were. */
export function RuleEditor({ initial, onSave, onCancel }: { initial: Rule | null; onSave: (r: Rule) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [match, setMatch] = useState<Rule['match']>(initial?.match ?? 'all')
  const [conditions, setConditions] = useState<Condition[]>(initial?.conditions ?? [defaultCondition('senderDomain')])
  const initialActions = initial?.actions ?? []
  const existingLabel = initialActions.find((a): a is Extract<MailAction, { type: 'addLabel' }> => a.type === 'addLabel')
  const [label, setLabel] = useState(existingLabel?.label ?? '')
  const [archive, setArchive] = useState(initialActions.some((a) => a.type === 'archive'))
  const [trash, setTrash] = useState(initialActions.some((a) => a.type === 'trash'))
  const [markRead, setMarkRead] = useState(initialActions.some((a) => a.type === 'markRead'))
  const [problems, setProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const build = (): Rule => {
    const kept = initialActions.filter((a) => !['addLabel', 'archive', 'markRead', 'trash'].includes(a.type))
    const actions: MailAction[] = [...kept]
    if (label.trim()) actions.push({ type: 'addLabel', label: label.trim() })
    if (trash) actions.push({ type: 'trash' })
    else if (archive) actions.push({ type: 'archive' })
    if (markRead) actions.push({ type: 'markRead' })
    return { id: initial?.id ?? crypto.randomUUID(), name: name.trim(), enabled: initial?.enabled ?? true, match, conditions, actions }
  }

  const save = async () => {
    const rule = build()
    const found = validateRule(rule)
    setProblems(found)
    if (found.length) return
    setSaving(true)
    try { await onSave(rule) } catch (e) { setProblems([e instanceof Error ? e.message : String(e)]) } finally { setSaving(false) }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>{initial ? 'Edit rule' : 'New rule'}</h2>
      <div className="form" style={{ maxWidth: 640 }}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Archive old promotions" /></label>

        <div>
          <div className="muted" style={{ marginBottom: 6 }}>
            When{' '}
            <select value={match} onChange={(e) => setMatch(e.target.value as Rule['match'])}>
              <option value="all">all</option><option value="any">any</option>
            </select>{' '}of these match:
          </div>
          {conditions.map((c, i) => (
            <div className="cond" key={i}>
              <select value={c.field} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? defaultCondition(e.target.value as Condition['field']) : x)))}>
                {FIELDS.map((f) => <option key={f} value={f}>{CONDITION_SPECS[f].label}</option>)}
              </select>
              <select value={c.op} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? ({ ...x, op: e.target.value } as Condition) : x)))}>
                {CONDITION_SPECS[c.field].ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
              </select>
              <ValueInput c={c} onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))} />
              <button className="btn" aria-label="Remove condition" onClick={() => setConditions(conditions.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn" onClick={() => setConditions([...conditions, defaultCondition('senderEmail')])}>+ Add condition</button>
        </div>

        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Then:</div>
          <label className="inline">Add label <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="(optional) e.g. Receipts" /></label>
          <label className="inline"><input type="checkbox" checked={archive && !trash} disabled={trash} onChange={(e) => setArchive(e.target.checked)} /> Archive (remove from inbox)</label>
          <label className="inline"><input type="checkbox" checked={trash} onChange={(e) => setTrash(e.target.checked)} /> <span><b>Move to Trash</b> <span className="muted">to free space and declutter. Gmail keeps Trash for 30 days, so you can undo, then deletes it for good.</span></span></label>
          <label className="inline"><input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark as read</label>
        </div>

        {problems.length > 0 && <div className="error">{problems.map((p) => <div key={p}>{p}</div>)}</div>}
        <p className="muted" style={{ margin: 0 }}>Saving never changes your mail. Use Preview on the rule to see what it would do first.</p>
        <div className="actions">
          <button className="btn primary" disabled={saving} onClick={save}>Save rule</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </section>
  )
}
