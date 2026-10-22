import { describe, expect, it } from 'vitest'
import { GmailProvider, StorageScopeError, formatStorageBytes, parseStorageQuota, storagePercent } from './index'

const GB = 1024 ** 3
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
const provider = (f: typeof fetch) => new GmailProvider({ accountId: 'a', getAccessToken: async () => 't', fetch: f, sleep: async () => {} })

describe('storage', () => {
  it('parses Drive quota strings, including unlimited accounts', () => {
    expect(parseStorageQuota({ storageQuota: { limit: String(15 * GB), usage: String(10.8 * GB), usageInDrive: '100', usageInDriveTrash: '5' } }))
      .toEqual({ usedBytes: 10.8 * GB, limitBytes: 15 * GB, driveBytes: 100, driveTrashBytes: 5 })
    expect(parseStorageQuota({ storageQuota: { usage: '10' } }).limitBytes).toBeUndefined()
    expect(() => parseStorageQuota({})).toThrow()
  })

  it('formats sizes and percentages like Gmail', () => {
    expect(formatStorageBytes(15 * GB)).toBe('15 GB')
    expect(formatStorageBytes(10.8 * GB)).toBe('10.8 GB')
    expect(formatStorageBytes(340 * 1024 ** 2)).toBe('340 MB')
    expect(storagePercent({ usedBytes: 10.8 * GB, limitBytes: 15 * GB, driveBytes: 0, driveTrashBytes: 0 })).toBe(72)
    expect(storagePercent({ usedBytes: 5, driveBytes: 0, driveTrashBytes: 0 })).toBeNull()
  })

  it('requests only the storageQuota field', async () => {
    let url = ''
    const f = (async (u: string) => { url = u; return json({ storageQuota: { usage: '1', limit: '2' } }) }) as unknown as typeof fetch
    expect((await provider(f).getStorageQuota()).limitBytes).toBe(2)
    expect(url).toBe('https://www.googleapis.com/drive/v3/about?fields=storageQuota')
  })

  it('reports a missing scope as StorageScopeError', async () => {
    const f = (async () => json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403)) as unknown as typeof fetch
    await expect(provider(f).getStorageQuota()).rejects.toBeInstanceOf(StorageScopeError)
  })
})
