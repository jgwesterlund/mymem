import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { Collection, CollectionWithCount } from '@shared/types'

type Row = {
  id: string
  name: string
  description: string
  created_at: number
  updated_at: number
}

function toCollection(row: Row): Collection {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function createCollectionsRepo(db: Database.Database) {
  return {
    create(input: { name: string; description?: string }): Collection {
      const id = uuidv7()
      const now = Date.now()
      db.prepare(
        `INSERT INTO collections (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, input.name.trim(), input.description ?? '', now, now)
      return this.get(id)!
    },

    get(id: string): Collection | null {
      const row = db.prepare(`SELECT * FROM collections WHERE id = ?`).get(id) as Row | undefined
      return row ? toCollection(row) : null
    },

    getByName(name: string): Collection | null {
      const row = db.prepare(`SELECT * FROM collections WHERE name = ? COLLATE NOCASE`).get(name.trim()) as
        | Row
        | undefined
      return row ? toCollection(row) : null
    },

    update(id: string, patch: { name?: string; description?: string }): Collection {
      db.prepare(
        `UPDATE collections SET
           name = COALESCE(@name, name),
           description = COALESCE(@description, description),
           updated_at = @now
         WHERE id = @id`
      ).run({ id, name: patch.name?.trim() ?? null, description: patch.description ?? null, now: Date.now() })
      return this.get(id)!
    },

    /** Hard delete (v1 decision): memberships cascade, notes untouched. */
    delete(id: string): void {
      db.prepare(`DELETE FROM pins WHERE item_type = 'collection' AND item_id = ?`).run(id)
      db.prepare(`DELETE FROM collections WHERE id = ?`).run(id)
    },

    list(): CollectionWithCount[] {
      const rows = db
        .prepare(
          `SELECT c.*, (
             SELECT COUNT(*) FROM note_collections nc
             JOIN notes n ON n.id = nc.note_id AND n.trashed_at IS NULL
             WHERE nc.collection_id = c.id
           ) AS note_count
           FROM collections c ORDER BY c.name COLLATE NOCASE`
        )
        .all() as (Row & { note_count: number })[]
      return rows.map((row) => ({ ...toCollection(row), noteCount: row.note_count }))
    },

    setForNote(noteId: string, collectionIds: string[]): void {
      const run = db.transaction(() => {
        db.prepare(`DELETE FROM note_collections WHERE note_id = ?`).run(noteId)
        const ins = db.prepare(
          `INSERT OR IGNORE INTO note_collections (note_id, collection_id, added_at) VALUES (?, ?, ?)`
        )
        const now = Date.now()
        for (const cid of collectionIds) ins.run(noteId, cid, now)
      })
      run()
    },

    bulk(noteIds: string[], add: string[], remove: string[]): void {
      const run = db.transaction(() => {
        const ins = db.prepare(
          `INSERT OR IGNORE INTO note_collections (note_id, collection_id, added_at) VALUES (?, ?, ?)`
        )
        const del = db.prepare(
          `DELETE FROM note_collections WHERE note_id = ? AND collection_id = ?`
        )
        const now = Date.now()
        for (const nid of noteIds) {
          for (const cid of add) ins.run(nid, cid, now)
          for (const cid of remove) del.run(nid, cid)
        }
      })
      run()
    }
  }
}

export type CollectionsRepo = ReturnType<typeof createCollectionsRepo>
