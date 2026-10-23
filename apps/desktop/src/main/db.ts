import Database from 'better-sqlite3'
import type { CleanupRule, MailAction, MailMessage, Rule } from '@organizer/core'
import type { ActivityEntry, UnsubscribeRecord } from '../shared'

export interface UndoStep {
  messageIds: string[]
  actions: MailAction[]
  /** Metadata of messages that left the inbox, so undoing doesn't need to download them again. */
  restore?: MailMessage[]
}

/** Where a scan got to: the inbox's ids as of `historyId`, so a restart doesn't have to count the mailbox again. */
export interface ScanState {
  historyId: string
  /** epoch ms of the last full listing of the inbox */
  listedAt: number
  ids: string[]
}

/** What an activity entry records beyond its name and count, so totals can be worked out later. */
export interface ActivityMeta {
  ruleId?: string
  bytes?: number
  automatic?: boolean
  move?: 'trash' | 'archive' | null
}

export class Store {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (account_id, id)
      );
      CREATE TABLE IF NOT EXISTS cleanup_rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_state (
        account_id TEXT PRIMARY KEY,
        history_id TEXT NOT NULL,
        listed_at INTEGER NOT NULL,
        ids_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        rule_name TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        undo_json TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dismissed (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS unsubscribes (
        email TEXT PRIMARY KEY, name TEXT NOT NULL, at TEXT NOT NULL, method TEXT NOT NULL,
        status TEXT NOT NULL, checked_at TEXT, rule_id TEXT
      );
    `)
    // Databases made before impact tracking lack these columns.
    const have = new Set((this.db.prepare('PRAGMA table_info(activity)').all() as { name: string }[]).map((c) => c.name))
    const add = (name: string, type: string) => { if (!have.has(name)) this.db.exec(`ALTER TABLE activity ADD COLUMN ${name} ${type}`) }
    add('rule_id', 'TEXT')
    add('bytes', 'INTEGER NOT NULL DEFAULT 0')
    add('automatic', 'INTEGER NOT NULL DEFAULT 0')
    add('move', 'TEXT')
  }

  listRules(): Rule[] {
    return this.db.prepare('SELECT json FROM rules ORDER BY position').all()
      .map((r) => JSON.parse((r as { json: string }).json) as Rule)
  }

  saveRule(rule: Rule): void {
    const existing = this.db.prepare('SELECT position FROM rules WHERE id = ?').get(rule.id) as { position: number } | undefined
    const position = existing?.position ?? (this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules').get() as { p: number }).p
    this.db.prepare('INSERT OR REPLACE INTO rules (id, position, json) VALUES (?, ?, ?)').run(rule.id, position, JSON.stringify(rule))
  }

  listCleanupRules(): CleanupRule[] {
    return this.db.prepare('SELECT json FROM cleanup_rules ORDER BY position').all()
      .map((r) => JSON.parse((r as { json: string }).json) as CleanupRule)
  }

  saveCleanupRule(rule: CleanupRule): void {
    const existing = this.db.prepare('SELECT position FROM cleanup_rules WHERE id = ?').get(rule.id) as { position: number } | undefined
    const position = existing?.position ?? (this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM cleanup_rules').get() as { p: number }).p
    this.db.prepare('INSERT OR REPLACE INTO cleanup_rules (id, position, json) VALUES (?, ?, ?)').run(rule.id, position, JSON.stringify(rule))
  }

  deleteCleanupRule(id: string): void {
    this.db.prepare('DELETE FROM cleanup_rules WHERE id = ?').run(id)
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id)
  }

  addActivity(ruleName: string, messageCount: number, undo: UndoStep[], meta: ActivityMeta = {}): ActivityEntry {
    const at = new Date().toISOString()
    const info = this.db.prepare('INSERT INTO activity (at, rule_name, message_count, undo_json, rule_id, bytes, automatic, move) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, ruleName, messageCount, JSON.stringify(undo), meta.ruleId ?? null, Math.round(meta.bytes ?? 0), meta.automatic ? 1 : 0, meta.move ?? null)
    return { id: Number(info.lastInsertRowid), at, ruleName, messageCount, undone: false, ...meta }
  }

  private activityRows(sql: string, ...params: string[]): ActivityEntry[] {
    return this.db.prepare(sql).all(...params).map((r) => {
      const row = r as { id: number; at: string; rule_name: string; message_count: number; undone: number; rule_id: string | null; bytes: number; automatic: number; move: string | null }
      return {
        id: row.id, at: row.at, ruleName: row.rule_name, messageCount: row.message_count, undone: !!row.undone,
        ...(row.rule_id && { ruleId: row.rule_id }), bytes: row.bytes, automatic: !!row.automatic, move: (row.move as ActivityEntry['move']) ?? null,
      }
    })
  }

  listActivity(): ActivityEntry[] {
    return this.activityRows('SELECT id, at, rule_name, message_count, undone, rule_id, bytes, automatic, move FROM activity ORDER BY id DESC LIMIT 100')
  }

  /** Every entry from `sinceIso` on (all of them without it), without the undo data. For totals, so no row limit. */
  activitySince(sinceIso?: string): ActivityEntry[] {
    return this.activityRows(
      `SELECT id, at, rule_name, message_count, undone, rule_id, bytes, automatic, move FROM activity ${sinceIso ? 'WHERE at >= ?' : ''} ORDER BY id DESC`,
      ...(sinceIso ? [sinceIso] : []),
    )
  }

  dismiss(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO dismissed (id) VALUES (?)').run(id)
  }

  listDismissed(): string[] {
    return (this.db.prepare('SELECT id FROM dismissed').all() as { id: string }[]).map((r) => r.id)
  }

  recordUnsubscribe(record: UnsubscribeRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO unsubscribes (email, name, at, method, status, checked_at, rule_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.email, record.name, record.at, record.method, record.status, record.checkedAt ?? null, record.ruleId ?? null)
  }

  listUnsubscribes(): UnsubscribeRecord[] {
    return this.db.prepare('SELECT email, name, at, method, status, checked_at, rule_id FROM unsubscribes ORDER BY at DESC').all().map((r) => {
      const row = r as { email: string; name: string; at: string; method: UnsubscribeRecord['method']; status: UnsubscribeRecord['status']; checked_at: string | null; rule_id: string | null }
      return { email: row.email, name: row.name, at: row.at, method: row.method, status: row.status, ...(row.checked_at && { checkedAt: row.checked_at }), ...(row.rule_id && { ruleId: row.rule_id }) }
    })
  }

  takeUndo(id: number): UndoStep[] | null {
    const row = this.db.prepare('SELECT undo_json, undone FROM activity WHERE id = ?').get(id) as { undo_json: string; undone: number } | undefined
    if (!row || row.undone) return null
    this.db.prepare('UPDATE activity SET undone = 1 WHERE id = ?').run(id)
    return JSON.parse(row.undo_json) as UndoStep[]
  }

  /** Cached message metadata for one account (headers only, never message bodies). */
  loadMessages(accountId: string): Map<string, MailMessage> {
    const rows = this.db.prepare('SELECT id, json FROM messages WHERE account_id = ?').all(accountId) as { id: string; json: string }[]
    return new Map(rows.map((r) => [r.id, JSON.parse(r.json) as MailMessage]))
  }

  getMessages(accountId: string, ids: string[]): MailMessage[] {
    const out: MailMessage[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      const rows = this.db
        .prepare(`SELECT json FROM messages WHERE account_id = ? AND id IN (${chunk.map(() => '?').join(',')})`)
        .all(accountId, ...chunk) as { json: string }[]
      out.push(...rows.map((r) => JSON.parse(r.json) as MailMessage))
    }
    return out
  }

  upsertMessages(accountId: string, messages: MailMessage[]): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO messages (account_id, id, json) VALUES (?, ?, ?)')
    this.db.transaction(() => messages.forEach((m) => stmt.run(accountId, m.id, JSON.stringify(m))))()
  }

  deleteMessages(accountId: string, ids: string[]): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE account_id = ? AND id = ?')
    this.db.transaction(() => ids.forEach((id) => stmt.run(accountId, id)))()
  }

  clearMessages(accountId: string): void {
    this.db.prepare('DELETE FROM messages WHERE account_id = ?').run(accountId)
    this.db.prepare('DELETE FROM scan_state WHERE account_id = ?').run(accountId)
  }

  loadScanState(accountId: string): ScanState | null {
    const row = this.db.prepare('SELECT history_id, listed_at, ids_json FROM scan_state WHERE account_id = ?').get(accountId) as
      { history_id: string; listed_at: number; ids_json: string } | undefined
    return row ? { historyId: row.history_id, listedAt: row.listed_at, ids: JSON.parse(row.ids_json) as string[] } : null
  }

  saveScanState(accountId: string, state: ScanState): void {
    this.db.prepare('INSERT OR REPLACE INTO scan_state (account_id, history_id, listed_at, ids_json) VALUES (?, ?, ?, ?)')
      .run(accountId, state.historyId, state.listedAt, JSON.stringify(state.ids))
  }

  close(): void {
    this.db.close()
  }
}
