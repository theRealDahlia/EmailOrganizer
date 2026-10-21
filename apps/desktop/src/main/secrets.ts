import { safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'

/**
 * Key/value store for credentials. Values are encrypted with Electron's safeStorage,
 * which keeps the key in the OS keychain (macOS Keychain, Windows DPAPI, libsecret on Linux).
 * Nothing is ever written in plain text; if encryption is unavailable, writes fail.
 */
export class SecretStore {
  constructor(private file: string) {}

  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  get(key: string): string | null {
    const enc = this.read()[key]
    if (!enc || !this.available) return null
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return null
    }
  }

  set(key: string, value: string): void {
    if (!this.available) throw new Error('Secure storage is not available on this system, so credentials cannot be saved safely.')
    const all = this.read()
    all[key] = safeStorage.encryptString(value).toString('base64')
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }

  delete(...keys: string[]): void {
    const all = this.read()
    keys.forEach((k) => delete all[k])
    writeFileSync(this.file, JSON.stringify(all), { mode: 0o600 })
  }
}
