import { useEffect, useState } from 'react'
import { parseListUnsubscribe, type Subscription } from '@organizer/core'
import type { ActivityEntry, SenderAction, SenderSummary } from '../../shared'
import { MoveChip } from './Badges'
import { Icon, hue } from './Icons'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

interface Option { action: SenderAction; moves?: 'trash' | 'archive'; icon: string; hue: number; title: string; blurb: (s: SenderSummary) => string; destructive?: boolean }
const OPTIONS: Option[] = [
  { action: 'archive', moves: 'archive', icon: 'archive', hue: 245, title: 'Archive all', blurb: () => 'Out of the inbox, still searchable' },
  { action: 'markRead', icon: 'check', hue: 155, title: 'Mark all read', blurb: () => 'Clears the unread badge' },
  { action: 'trashOlder', moves: 'trash', icon: 'clock', hue: 35, title: 'Trash older mail', blurb: (s) => `Keeps the last ${s.olderThanMonths === 1 ? 'month' : `${s.olderThanMonths} months`}`, destructive: true },
  { action: 'trash', moves: 'trash', icon: 'cleanup', hue: 12, title: 'Trash everything', blurb: () => 'Starred mail is kept', destructive: true },
]

/**
 * What you can do about one sender. Counts come from Gmail searches, so they cover the whole inbox
 * even when only part of it has been scanned. Moving to Trash asks first; everything can be undone.
 */
export function SenderPanel({ email, name, showUnsubscribe, onChanged, onOpenCleanup, onGoToCleanup }: {
  email: string
  name: string
  /** offer unsubscribe here (the Subscriptions page already has its own buttons) */
  showUnsubscribe?: boolean
  onChanged: () => void
  onOpenCleanup: (email: string, name: string) => void
  onGoToCleanup: () => void
}) {
  const [summary, setSummary] = useState<SenderSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<SenderAction | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<{ text: string; entry?: ActivityEntry; undone?: boolean; rules?: boolean } | null>(null)
  const [sub, setSub] = useState<Subscription | null>(null)
  const [copied, setCopied] = useState(false)

  const load = () => {
    setError(null)
    api.senderSummary(email).then(setSummary, (e) => setError(errorText(e)))
  }
  useEffect(load, [email])
  useEffect(() => {
    if (showUnsubscribe) api.subscriptions().then((all) => setSub(all.find((s) => s.email === email.toLowerCase()) ?? null), () => setSub(null))
  }, [email, showUnsubscribe])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null); setConfirming(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  const act = (o: Option) => run(o.action, async () => {
    const n = summary!.counts[o.action]
    const entry = await api.cleanSender(email, o.action, n)
    setDone({ text: `${o.title}: ${plural(entry.messageCount, 'message')} changed.`, entry })
    onChanged()
    load()
  })

  const undo = () => run('undo', async () => {
    await api.undo(done!.entry!.id)
    setDone({ text: 'Undone. Everything is back as it was.', undone: true })
    onChanged()
    load()
  })

  const unsub = parseListUnsubscribe(sub?.listUnsubscribe ?? '')
  const doUnsubscribe = (method: 'oneClick' | 'openLink' | 'openMail', text: string) => run('unsub', async () => {
    await api.unsubscribe(email, method)
    setDone({ text })
  })

  const total = summary?.counts.archive ?? 0
  const unread = summary?.counts.markRead ?? 0

  return (
    <div className="sender-panel">
      <div className="sp-head">
        <div className="sp-stats">
          {summary
            ? <><b>{plural(total, 'message')}</b> in your inbox<span className="dot" />{unread.toLocaleString()} unread{summary.counts.trashOlder > 0 && <><span className="dot" />{summary.counts.trashOlder.toLocaleString()} older than a month</>}</>
            : error ? null : <span className="muted counting"><span className="spinner" aria-hidden="true" /> Counting {name || email}’s mail…</span>}
        </div>
      </div>

      {error && <div className="notice error" role="alert">{error} <button className="btn" onClick={load}>Try again</button></div>}
      {done && (
        <div className="notice sp-done" role="status">
          <Icon name="check" size={16} /><span>{done.text}</span>
          {done.rules && <button className="btn" onClick={onGoToCleanup}>Go to Cleanup</button>}
          {done.entry && !done.undone && <button className="btn" disabled={!!busy} onClick={undo}><Icon name="undo" size={14} /> Undo</button>}
        </div>
      )}

      <div className="sp-options">
        {OPTIONS.map((o) => {
          const n = summary?.counts[o.action] ?? 0
          const sure = confirming === o.action
          return (
            <div key={o.action} className={`sp-option${o.destructive ? ' risky' : ''}`} style={hue(o.hue)}>
              {sure ? (
                <div className="sp-confirm">
                  <b>Move {plural(n, 'message')} to Trash?</b>
                  <span className="muted">Gmail keeps Trash for 30 days, and you can undo from here or Activity.</span>
                  <div className="actions">
                    <button className="btn danger" disabled={!!busy} onClick={() => act(o)}>Move to Trash</button>
                    <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="sp-button" disabled={!summary || n === 0 || !!busy} onClick={() => (o.destructive ? setConfirming(o.action) : act(o))}>
                  <span className="tile soft"><Icon name={o.icon} size={17} /></span>
                  <span className="sp-text">
                    <b>{o.title}{summary && <span className="count-chip">{busy === o.action ? '…' : n.toLocaleString()}</span>}{o.moves && <MoveChip move={o.moves} />}</b>
                    <span className="muted">{summary ? (n === 0 ? 'Nothing to change' : o.blurb(summary)) : ' '}</span>
                  </span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="sp-more">
        <button className="btn" onClick={() => run('rule', async () => {
          await api.createArchiveRule(email)
          setDone({ text: 'Rule created. Preview and apply it from Cleanup to archive mail from this sender.', rules: true })
        })}><Icon name="rules" size={15} /> Auto-archive future mail</button>
        <button className="btn" onClick={() => onOpenCleanup(email, name)}><Icon name="cleanup" size={15} /> Custom cleanup…</button>
        {showUnsubscribe && sub && unsub.https && sub.oneClick && <button className="btn" disabled={!!busy} onClick={() => doUnsubscribe('oneClick', 'Unsubscribe request sent.')}><Icon name="bell" size={15} /> Unsubscribe</button>}
        {showUnsubscribe && sub && unsub.https && !sub.oneClick && <button className="btn" disabled={!!busy} onClick={() => doUnsubscribe('openLink', 'Opened the sender’s unsubscribe page in your browser.')}><Icon name="bell" size={15} /> Unsubscribe page</button>}
        {showUnsubscribe && sub && !unsub.https && unsub.mailto && <button className="btn" disabled={!!busy} onClick={() => doUnsubscribe('openMail', 'Opened a pre-filled email. Send it to unsubscribe.')}><Icon name="bell" size={15} /> Unsubscribe by email</button>}
        <button className="btn" onClick={() => run('gmail', () => api.openInGmail(email))}><Icon name="external" size={15} /> Open in Gmail</button>
        <button className="btn" onClick={() => { navigator.clipboard.writeText(email).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {}) }}>
          <Icon name={copied ? 'check' : 'copy'} size={15} /> {copied ? 'Copied' : 'Copy address'}
        </button>
      </div>
    </div>
  )
}
