import type { StorageQuota } from './types'

/** The signed-in token predates the storage permission; the user must reconnect. */
export class StorageScopeError extends Error {
  constructor() {
    super('Reconnect your Google account to show storage usage.')
    this.name = 'StorageScopeError'
  }
}

/** Drive returns int64 values as strings; `limit` is omitted for unlimited storage. */
export function parseStorageQuota(raw: unknown): StorageQuota {
  const q = (raw as { storageQuota?: Record<string, string | undefined> })?.storageQuota
  if (!q || q.usage === undefined) throw new Error('Google did not return storage information.')
  const n = (v: string | undefined) => (v === undefined ? 0 : Number(v))
  return {
    usedBytes: n(q.usage),
    limitBytes: q.limit === undefined ? undefined : Number(q.limit),
    driveBytes: n(q.usageInDrive),
    driveTrashBytes: n(q.usageInDriveTrash),
  }
}

/** Binary units, matching how Google reports quota (15 GB = 15 * 1024^3 bytes). */
export function formatStorageBytes(bytes: number): string {
  const KB = 1024
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= KB && i < units.length - 1) { v /= KB; i++ }
  if (i === 0) return `${Math.round(v)} bytes`
  return `${v >= 100 || Number.isInteger(Math.round(v * 10) / 10) ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/** Whole-number percent used, or null when the account has no limit. */
export function storagePercent(q: StorageQuota): number | null {
  return q.limitBytes ? Math.min(100, Math.round((q.usedBytes / q.limitBytes) * 100)) : null
}
