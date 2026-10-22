import { useEffect, useState } from 'react'
import { formatStorageBytes, storagePercent } from '@organizer/core'
import type { StorageResult } from '../../shared'

/** Mirrors the storage line in Gmail's footer: a bar plus "72% of 15 GB used". */
export function StorageMeter({ refreshKey, onReconnect }: { refreshKey: unknown; onReconnect: () => void }) {
  const [result, setResult] = useState<StorageResult | null>(null)

  useEffect(() => {
    let current = true
    window.organizer.storage().then(
      (r) => current && setResult(r),
      (e) => current && setResult({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => { current = false }
  }, [refreshKey])

  if (!result) return null

  if (result.status === 'needsReconnect') {
    return (
      <footer className="storage">
        <span className="muted">Storage usage needs a new permission.</span>{' '}
        <button className="btn" onClick={onReconnect}>Reconnect Google</button>
      </footer>
    )
  }
  if (result.status === 'error') return <footer className="storage muted">Storage usage unavailable: {result.message}</footer>

  const { quota } = result
  const pct = storagePercent(quota)
  return (
    <footer className="storage">
      {pct !== null && (
        <div className="meter" role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i className={pct >= 90 ? 'high' : ''} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div>
        {pct !== null
          ? <>{pct}% of {formatStorageBytes(quota.limitBytes!)} used <span className="muted">({formatStorageBytes(quota.usedBytes)})</span></>
          : <>{formatStorageBytes(quota.usedBytes)} used</>}
      </div>
      <div className="muted">Shared across Gmail, Drive and Photos</div>
    </footer>
  )
}
