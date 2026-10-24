import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Settings } from './settings'

const file = () => join(mkdtempSync(join(tmpdir(), 'settings-')), 'settings.json')

describe('settings', () => {
  it('follows the system until a theme is chosen', () => {
    expect(new Settings(file()).theme()).toBe('system')
  })

  it('remembers the chosen theme across restarts', () => {
    const path = file()
    new Settings(path).setTheme('dark')
    expect(new Settings(path).theme()).toBe('dark')
    new Settings(path).setTheme('light')
    expect(new Settings(path).theme()).toBe('light')
  })

  it('falls back to the system theme when the file is damaged or holds something unexpected', () => {
    const path = file()
    writeFileSync(path, '{not json')
    expect(new Settings(path).theme()).toBe('system')
    writeFileSync(path, JSON.stringify({ theme: 'purple' }))
    expect(new Settings(path).theme()).toBe('system')
    writeFileSync(path, '[]')
    expect(new Settings(path).theme()).toBe('system')
  })

  it('refuses an unknown theme and keeps other settings', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ other: 1, theme: 'dark' }))
    const settings = new Settings(path)
    expect(() => settings.setTheme('purple' as never)).toThrow('Unknown theme')
    expect(settings.theme()).toBe('dark')
    settings.setTheme('light')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 1, theme: 'light' })
  })
})

describe('background settings', () => {
  it('is all off until the user turns something on', () => {
    expect(new Settings(file()).background()).toEqual({ openAtLogin: false, keepRunning: false, notify: false })
  })

  it('changes only what it is told to, and remembers it alongside the theme', () => {
    const path = file()
    const settings = new Settings(path)
    settings.setTheme('dark')
    expect(settings.setBackground({ keepRunning: true })).toEqual({ openAtLogin: false, keepRunning: true, notify: false })
    expect(settings.setBackground({ notify: true })).toEqual({ openAtLogin: false, keepRunning: true, notify: true })
    const reopened = new Settings(path)
    expect(reopened.background()).toEqual({ openAtLogin: false, keepRunning: true, notify: true })
    expect(reopened.theme()).toBe('dark')
  })

  it('ignores values that aren’t true or false, and a damaged section', () => {
    const path = file()
    const settings = new Settings(path)
    expect(settings.setBackground({ openAtLogin: 'yes' as never, keepRunning: 1 as never })).toEqual({ openAtLogin: false, keepRunning: false, notify: false })
    writeFileSync(path, JSON.stringify({ background: 'nope' }))
    expect(new Settings(path).background()).toEqual({ openAtLogin: false, keepRunning: false, notify: false })
    writeFileSync(path, JSON.stringify({ background: { openAtLogin: 'true', keepRunning: true } }))
    expect(new Settings(path).background()).toEqual({ openAtLogin: false, keepRunning: true, notify: false })
  })
})

describe('pausing automation', () => {
  it('is off until the user turns it on, and remembered', () => {
    const path = file()
    const settings = new Settings(path)
    expect(settings.automationPaused()).toBe(false)
    settings.setAutomationPaused(true)
    expect(new Settings(path).automationPaused()).toBe(true)
    new Settings(path).setAutomationPaused(false)
    expect(new Settings(path).automationPaused()).toBe(false)
  })

  it('only a real true pauses it, and other settings survive', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ theme: 'dark', automationPaused: 'yes' }))
    expect(new Settings(path).automationPaused()).toBe(false)
    const settings = new Settings(path)
    settings.setAutomationPaused(true)
    expect(settings.theme()).toBe('dark')
  })
})

describe('first-run guide', () => {
  it('is shown until it is finished or skipped, and remembered', () => {
    const path = file()
    expect(new Settings(path).onboarded()).toBe(false)
    new Settings(path).setOnboarded(true)
    expect(new Settings(path).onboarded()).toBe(true)
    new Settings(path).setOnboarded(false) // "show the guide again"
    expect(new Settings(path).onboarded()).toBe(false)
  })

  it('only a real true counts, and other settings survive', () => {
    const path = file()
    writeFileSync(path, JSON.stringify({ theme: 'dark', onboarded: 'yes' }))
    const settings = new Settings(path)
    expect(settings.onboarded()).toBe(false)
    settings.setOnboarded(true)
    expect(settings.theme()).toBe('dark')
  })
})
