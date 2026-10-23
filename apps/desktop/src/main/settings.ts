import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { THEME_PREFS, type ThemePref } from '../shared'

/** App preferences kept in a small JSON file next to the database. Nothing sensitive goes here. */
export class Settings {
  constructor(private file: string) {}

  private read(): Record<string, unknown> {
    if (!existsSync(this.file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {} // a damaged file just means default settings
    }
  }

  /** Light, dark, or follow the operating system (the default, and what an unreadable value falls back to). */
  theme(): ThemePref {
    const value = this.read()['theme']
    return THEME_PREFS.includes(value as ThemePref) ? (value as ThemePref) : 'system'
  }

  setTheme(theme: ThemePref): void {
    if (!THEME_PREFS.includes(theme)) throw new Error('Unknown theme.')
    writeFileSync(this.file, JSON.stringify({ ...this.read(), theme }, null, 2))
  }
}
