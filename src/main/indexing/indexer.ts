import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import { chunkMarkdown } from './chunker'
import { push } from '../ipc/registry'

/**
 * Hash-diff indexer: per-note trailing debounce (multiple enqueues coalesce),
 * each job re-reads the live note, chunks it and diffs against the existing
 * rows by (idx, text_hash) — identical rows keep their rowid AND embedded
 * flag (the hash includes the title, so a typo edit re-embeds exactly one
 * chunk in M5). Everything else is delete + insert in ONE transaction; FTS
 * follows via triggers, chunks_vec is deleted explicitly (vec0 has no
 * triggers). Embedding the embedded=0 backlog is the embed queue's drain —
 * onIndexed fires after every completed job so it can kick.
 */
const DEBOUNCE_MS = 2000

type NoteRow = { id: string; title: string; content_md: string; trashed_at: number | null }
type ChunkRow = { id: number; idx: number; text_hash: string }

export function createIndexer(db: Database.Database, onIndexed?: () => void) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let rebuild: { jobId: string; queue: string[]; total: number; done: number } | null = null

  const selectNote = db.prepare(`SELECT id, title, content_md, trashed_at FROM notes WHERE id = ?`)
  const selectChunks = db.prepare(`SELECT id, idx, text_hash FROM chunks WHERE note_id = ?`)
  const deleteChunk = db.prepare(`DELETE FROM chunks WHERE id = ?`)
  const deleteVec = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
  const insertChunk = db.prepare(
    `INSERT INTO chunks (note_id, idx, heading_path, title, text, text_hash, embedded)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  )

  const hashOf = (title: string, headingPath: string, text: string): string =>
    createHash('sha1').update(`${title}|${headingPath}|${text}`).digest('hex')

  /** The job: read live note → chunk → hash-diff, all inside one transaction. */
  const indexNote = db.transaction((noteId: string): void => {
    const note = selectNote.get(noteId) as NoteRow | undefined
    const existing = selectChunks.all(noteId) as ChunkRow[]

    const dropRow = (row: ChunkRow): void => {
      // vec rows are not trigger-synced — delete explicitly. BigInt: better-sqlite3
      // binds plain numbers as doubles, and vec0 only accepts INTEGER rowids.
      deleteVec.run(BigInt(row.id))
      deleteChunk.run(row.id) // FTS delete fires via trg_chunks_ad
    }

    if (!note || note.trashed_at !== null) {
      for (const row of existing) dropRow(row)
      return
    }

    const wanted = new Map<string, { idx: number; headingPath: string; text: string; hash: string }>(
      chunkMarkdown(note.content_md).map((c) => {
        const hash = hashOf(note.title, c.headingPath, c.text)
        return [`${c.idx}:${hash}`, { ...c, hash }]
      })
    )
    for (const row of existing) {
      const key = `${row.idx}:${row.text_hash}`
      if (wanted.has(key)) wanted.delete(key) // identical row: keep rowid + embedded flag
      else dropRow(row)
    }
    for (const c of wanted.values()) {
      insertChunk.run(noteId, c.idx, c.headingPath, note.title, c.text, c.hash)
    }
  })

  const runSafely = (noteId: string): void => {
    try {
      indexNote(noteId)
      onIndexed?.()
    } catch (err) {
      console.error(`[indexer] indexing failed for note ${noteId}`, err)
    }
  }

  function enqueue(noteId: string): void {
    const timer = timers.get(noteId)
    if (timer) clearTimeout(timer) // trailing debounce: re-edits coalesce
    timers.set(
      noteId,
      setTimeout(() => {
        timers.delete(noteId)
        runSafely(noteId)
      }, DEBOUNCE_MS)
    )
  }

  function flushNote(noteId: string): void {
    const timer = timers.get(noteId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(noteId)
    }
    indexNote(noteId)
    onIndexed?.()
  }

  const stepRebuild = (): void => {
    const job = rebuild
    if (!job) return
    const noteId = job.queue.shift()
    if (noteId === undefined) {
      rebuild = null
      return
    }
    runSafely(noteId)
    job.done++
    push('index:progress', { jobId: job.jobId, phase: 'chunking', done: job.done, total: job.total })
    setTimeout(stepRebuild, 0)
  }

  return {
    enqueue,
    flushNote,

    /** Drain every pending debounce synchronously — called on will-quit so jobs survive restart. */
    flushAll(): void {
      for (const noteId of [...timers.keys()]) flushNote(noteId)
    },

    /** Wipe + re-chunk every live note. Fresh rows are embedded=0 (M5 re-embeds). */
    rebuildAll(): { jobId: string } {
      const jobId = uuidv7()
      db.transaction(() => {
        db.prepare(`DELETE FROM chunks_vec`).run() // also clears any orphaned vec rows
        db.prepare(`DELETE FROM chunks`).run()
      })()
      const ids = (
        db.prepare(`SELECT id FROM notes WHERE trashed_at IS NULL ORDER BY updated_at DESC`).all() as {
          id: string
        }[]
      ).map((r) => r.id)
      rebuild = { jobId, queue: ids, total: ids.length, done: 0 }
      push('index:progress', { jobId, phase: 'chunking', done: 0, total: ids.length })
      setTimeout(stepRebuild, 0)
      return { jobId }
    },

    pendingCount(): number {
      return timers.size + (rebuild?.queue.length ?? 0)
    },

    /**
     * Boot pass: cheaply enqueue live notes with content but zero chunks
     * (created while the app was down, or whose debounce died with the app).
     * Full staleness recovery stays manual via index:rebuild.
     */
    enqueueMissing(): void {
      const rows = db
        .prepare(
          `SELECT n.id FROM notes n
           WHERE n.trashed_at IS NULL AND n.content_md <> ''
             AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.note_id = n.id)`
        )
        .all() as { id: string }[]
      for (const row of rows) enqueue(row.id)
    }
  }
}

export type Indexer = ReturnType<typeof createIndexer>
