import { uuidv7 } from 'uuidv7'
import type { ToolServices } from './tools'

/**
 * THE undo registry for AI mutations (M7 chat turns + M8 auto-organize share
 * it — one token namespace, one ai:undo channel). In-memory by design: undo
 * is a per-session affordance; version history is the durable safety net.
 */
export interface UndoRecord {
  /** ai_edit snapshots taken before update_note writes — undo restores them. */
  snapshots: { noteId: string; versionId: string }[]
  /** Notes created by AI — undo trashes them (never hard-deletes). */
  createdNoteIds: string[]
  /** Memberships ADDED by auto-organize — undo removes exactly these. */
  memberships?: { noteId: string; collectionId: string }[]
  /** Collections CREATED by auto-organize — undo deletes them, but only when
   *  they end up empty after the membership removal (a collection the user
   *  meanwhile filled must survive). */
  createdCollectionIds?: string[]
}

const MAX_UNDO_RECORDS = 20

export function createUndoRegistry(services: ToolServices) {
  const store = new Map<string, UndoRecord>()

  return {
    /** Returns a token, or undefined when the record holds nothing to undo. */
    register(rec: UndoRecord): string | undefined {
      const empty =
        rec.snapshots.length === 0 &&
        rec.createdNoteIds.length === 0 &&
        (rec.memberships?.length ?? 0) === 0 &&
        (rec.createdCollectionIds?.length ?? 0) === 0
      if (empty) return undefined
      const token = uuidv7()
      store.set(token, rec)
      while (store.size > MAX_UNDO_RECORDS) {
        const oldest = store.keys().next().value
        if (oldest === undefined) break
        store.delete(oldest)
      }
      return token
    },

    /**
     * ai:undo — restore ai_edit snapshots in reverse order, trash created notes,
     * remove organize-added memberships and delete created-and-still-empty
     * collections. Tokens are single-use.
     */
    undo(undoToken: string): void {
      const rec = store.get(undoToken)
      if (!rec) throw new Error('Nothing to undo — the undo window has passed.')
      store.delete(undoToken)

      const restored: string[] = []
      for (const { noteId, versionId } of [...rec.snapshots].reverse()) {
        const v = services.versions.get(versionId)
        const note = services.notes.get(noteId)
        if (!v || !note) continue
        if (note.trashedAt !== null) continue // user trashed it since — do not silently untrash
        // Snapshot the CURRENT state before clobbering it (mirror versions:restore's
        // pre_restore): post-turn user edits stay recoverable from version history.
        services.versions.snapshot(note, 'pre_restore')
        services.notes.update(noteId, { title: v.title, contentMd: v.contentMd })
        services.indexer.enqueue(noteId)
        restored.push(noteId)
      }

      const trashed: string[] = []
      for (const id of rec.createdNoteIds) {
        const note = services.notes.get(id)
        if (!note || note.trashedAt !== null) continue
        services.notes.trash(id)
        trashed.push(id)
      }

      const membershipNotes = new Set<string>()
      for (const { noteId, collectionId } of rec.memberships ?? []) {
        services.collections.bulk([noteId], [], [collectionId])
        membershipNotes.add(noteId)
      }
      const deletedCollections: string[] = []
      for (const id of rec.createdCollectionIds ?? []) {
        const col = services.collections.list().find((c) => c.id === id)
        if (!col) continue
        if (col.noteCount > 0) continue // the user filed other notes into it since
        services.collections.delete(id)
        deletedCollections.push(id)
      }

      if (restored.length > 0) services.emitDataChanged({ entity: 'note', ids: restored, op: 'update', origin: 'ai' })
      if (trashed.length > 0) services.emitDataChanged({ entity: 'note', ids: trashed, op: 'trash', origin: 'ai' })
      if (membershipNotes.size > 0) {
        services.emitDataChanged({ entity: 'note', ids: [...membershipNotes], op: 'update', origin: 'ai' })
      }
      if (deletedCollections.length > 0) {
        services.emitDataChanged({ entity: 'collection', ids: deletedCollections, op: 'delete', origin: 'ai' })
      }
    }
  }
}

export type UndoRegistry = ReturnType<typeof createUndoRegistry>
