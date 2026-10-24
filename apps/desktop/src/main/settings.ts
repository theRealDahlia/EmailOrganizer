import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { THEME_PREFS, type BackgroundPrefs, type ThemePref } from '../shared'

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

  background(): BackgroundPrefs {
    const raw = this.read()['background']
    const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    return { openAtLogin: b['openAtLogin'] === true, keepRunning: b['keepRunning'] === true, notify: b['notify'] === true }
  }

  /** Whether the first-run guide has been finished or skipped. */
  onboarded(): boolean {
    return this.read()['onboarded'] === true
  }

  setOnboarded(done: boolean): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), onboarded: done === true }, null, 2))
  }

  /** A kill switch for everything that runs on its own. Off by default. */
  automationPaused(): boolean {
    return this.read()['automationPaused'] === true
  }

  setAutomationPaused(paused: boolean): void {
    writeFileSync(this.file, JSON.stringify({ ...this.read(), automationPaused: paused === true }, null, 2))
  }

  setBackground(change: Partial<BackgroundPrefs>): BackgroundPrefs {
    const next = { ...this.background() }
    for (const key of ['openAtLogin', 'keepRunning', 'notify'] as const) if (typeof change[key] === 'boolean') next[key] = change[key]!
    writeFileSync(this.file, JSON.stringify({ ...this.read(), background: next }, null, 2))
    return next
  }

  setTheme(theme: ThemePref): void {
    if (!THEME_PREFS.includes(theme)) throw new Error('Unknown theme.')
    writeFileSync(this.file, JSON.stringify({ ...this.read(), theme }, null, 2))
  }
}
