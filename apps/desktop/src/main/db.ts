import Database from 'better-sqlite3'
import type { MailAction, Rule } from '@organizer/core'
import type { ActivityEntry } from '../shared'

export interface UndoStep {
  messageIds: string[]
  actions: MailAction[]
}

export class Store {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
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

  close(): void {
    this.db.close()
  }
}
