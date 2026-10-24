import { describe, expect, it } from 'vitest'
import { Diagnostics, buildReport, scrub, type ReportInput } from './diagnostics'

describe('scrub', () => {
  it('removes email addresses, tokens, secrets in URLs and the user’s folder', () => {
    const text = 'Failed for nico@gmail.com with Bearer ya29.a0AfH6SMBabcdefghij1234 at https://x.test/cb?code=4/0AbCdEf&state=1 in /Users/dahlia/Desktop/app/file.ts key sk-ant-api03-abcdefghijklmnop'
    const out = scrub(text, '/Users/dahlia')
    expect(out).not.toMatch(/nico@gmail\.com|ya29|4\/0AbCdEf|dahlia|sk-ant-api03/)
    expect(out).toContain('<email>')
    expect(out).toContain('code=<redacted>')
    expect(out).toContain('~/Desktop/app/file.ts')
  })

  it('handles Windows paths and oddities', () => {
    expect(scrub('C:\\Users\\Nico\\AppData\\x')).toBe('C:\\Users\\<user>\\AppData\\x')
    expect(scrub(undefined as never)).toBe('')
    expect(scrub('a'.repeat(5000)).length).toBe(600)
  })
})

describe('Diagnostics', () => {
  it('keeps only the latest errors, scrubbed, and ignores a failure repeated back to back', () => {
    const d = new Diagnostics('/Users/me', 3)
    for (let i = 0; i < 5; i++) d.record('screen', new Error(`problem ${i} for a@b.com`))
    expect(d.recent().map((e) => e.message)).toEqual(['problem 2 for <email>', 'problem 3 for <email>', 'problem 4 for <email>'])

    const same = new Diagnostics()
    for (let i = 0; i < 10; i++) same.record('check', new Error('offline'))
    same.record('check', new Error('rate limited'))
    expect(same.recent().map((e) => e.message)).toEqual(['offline', 'rate limited'])
  })

  it('records strings and keeps a trimmed, scrubbed stack', () => {
    const d = new Diagnostics('/Users/me')
    const e = new Error('boom'); e.stack = 'Error: boom\n    at f (/Users/me/app/a.ts:1:1)\n    at g (/Users/me/app/b.ts:2:2)'
    d.record('main', e); d.record('main', 'plain text failure')
    expect(d.recent()[0].stack).toBe('at f (~/app/a.ts:1:1) | at g (~/app/b.ts:2:2)')
    expect(d.recent()[1].message).toBe('plain text failure')
  })
})

describe('buildReport', () => {
  const input: ReportInput = {
    app: { version: '0.1.0', electron: '41.0.0' }, system: { platform: 'darwin', arch: 'arm64', memoryMB: 310 },
    mailbox: { mode: 'gmail', scanned: 2000, inboxTotal: 18482, complete: false }, rules: { cleanup: 3, scanned: 2, automatic: 2 },
    automation: { paused: false, lastRunAt: null, lastCheckedAt: '2026-10-23T10:00:00Z', checkError: 'Gmail API error 401 for nico@gmail.com', needsReview: 1, errorCount: 0 },
    settings: { theme: 'dark', keepRunning: true, openAtLogin: false, notify: true, aiKeySaved: true },
    errors: [{ at: '2026-10-23T10:01:00Z', source: 'screen', message: 'Cannot read x of undefined' }],
  }

  it('gives the facts needed to help, and nothing personal', () => {
    const text = buildReport(input)
    expect(text).toContain('Version: 0.1.0')
    expect(text).toContain('Messages scanned: 2000 of 18482')
    expect(text).toContain('Rules: 3 cleanup, 2 scanned-mail, 2 automatic')
    expect(text).toContain('Plain-English rules key saved: true')
    expect(text).toContain('Cannot read x of undefined')
    expect(text).not.toMatch(/nico@gmail\.com/)
    expect(text).toContain('Last check error: Gmail API error 401 for <email>')
  })

  it('says so plainly when nothing went wrong, and when automation is paused', () => {
    const text = buildReport({ ...input, errors: [], automation: { ...input.automation, paused: true, checkError: null } })
    expect(text).toContain('Recent errors (0):\n- none')
    expect(text).toContain('Automatic rules: paused')
    expect(text).toContain('Last check error: none')
  })
})
