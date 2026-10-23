import { useEffect, useState } from 'react'
import type { OverviewResult, ScanProgress } from '../../shared'

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function duration(seconds: number): string {
  if (seconds < 60) return 'less than a minute'
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `about ${minutes} min`
  const h = Math.floor(minutes / 60)
  return `about ${h} h ${minutes % 60} min`
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/**
 * Live scan status. Holds no state of its own about the scan (the clock, rate and totals all come from
 * the main process), so it can be mounted anywhere and a tab switch never resets it.
 */
export function ScanStatus({ progress, compact, onCancel }: { progress: ScanProgress | null; compact?: boolean; onCancel: () => void }) {
  const now = useNow(1000)
  const [clicked, setClicked] = useState(false)
  const stopping = clicked || !!progress?.stopping

  const elapsed = progress ? Math.max(0, Math.floor((now - progress.startedAt) / 1000)) : 0
  const fetching = progress?.phase === 'fetching' && progress.total > 0
  const pct = fetching ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  const perMinute = progress?.perMinute && progress.perMinute > 0 ? progress.perMinute : null
  const etaSeconds = fetching && perMinute ? ((progress.total - progress.done) / perMinute) * 60 : null

  let status: string
  if (fetching) status = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} messages downloaded`
  else if (progress?.phase === 'done') status = 'Finishing up…'
  else if (progress?.phase === 'listing' && progress.resumed) status = 'Checking for new mail since the last scan…'
  else if (progress && progress.done > 0) status = `Counting your inbox… ${progress.done.toLocaleString()} messages found so far`
  else status = 'Connecting to Gmail…'

  return (
    <section className={`card scan-status${compact ? ' compact' : ''}`} aria-live="polite">
      <div className="scan-head">
        <span className="spinner" aria-hidden="true" />
        <h2 style={{ margin: 0 }}>{progress?.full ? 'Scanning your whole inbox' : 'Reading your newest mail'}</h2>
        <span className="muted scan-clock" title="Time spent on this scan">{clock(elapsed)}</span>
        <button
          className={`btn danger${stopping ? ' stopping' : ''}`}
          disabled={stopping}
          onClick={() => { setClicked(true); onCancel() }}
        >
          {stopping ? 'Stopping…' : 'Stop scan'}
        </button>
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

      <p style={{ margin: '0 0 6px' }}>
        {status}
        {fetching && (
          <span className="muted">
            {' '}· {pct}%{etaSeconds !== null ? ` · ${duration(etaSeconds)} left` : ''}
            {perMinute ? ` · ~${Math.round(perMinute)}/min` : ''}
          </span>
        )}
      </p>

      {fetching && (progress.alreadyHad || progress.arrived) ? (
        <p className="muted" style={{ margin: '0 0 6px' }}>
          {progress.alreadyHad ? `Picked up where it left off: ${progress.alreadyHad.toLocaleString()} were already downloaded. ` : ''}
          {progress.arrived ? `${progress.arrived.toLocaleString()} new since the last scan.` : progress.alreadyHad ? 'No new mail since the last scan.' : ''}
        </p>
      ) : null}

      {stopping && <p className="muted" style={{ margin: 0 }}>Finishing the current step, then saving your progress.</p>}

      {progress?.throttled && !stopping && (
        <p className="notice" style={{ margin: '8px 0 0' }}>
          Google asked the app to slow down. It’s waiting a few seconds and will continue automatically. Nothing is wrong.
        </p>
      )}

      {!stopping && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {etaSeconds !== null && etaSeconds > 20 * 60 && perMinute
            ? `Google lets this app read about ${Math.round(perMinute)} messages a minute, so a large inbox takes a while. You can keep using the app: results below update as mail arrives, and progress is saved if you stop or quit.`
            : fetching
              ? 'Only message headers are downloaded. Progress is saved, so a stopped scan picks up where it left off, and later scans only fetch new mail.'
              : 'The first scan of a large inbox can take a while. You can leave this running.'}
        </p>
      )}
    </section>
  )
}

/** Explains when numbers cover only part of the inbox. */
export function CoverageNote({ scan }: { scan: Pick<OverviewResult, 'total' | 'inboxTotal' | 'complete' | 'scanning'> }) {
  if (scan.complete && !scan.scanning) return null
  return (
    <p className="muted" style={{ margin: '0 0 12px' }}>
      Based on {scan.scanning ? `${scan.total.toLocaleString()} of ${scan.inboxTotal.toLocaleString()} inbox messages scanned so far (newest first)` : `your newest ${scan.total.toLocaleString()} of ${scan.inboxTotal.toLocaleString()} inbox messages. Scan your whole inbox from Overview to include the rest`}.
    </p>
  )
}
