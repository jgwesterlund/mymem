import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { loadSqliteVec } from './sqliteVec'
import { runMigrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const dbPath = process.env.MYMEM_DB_PATH ?? join(app.getPath('userData'), 'mymem.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  loadSqliteVec(db)
  runMigrations(db)
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
