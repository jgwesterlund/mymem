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
 * chunks_vec lives outside .sql migrations: its shape follows the active embedding
 * model (MiniLM 384 default) and distance metric. We declare distance_metric=cosine
 * (supported by sqlite-vec 0.1.9 — verified against the shipped vec0.dylib), so KNN
 * `distance` is cosine distance and similarity = 1 - distance directly.
 *
 * A dim/metric mismatch (e.g. a pre-M5 DB whose table was created with the L2
 * default) drops + recreates the table and resets embedded=0 — vectors are a
 * rebuildable cache, the embed queue refills them.
 */
const VEC_METRIC = 'cosine'

function bootstrapVecTable(db: Database.Database): void {
  const getSetting = <T>(key: string): T | null => {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }
  const setSetting = (key: string, value: unknown): void => {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value))
  }

  const dim = getSetting<number>('embedding.dim') ?? 384
  let exists =
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'`).get() !==
    undefined

  if (exists && getSetting<string>('embedding.metric') !== VEC_METRIC) {
    db.transaction(() => {
      db.exec(`DROP TABLE chunks_vec`)
      db.prepare(`UPDATE chunks SET embedded = 0`).run()
    })()
    exists = false
  }

  if (!exists) {
    db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${dim}] distance_metric=${VEC_METRIC})`)
    setSetting('embedding.dim', dim)
    setSetting('embedding.metric', VEC_METRIC)
  }
}
