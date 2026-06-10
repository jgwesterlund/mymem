import type Database from 'better-sqlite3'
import migration001 from './migrations/001_init.sql?raw'

/** Forward-only migrations; PRAGMA user_version tracks the applied count. */
const MIGRATIONS: string[] = [migration001]

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema v${current} is newer than this app supports (v${MIGRATIONS.length}). Refusing to open.`
    )
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  bootstrapVecTable(db)
}

/**
 * chunks_vec lives outside .sql migrations: its dimension follows the active embedding
 * model (MiniLM 384 default). Switching models drops/recreates it and re-embeds (M5).
 */
function bootstrapVecTable(db: Database.Database): void {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'embedding.dim'`).get() as
    | { value: string }
    | undefined
  const dim = row ? (JSON.parse(row.value) as number) : 384
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'`)
    .get()
  if (!exists) {
    db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${dim}])`)
    if (!row) {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding.dim', ?)`).run(
        JSON.stringify(dim)
      )
    }
  }
}
