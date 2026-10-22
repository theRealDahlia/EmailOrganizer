import { useEffect, useRef, useState } from 'react'
import type { ScanProgress } from '../../shared'

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function remaining(done: number, total: number, rateSince: { at: number; done: number }): string | null {
  const elapsed = (Date.now() - rateSince.at) / 1000
  const progressed = done - rateSince.done
  if (progressed < 20 || elapsed < 3) return null // too early for a useful estimate
  const seconds = ((total - done) / progressed) * elapsed
  return seconds < 60 ? 'less than a minute left' : `about ${Math.ceil(seconds / 60)} min left`
}

/** Shown while the inbox is being scanned. Always shows something moving, so a slow scan never looks stuck. */
export function ScanProgressPanel({ progress, onCancel }: { progress: ScanProgress | null; onCancel: () => void }) {
  const [stopping, setStopping] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(Date.now())
  const rateSince = useRef<{ at: number; done: number } | null>(null)

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const fetching = progress?.phase === 'fetching' && progress.total > 0
  if (fetching && !rateSince.current) rateSince.current = { at: Date.now(), done: progress.done }
  const pct = fetching ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

  let status: string
  if (fetching) status = `Downloaded ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} new messages`
  else if (progress?.phase === 'done') status = 'Finishing up…'
  else if (progress && progress.done > 0) status = `Counting your inbox… ${progress.done.toLocaleString()} messages found so far`
  else status = 'Connecting to Gmail…'

  return (
    <section className="card" aria-live="polite">
      <div className="scan-head">
        <span className="spinner" aria-hidden="true" />
        <h2 style={{ margin: 0 }}>Scanning your inbox</h2>
        <span className="muted scan-clock" title="Time spent so far">{clock(elapsed)}</span>
      </div>

      <div
        className={`meter scan-meter${fetching ? '' : ' indeterminate'}`}
        role="progressbar"
        aria-label="Scan progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fetching ? pct : undefined}
      >
        <i style={fetching ? { width: `${pct}%` } : undefined} />
      </div>

      <p>
        {status}
        {fetching && <span className="muted"> · {pct}% · {(rateSince.current && remaining(progress.done, progress.total, rateSince.current)) ?? 'estimating time…'}</span>}
      </p>

      {progress?.throttled && (
        <p className="notice" style={{ marginBottom: 12 }}>
          Google asked the app to slow down. It’s waiting a few seconds and will continue automatically. Nothing is wrong.
        </p>
      )}

      <p className="muted">
        {fetching
          ? 'Only message headers are downloaded, at a gentle pace to stay within Google’s limits. Progress is saved, so a stopped scan picks up where it left off, and later scans only fetch new mail.'
          : 'The first scan of a large inbox can take several minutes. You can leave this running.'}
      </p>

      <div className="actions">
        <button
          className={`btn danger${stopping ? ' stopping' : ''}`}
          disabled={stopping}
          onClick={() => { setStopping(true); onCancel() }}
        >
          {stopping ? 'Stopping…' : 'Stop scan'}
        </button>
        {stopping && <span className="muted" style={{ alignSelf: 'center' }}>Finishing the current step, then saving your progress.</span>}
      </div>
    </section>
  )
}
