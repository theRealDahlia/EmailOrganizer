import { useRef, useState } from 'react'
import type { ScanProgress } from '../../shared'

function eta(done: number, total: number, startedAt: number): string | null {
  const elapsed = (Date.now() - startedAt) / 1000
  if (done < 20 || elapsed < 3) return null // too early for a useful estimate
  const seconds = ((total - done) / done) * elapsed
  return seconds < 60 ? 'less than a minute left' : `about ${Math.ceil(seconds / 60)} min left`
}

/** Shown while the inbox is being scanned. Large inboxes download at a throttled rate to stay under Gmail's quota. */
export function ScanProgressPanel({ progress, onCancel }: { progress: ScanProgress | null; onCancel: () => void }) {
  const startedAt = useRef(Date.now())
  const [stopping, setStopping] = useState(false)
  const fetching = progress?.phase === 'fetching' && progress.total > 0
  const pct = fetching ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <section className="card" aria-live="polite">
      <h2>Scanning your inbox</h2>
      {!fetching ? (
        <p className="muted">{progress?.phase === 'done' ? 'Finishing up…' : 'Looking at what’s in your inbox…'}</p>
      ) : (
        <>
          <div className="meter" role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i style={{ width: `${pct}%`, background: 'var(--accent)' }} />
          </div>
          <p>
            Downloaded {progress.done.toLocaleString()} of {progress.total.toLocaleString()} new messages
            <span className="muted"> · {eta(progress.done, progress.total, startedAt.current) ?? 'estimating…'}</span>
          </p>
          <p className="muted">
            Only message headers are downloaded, at a gentle pace to stay within Google’s limits. Progress is saved, so a stopped scan picks up where it left off, and later scans only fetch new mail.
          </p>
        </>
      )}
      <div className="actions">
        <button
          className={`btn danger${stopping ? ' stopping' : ''}`}
          disabled={stopping}
          onClick={() => { setStopping(true); onCancel() }}
        >
          {stopping ? 'Stopping…' : 'Stop scan'}
        </button>
        {stopping && <span className="muted" style={{ alignSelf: 'center' }}>Finishing the current batch, then saving your progress.</span>}
      </div>
    </section>
  )
}
