import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { Note, Pin, Template, VersionKind, VersionMeta } from '@shared/types'

// ── Pins ──────────────────────────────────────────────────────────────────────
export function createPinsRepo(db: Database.Database) {
  const listStmt = () =>
    db.prepare(`SELECT * FROM pins ORDER BY sort_order`).all() as {
      item_type: 'note' | 'collection'
      item_id: string
      sort_order: number
      pinned_at: number
    }[]
  const toPins = (): Pin[] =>
    listStmt().map((r) => ({
      itemType: r.item_type,
      itemId: r.item_id,
      sortOrder: r.sort_order,
      pinnedAt: r.pinned_at
    }))

  return {
    list: toPins,
    set(itemType: 'note' | 'collection', itemId: string, pinned: boolean): Pin[] {
      if (pinned) {
        const max = (db.prepare(`SELECT MAX(sort_order) AS m FROM pins`).get() as { m: number | null }).m ?? 0
        db.prepare(
          `INSERT OR REPLACE INTO pins (item_type, item_id, sort_order, pinned_at) VALUES (?, ?, ?, ?)`
        ).run(itemType, itemId, max + 1, Date.now())
      } else {
        db.prepare(`DELETE FROM pins WHERE item_type = ? AND item_id = ?`).run(itemType, itemId)
      }
      return toPins()
    },
    reorder(orderedKeys: { itemType: 'note' | 'collection'; itemId: string }[]): Pin[] {
      const upd = db.prepare(`UPDATE pins SET sort_order = ? WHERE item_type = ? AND item_id = ?`)
      const run = db.transaction(() => {
        orderedKeys.forEach((k, i) => upd.run(i + 1, k.itemType, k.itemId))
      })
      run()
      return toPins()
    }
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────
export function createTemplatesRepo(db: Database.Database) {
  type Row = { id: string; name: string; content_md: string; created_at: number; updated_at: number }
  const toTemplate = (r: Row): Template => ({
    id: r.id,
    name: r.name,
    contentMd: r.content_md,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })
  return {
    list(): Template[] {
      return (db.prepare(`SELECT * FROM templates ORDER BY name COLLATE NOCASE`).all() as Row[]).map(toTemplate)
    },
    create(name: string, contentMd: string): Template {
      const id = uuidv7()
      const now = Date.now()
      db.prepare(
        `INSERT INTO templates (id, name, content_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, name, contentMd, now, now)
      return toTemplate(db.prepare(`SELECT * FROM templates WHERE id = ?`).get(id) as Row)
    },
    update(id: string, patch: { name?: string; contentMd?: string }): Template {
      db.prepare(
        `UPDATE templates SET name = COALESCE(?, name), content_md = COALESCE(?, content_md), updated_at = ? WHERE id = ?`
      ).run(patch.name ?? null, patch.contentMd ?? null, Date.now(), id)
      return toTemplate(db.prepare(`SELECT * FROM templates WHERE id = ?`).get(id) as Row)
    },
    delete(id: string): void {
      db.prepare(`DELETE FROM templates WHERE id = ?`).run(id)
    }
  }
}

// ── Versions ──────────────────────────────────────────────────────────────────
export function createVersionsRepo(db: Database.Database) {
  return {
    list(noteId: string): VersionMeta[] {
      // id DESC tiebreak: uuidv7 is monotonic, so same-millisecond snapshots
      // (autosave bursts) still come back in insert order.
      const rows = db
        .prepare(
          `SELECT id, note_id, kind, created_at, LENGTH(content_md) AS size_chars
           FROM note_versions WHERE note_id = ? ORDER BY created_at DESC, id DESC`
        )
        .all(noteId) as { id: string; note_id: string; kind: VersionKind; created_at: number; size_chars: number }[]
      return rows.map((r) => ({
        id: r.id,
        noteId: r.note_id,
        kind: r.kind,
        createdAt: r.created_at,
        sizeChars: r.size_chars
      }))
    },
    get(versionId: string): { title: string; contentMd: string; createdAt: number } | null {
      const r = db
        .prepare(`SELECT title, content_md, created_at FROM note_versions WHERE id = ?`)
        .get(versionId) as { title: string; content_md: string; created_at: number } | undefined
      return r ? { title: r.title, contentMd: r.content_md, createdAt: r.created_at } : null
    },
    getNoteId(versionId: string): string | null {
      const r = db.prepare(`SELECT note_id FROM note_versions WHERE id = ?`).get(versionId) as
        | { note_id: string }
        | undefined
      return r?.note_id ?? null
    },
    /** Snapshot the CURRENT state of a note (callers decide when per the session policy). */
    snapshot(note: Note, kind: VersionKind): string {
      const id = uuidv7()
      db.prepare(
        `INSERT INTO note_versions (id, note_id, title, content_md, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, note.id, note.title, note.contentMd, kind, Date.now())
      return id
    }
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
export function createSettingsRepo(db: Database.Database) {
  return {
    get<T = unknown>(key: string): T | null {
      const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
      return r ? (JSON.parse(r.value) as T) : null
    },
    set(key: string, value: unknown): void {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value))
    },
    delete(key: string): void {
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(key)
    }
  }
}

export type PinsRepo = ReturnType<typeof createPinsRepo>
export type TemplatesRepo = ReturnType<typeof createTemplatesRepo>
export type VersionsRepo = ReturnType<typeof createVersionsRepo>
export type SettingsRepo = ReturnType<typeof createSettingsRepo>
