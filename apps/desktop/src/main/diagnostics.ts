/** Removes what could identify the user or their mail from text that is about to be shown or copied. */
export function scrub(text: string, home?: string): string {
  let out = String(text ?? '')
  if (home) out = out.split(home).join('~')
  return out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(sk-ant-|ya29\.|1\/\/|AIza)[A-Za-z0-9._\-/]{8,}/g, '<token>')
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>')
    .replace(/([?&](?:access_token|refresh_token|code|key|token|client_secret)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/\/Users\/[^/\s]+/g, '/Users/<user>')
    .replace(/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>')
    .slice(0, 600)
}

export interface LoggedError { at: string; source: string; message: string; stack?: string }

/** The last few things that went wrong, in memory only and scrubbed as they come in. Nothing is stored or sent. */
export class Diagnostics {
  private errors: LoggedError[] = []
  private lastKey = ''
  constructor(private home?: string, private limit = 40) {}

  record(source: string, error: unknown): void {
    const message = scrub(error instanceof Error ? error.message : String(error), this.home)
    if (!message) return
    const key = `${source}|${message}`
    if (key === this.lastKey) return // the same failure every minute shouldn't push everything else out
    this.lastKey = key
    const stack = error instanceof Error && error.stack ? scrub(error.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' | '), this.home) : undefined
    this.errors.push({ at: new Date().toISOString(), source, message, ...(stack && { stack }) })
    if (this.errors.length > this.limit) this.errors.shift()
  }

  recent(): LoggedError[] {
    return [...this.errors]
  }
}

export interface ReportInput {
  app: { version: string; electron?: string; chrome?: string; node?: string }
  system: { platform: string; arch: string; release?: string; locale?: string; memoryMB?: number; uptimeMinutes?: number }
  mailbox: { mode: 'gmail' | 'demo'; scanned?: number; inboxTotal?: number; complete?: boolean }
  rules: { cleanup: number; scanned: number; automatic: number }
  automation: { paused: boolean; lastRunAt: string | null; lastCheckedAt: string | null; checkError: string | null; needsReview: number; errorCount: number }
  settings: { theme: string; keepRunning: boolean; openAtLogin: boolean; notify: boolean; aiKeySaved: boolean }
  errors: LoggedError[]
}

/**
 * The text a user can paste into an email when they need help. It holds versions, counts and recent errors, and
 * deliberately nothing else: no email addresses, names, subjects, rule names or tokens.
 */
export function buildReport(r: ReportInput, home?: string): string {
  const line = (k: string, v: unknown) => `${k}: ${v ?? 'n/a'}`
  const out = [
    'Email Organizer diagnostics',
    `Created ${new Date().toISOString()}`,
    '',
    line('Version', r.app.version),
    line('Electron', r.app.electron), line('Chrome', r.app.chrome), line('Node', r.app.node),
    line('System', `${r.system.platform} ${r.system.arch} ${r.system.release ?? ''}`.trim()),
    line('Language', r.system.locale),
    line('Memory in use', r.system.memoryMB === undefined ? undefined : `${r.system.memoryMB} MB`),
    line('Running for', r.system.uptimeMinutes === undefined ? undefined : `${r.system.uptimeMinutes} min`),
    '',
    line('Mailbox', r.mailbox.mode === 'gmail' ? 'Gmail (connected)' : 'demo'),
    line('Messages scanned', r.mailbox.scanned === undefined ? undefined : `${r.mailbox.scanned} of ${r.mailbox.inboxTotal ?? '?'}${r.mailbox.complete ? ' (whole inbox)' : ''}`),
    line('Rules', `${r.rules.cleanup} cleanup, ${r.rules.scanned} scanned-mail, ${r.rules.automatic} automatic`),
    '',
    line('Automatic rules', r.automation.paused ? 'paused' : 'on'),
    line('Last automatic run', r.automation.lastRunAt),
    line('Last look for new mail', r.automation.lastCheckedAt),
    line('Last check error', r.automation.checkError ? scrub(r.automation.checkError, home) : 'none'),
    line('Waiting for review', r.automation.needsReview), line('Rules that could not run', r.automation.errorCount),
    '',
    line('Theme', r.settings.theme), line('Keep running in background', r.settings.keepRunning), line('Open at login', r.settings.openAtLogin),
    line('Notifications', r.settings.notify), line('Plain-English rules key saved', r.settings.aiKeySaved),
    '',
    `Recent errors (${r.errors.length}):`,
    ...(r.errors.length ? r.errors.map((e) => `- ${e.at} [${e.source}] ${scrub(e.message, home)}${e.stack ? `\n    ${scrub(e.stack, home)}` : ''}`) : ['- none']),
  ]
  return out.join('\n')
}
