import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import type { Note, NoteListItem } from '@shared/types'

type NoteRow = {
  id: string
  title: string
  title_source: 'user' | 'ai'
  content_md: string
  created_at: number
  updated_at: number
  trashed_at: number | null
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    contentMd: row.content_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trashedAt: row.trashed_at
  }
}

function excerptOf(contentMd: string): string {
  return contentMd
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

export function createNotesRepo(db: Database.Database) {
  const insert = db.prepare(
    `INSERT INTO notes (id, title, title_source, content_md, created_at, updated_at)
     VALUES (@id, @title, @titleSource, @contentMd, @now, @now)`
  )
  const getById = db.prepare(`SELECT * FROM notes WHERE id = ?`)
  const collectionIdsFor = db.prepare(
    `SELECT collection_id FROM note_collections WHERE note_id = ? ORDER BY added_at`
  )
  const isPinned = db.prepare(`SELECT 1 FROM pins WHERE item_type = 'note' AND item_id = ?`)

  return {
    create(input: { title?: string; contentMd?: string; titleSource?: 'user' | 'ai' }): Note {
      const id = uuidv7()
      const now = Date.now()
      insert.run({
        id,
        title: input.title ?? '',
        titleSource: input.titleSource ?? 'user',
        contentMd: input.contentMd ?? '',
        now
      })
      return this.get(id)!
    },

    get(id: string): Note | null {
      const row = getById.get(id) as NoteRow | undefined
      return row ? toNote(row) : null
    },

    getWithRefs(id: string): (Note & { collectionIds: string[]; pinned: boolean }) | null {
      const note = this.get(id)
      if (!note) return null
      const collectionIds = (collectionIdsFor.all(id) as { collection_id: string }[]).map(
        (r) => r.collection_id
      )
      return { ...note, collectionIds, pinned: isPinned.get(id) !== undefined }
    },

    /** Compare-and-swap update: if baseUpdatedAt is provided and stale, nothing is written. */
    update(
      id: string,
      patch: { title?: string; contentMd?: string; titleSource?: 'user' | 'ai' },
      baseUpdatedAt?: number
    ): { updatedAt: number; conflict?: boolean } {
      const row = getById.get(id) as NoteRow | undefined
      if (!row) throw new Error(`note not found: ${id}`)
      if (baseUpdatedAt !== undefined && row.updated_at !== baseUpdatedAt) {
        return { updatedAt: row.updated_at, conflict: true }
      }
      const now = Date.now()
      db.prepare(
        `UPDATE notes SET
           title = COALESCE(@title, title),
           title_source = COALESCE(@titleSource, title_source),
           content_md = COALESCE(@contentMd, content_md),
           updated_at = @now
         WHERE id = @id`
      ).run({
        id,
        title: patch.title ?? null,
        titleSource: patch.titleSource ?? null,
        contentMd: patch.contentMd ?? null,
        now
      })
      return { updatedAt: now }
    },

    list(opts: {
      scope: 'all' | 'collection' | 'trash'
      collectionId?: string
      limit?: number
      offset?: number
    }): { items: NoteListItem[]; total: number } {
      const limit = Math.min(opts.limit ?? 100, 500)
      const offset = opts.offset ?? 0
      let where = 'n.trashed_at IS NULL'
      const params: Record<string, unknown> = { limit, offset }
      if (opts.scope === 'trash') where = 'n.trashed_at IS NOT NULL'
      let join = ''
      if (opts.scope === 'collection') {
        join = 'JOIN note_collections nc ON nc.note_id = n.id AND nc.collection_id = @collectionId'
        params.collectionId = opts.collectionId
      }
      const order = opts.scope === 'trash' ? 'n.trashed_at DESC' : 'n.updated_at DESC'
      const rows = db
        .prepare(
          `SELECT n.* FROM notes n ${join} WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`
        )
        .all(params) as NoteRow[]
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM notes n ${join} WHERE ${where}`).get(params) as {
          c: number
        }
      ).c
      const items: NoteListItem[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        titleSource: row.title_source,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        trashedAt: row.trashed_at,
        excerpt: excerptOf(row.content_md),
        collectionIds: (collectionIdsFor.all(row.id) as { collection_id: string }[]).map(
          (r) => r.collection_id
        )
      }))
      return { items, total }
    },

    trash(id: string): void {
      db.prepare(`UPDATE notes SET trashed_at = ? WHERE id = ?`).run(Date.now(), id)
      db.prepare(`DELETE FROM pins WHERE item_type = 'note' AND item_id = ?`).run(id)
      // Trashed notes vanish from search immediately: drop their chunks (FTS trigger fires).
      db.prepare(`DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)`).run(id)
      db.prepare(`DELETE FROM chunks WHERE note_id = ?`).run(id)
    },

    restore(id: string): void {
      db.prepare(`UPDATE notes SET trashed_at = NULL WHERE id = ?`).run(id)
      // Re-chunking is the indexer's job (enqueued by the handler from M3 on).
    },

    deleteForever(id: string): void {
      db.prepare(`DELETE FROM chunks_vec WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)`).run(id)
      db.prepare(`DELETE FROM notes WHERE id = ?`).run(id)
    },

    emptyTrash(): number {
      const ids = (db.prepare(`SELECT id FROM notes WHERE trashed_at IS NOT NULL`).all() as { id: string }[]).map((r) => r.id)
      const run = db.transaction(() => {
        for (const id of ids) this.deleteForever(id)
      })
      run()
      return ids.length
    }
  }
}

export type NotesRepo = ReturnType<typeof createNotesRepo>
