import { useEffect, useRef, useState } from 'react'
import type { AccountStatus, ActivityEntry, OverviewResult, ScanProgress, Suggestion } from '../../shared'
import { Avatar, Icon, hue } from './Icons'
import { CountUp } from './Motion'
import { ScanStatus } from './ScanStatus'

const api = window.organizer
const errorText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
type Where = 'overview' | 'space' | 'cleanup'
const STEPS = ['Connect', 'First look', 'Clean up', 'Done']

/**
 * The first thing a new user sees: connect Gmail, watch the first scan, do one cleanup, and know where to go next.
 * Every step can be skipped, and it never changes mail except in the one cleanup the user chooses.
 */
export function Onboarding({ status, overview, progress, onAccountChanged, onFinish }: {
  status: AccountStatus | null
  overview: OverviewResult | null
  progress: ScanProgress | null
  onAccountChanged: () => void
  onFinish: (go: Where) => void
}) {
  const [step, setStep] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const connected = status?.mode === 'gmail'

  // each step takes focus, so keyboard and screen reader users land at its top
  useEffect(() => { heading.current?.focus() }, [step])

  return (
    <div className="onboarding" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="ob-card" style={hue(245)}>
        <ol className="ob-steps" aria-label="Setup progress">
          {STEPS.map((s, i) => <li key={s} className={i === step ? 'now' : i < step ? 'done' : undefined} aria-current={i === step ? 'step' : undefined}><span>{i < step ? <Icon name="check" size={12} /> : i + 1}</span>{s}</li>)}
        </ol>
        {step === 0 && <Connect status={status} connected={connected} headingRef={heading} onAccountChanged={onAccountChanged} onNext={() => setStep(1)} />}
        {step === 1 && <FirstLook overview={overview} progress={progress} headingRef={heading} onNext={() => setStep(2)} />}
        {step === 2 && <FirstCleanup headingRef={heading} onNext={() => setStep(3)} onExplore={() => onFinish('space')} />}
        {step === 3 && <Finished headingRef={heading} onFinish={onFinish} />}
        {step < 3 && <button className="link-btn ob-skip" onClick={() => onFinish('overview')}>Skip setup</button>}
      </div>
    </div>
  )
}

type HeadingRef = React.RefObject<HTMLHeadingElement | null>
const Title = ({ headingRef, children }: { headingRef: HeadingRef; children: React.ReactNode }) => <h1 id="ob-title" ref={headingRef} tabIndex={-1}>{children}</h1>

function Connect({ status, connected, headingRef, onAccountChanged, onNext }: { status: AccountStatus | null; connected: boolean; headingRef: HeadingRef; onAccountChanged: () => void; onNext: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!status?.hasCredentials

  const connect = async () => {
    setBusy(true); setError(null)
    try { await api.connectGmail(); onAccountChanged(); onNext() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <Title headingRef={headingRef}>{connected ? 'You’re connected' : 'Welcome to Email Organizer'}</Title>
      <p className="ob-lead">See what’s filling your inbox, unsubscribe from what you never read, and keep it tidy automatically.</p>
      <ul className="ob-promises">
        <li><Icon name="check" size={16} /><span><b>Your mail stays on this computer.</b> There is no Email Organizer server.</span></li>
        <li><Icon name="check" size={16} /><span><b>It reads who sent each email and its subject,</b> never the message itself.</span></li>
        <li><Icon name="check" size={16} /><span><b>Nothing is deleted for good.</b> Moves go to Trash, and every change can be undone.</span></li>
      </ul>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!ready && !connected && <div className="notice">This build isn’t set up with a Google sign-in yet, so you can try the demo mailbox. To connect Gmail, add the sign-in details on the Account page.</div>}
      <div className="actions ob-actions">
        {connected
          ? <button className="btn primary" onClick={onNext}>Continue</button>
          : <>
              <button className="btn primary" disabled={busy || !ready} onClick={connect}>{busy ? 'Waiting for your browser…' : 'Connect Gmail'}</button>
              <button className="btn" disabled={busy} onClick={onNext}>Try the demo mailbox</button>
            </>}
      </div>
    </>
  )
}

function FirstLook({ overview, progress, headingRef, onNext }: { overview: OverviewResult | null; progress: ScanProgress | null; headingRef: HeadingRef; onNext: () => void }) {
  const ready = !!overview && overview.total > 0
  return (
    <>
      <Title headingRef={headingRef}>{ready ? 'Here’s your inbox' : 'Taking a first look…'}</Title>
      <p className="ob-lead">{ready ? 'This is what the app found. It keeps reading in the background, so numbers can grow.' : 'Reading who sent your newest mail. This takes a minute for a large inbox, and you can keep going.'}</p>
      {overview?.scanning && <ScanStatus progress={progress} compact onCancel={() => { api.cancelScan() }} />}
      {ready && (
        <div className="ob-stats" aria-live="polite">
          <div><b><CountUp value={overview.inboxTotal} /></b><span>messages in your inbox</span></div>
          <div><b><CountUp value={overview.unread} /></b><span>unread</span></div>
          <div><b><CountUp value={overview.subscriptionCount} /></b><span>subscriptions so far</span></div>
        </div>
      )}
      <div className="actions ob-actions"><button className="btn primary" disabled={!ready} onClick={onNext}>{ready ? 'Continue' : 'Reading…'}</button></div>
    </>
  )
}

function FirstCleanup({ headingRef, onNext, onExplore }: { headingRef: HeadingRef; onNext: () => void; onExplore: () => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ email: string; name: string; entry: ActivityEntry; undone?: boolean } | null>(null)

  useEffect(() => { api.suggestions().then((r) => setItems(r.items.slice(0, 3)), () => setItems([])) }, [])

  const archive = async (s: Suggestion) => {
    setBusy(s.id); setError(null)
    try {
      const { counts } = await api.senderSummary(s.email)
      const entry = await api.cleanSender(s.email, 'archive', counts.archive)
      setDone({ email: s.email, name: s.name, entry })
    } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  const undo = async () => {
    if (!done) return
    setBusy('undo')
    try { await api.undo(done.entry.id); setDone({ ...done, undone: true }) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <>
      <Title headingRef={headingRef}>Try one cleanup</Title>
      <p className="ob-lead">{items && items.length ? 'These senders fill your inbox and you rarely open them. Archiving takes their mail out of your inbox but keeps it searchable, and you can undo it.' : 'Nothing stands out yet, so there’s nothing to clean right now.'}</p>
      {error && <div className="notice error" role="alert">{error}</div>}
      {items === null && <p className="muted counting"><span className="spinner" aria-hidden="true" /> Looking…</p>}
      {done && (
        <div className="notice sp-done" role="status">
          <Icon name="check" size={16} />
          <span>{done.undone ? `Undone. ${done.name}’s mail is back in your inbox.` : `Archived ${done.entry.messageCount.toLocaleString()} ${done.entry.messageCount === 1 ? 'email' : 'emails'} from ${done.name}.`}</span>
          {!done.undone && <button className="btn" disabled={!!busy} onClick={undo}><Icon name="undo" size={14} /> Undo</button>}
        </div>
      )}
      {items?.filter((s) => s.email !== done?.email || done.undone).map((s) => (
        <div className="ob-sugg" key={s.id}>
          <Avatar name={s.name} />
          <div><b>{s.name}</b><div className="muted">{s.why}</div></div>
          <button className="btn" disabled={!!busy} onClick={() => archive(s)}>{busy === s.id ? 'Archiving…' : `Archive ${s.count.toLocaleString()}`}</button>
        </div>
      ))}
      <div className="actions ob-actions">
        <button className="btn primary" onClick={onNext}>{done && !done.undone ? 'Finish' : 'Continue'}</button>
        {items && items.length === 0 && <button className="btn" onClick={onExplore}>Look at Free up space</button>}
      </div>
    </>
  )
}

function Finished({ headingRef, onFinish }: { headingRef: HeadingRef; onFinish: (go: Where) => void }) {
  return (
    <>
      <Title headingRef={headingRef}>You’re all set</Title>
      <p className="ob-lead">A few places worth knowing:</p>
      <ul className="ob-tips">
        <li><b>Free up space</b> shows what’s taking room in your Gmail and lets you choose exactly what to move.</li>
        <li><b>Cleanup</b> holds your rules. Turn on <b>Auto</b> on any rule and it handles new mail as it arrives. You can pause them all at any time.</li>
        <li><b>Activity</b> lists everything the app has changed, with Undo.</li>
        <li>Press <kbd>⌘K</kbd> (or <kbd>Ctrl K</kbd>) anywhere to jump to a page or find a sender.</li>
      </ul>
      <div className="actions ob-actions">
        <button className="btn primary" onClick={() => onFinish('overview')}>Open my inbox overview</button>
        <button className="btn" onClick={() => onFinish('space')}>Free up space</button>
      </div>
    </>
  )
}
