import Database from 'better-sqlite3'
import type { CleanupRule, MailAction, MailMessage, Rule } from '@organizer/core'
import type { ActivityEntry } from '../shared'

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
    `)
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

  addActivity(ruleName: string, messageCount: number, undo: UndoStep[]): ActivityEntry {
    const at = new Date().toISOString()
    const info = this.db.prepare('INSERT INTO activity (at, rule_name, message_count, undo_json) VALUES (?, ?, ?, ?)')
      .run(at, ruleName, messageCount, JSON.stringify(undo))
    return { id: Number(info.lastInsertRowid), at, ruleName, messageCount, undone: false }
  }

  listActivity(): ActivityEntry[] {
    return this.db.prepare('SELECT id, at, rule_name, message_count, undone FROM activity ORDER BY id DESC LIMIT 100').all()
      .map((r) => {
        const row = r as { id: number; at: string; rule_name: string; message_count: number; undone: number }
        return { id: row.id, at: row.at, ruleName: row.rule_name, messageCount: row.message_count, undone: !!row.undone }
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
