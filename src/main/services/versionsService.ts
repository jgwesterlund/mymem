import type Database from 'better-sqlite3'
import type { NotesRepo } from '../db/repos/notesRepo'
import type { VersionsRepo } from '../db/repos/miscRepos'

/**
 * Session-snapshot policy (mem-style; NO 5-min checkpoints — deliberate cut):
 * the renderer autosaves every keystroke-pause (~800 ms), so notes:update fires
 * many times per editing session. A 'session' version captures the PRE-edit
 * state exactly once per session: on the first content edit since app launch,
 * or after ≥15 min of idle for that note. Title-only updates never snapshot.
 *
 * The clock is injectable so the smoke test can advance time deterministically.
 */
const SESSION_GAP_MS = 15 * 60 * 1000

export function createVersionsService(
  db: Database.Database,
  repos: { notes: NotesRepo; versions: VersionsRepo },
  now: () => number = Date.now
) {
  // In-memory by design: an app relaunch starts a fresh session for every note.
  const lastEditAt = new Map<string, number>()

  const latestStmt = db.prepare(
    `SELECT content_md FROM note_versions WHERE note_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`
  )

  return {
    /**
     * Call BEFORE the write, for every notes:update whose patch carries contentMd.
     * (On a CAS conflict nothing is written and this snapshot captured unchanged
     * content — the dedup below keeps a retry from piling up duplicates.)
     */
    onContentEdit(noteId: string): void {
      const t = now()
      const prev = lastEditAt.get(noteId)
      lastEditAt.set(noteId, t)
      if (prev !== undefined && t - prev < SESSION_GAP_MS) return // same session
      const note = repos.notes.get(noteId)
      if (!note || note.trashedAt !== null) return // the write will be rejected anyway

      // Dedup: an unchanged note (e.g. the user hand-reverted to the snapshotted
      // text) must not produce an identical version row.
      const latest = latestStmt.get(noteId) as { content_md: string } | undefined
      if (latest && latest.content_md === note.contentMd) return
      // A brand-new empty note's first autosave would snapshot '' — pure noise.
      if (!latest && note.contentMd === '') return
      repos.versions.snapshot(note, 'session')
    }
  }
}

export type VersionsService = ReturnType<typeof createVersionsService>
