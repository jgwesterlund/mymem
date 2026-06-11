import { Type } from '@earendil-works/pi-ai'
import type { Tool, ToolCall } from '@earendil-works/pi-ai'
import type { DataChangedEvent } from '@shared/ipc'
import type { NotesRepo } from '../db/repos/notesRepo'
import type { CollectionsRepo } from '../db/repos/collectionsRepo'
import type { VersionsRepo } from '../db/repos/miscRepos'
import type { Indexer } from '../indexing/indexer'
import type { SearchService } from '../search/searchService'
import type { UndoRecord } from './undoRegistry'

/**
 * The 7 chat-agent tools. Execution goes through the SAME repos/services as the
 * UI and the local API — indexing, versions and data:changed behave identically.
 * Every MUTATING tool snapshots (kind 'ai_edit') BEFORE writing (update only —
 * create has no pre-state) and reports into the per-turn undo record.
 * Results are compact JSON that ALWAYS carries ids + titles so the model can
 * cite [Title](mymem://note/<id>).
 */
export const AGENT_TOOLS: Tool[] = [
  {
    name: 'search_notes',
    description:
      "Search the user's notes. mode 'keyword' is exact-term full-text search; 'deep' adds semantic matching. Returns [{id, title, snippet}].",
    parameters: Type.Object({
      query: Type.String({ description: 'What to search for' }),
      mode: Type.Optional(Type.Union([Type.Literal('keyword'), Type.Literal('deep')], { description: "Default 'deep'" }))
    })
  },
  {
    name: 'read_note',
    description: 'Read one note in full by id. Returns {id, title, contentMd, updatedAt}.',
    parameters: Type.Object({ id: Type.String({ description: 'Note id from a previous tool result' }) })
  },
  {
    name: 'create_note',
    description: 'Create a new note. Returns {id, title}.',
    parameters: Type.Object({
      title: Type.String(),
      contentMd: Type.String({ description: 'Markdown body' })
    })
  },
  {
    name: 'update_note',
    description:
      "Edit an existing note. mode 'append' adds contentMd at the end (preferred); 'replace' overwrites the whole body.",
    parameters: Type.Object({
      id: Type.String(),
      mode: Type.Union([Type.Literal('replace'), Type.Literal('append')]),
      contentMd: Type.String()
    })
  },
  {
    name: 'list_collections',
    description: "List the user's collections. Returns [{id, name, noteCount}].",
    parameters: Type.Object({})
  },
  {
    name: 'add_to_collection',
    description: 'Add a note to a collection by collection name (or id). Set createIfMissing to create the collection.',
    parameters: Type.Object({
      noteId: Type.String(),
      collection: Type.String({ description: 'Collection name (preferred) or id' }),
      createIfMissing: Type.Optional(Type.Boolean())
    })
  },
  {
    name: 'get_recent_notes',
    description: 'Recently edited notes. Returns [{id, title, updatedAt}].',
    parameters: Type.Object({
      sinceDays: Type.Optional(Type.Number({ description: 'Look-back window in days (default 7)' }))
    })
  }
]

export interface ToolServices {
  notes: NotesRepo
  collections: CollectionsRepo
  versions: VersionsRepo
  indexer: Indexer
  search: SearchService
  emitDataChanged: (ev: DataChangedEvent) => void
}

// Per-turn undo bookkeeping now lives with the shared registry (M8: organize
// records share the same token namespace). Re-exported for existing importers.
export type { UndoRecord } from './undoRegistry'

export interface ToolOutcome {
  /** Serialized into the toolResult text content. */
  json: unknown
  isError: boolean
  /** One-liner for the tool_end event / renderer tool card. */
  summary: string
}

const ok = (json: unknown, summary: string): ToolOutcome => ({ json, isError: false, summary })
const err = (message: string): ToolOutcome => ({ json: { error: message }, isError: true, summary: message })

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '')

/** Human label for the tool_start event ("Searching notes for …"). */
export function toolLabel(call: ToolCall): string {
  const a = call.arguments as Record<string, unknown>
  switch (call.name) {
    case 'search_notes':
      return `Searching notes for “${String(a.query ?? '')}”`
    case 'read_note':
      return 'Reading note'
    case 'create_note':
      return `Creating note “${String(a.title ?? '')}”`
    case 'update_note':
      return a.mode === 'replace' ? 'Rewriting note' : 'Updating note'
    case 'list_collections':
      return 'Listing collections'
    case 'add_to_collection':
      return `Adding to “${String(a.collection ?? '')}”`
    case 'get_recent_notes':
      return 'Fetching recent notes'
    default:
      return call.name
  }
}

export async function executeTool(call: ToolCall, s: ToolServices, undo: UndoRecord): Promise<ToolOutcome> {
  try {
    const a = call.arguments as Record<string, unknown>
    switch (call.name) {
      case 'search_notes': {
        const query = String(a.query ?? '').trim()
        if (!query) return err('search_notes: query is required')
        const res =
          a.mode === 'keyword'
            ? { results: s.search.keyword(query, undefined, 10) }
            : await s.search.deep(query, undefined, 10) // degrades to keyword without the embedder
        const hits = res.results.slice(0, 10).map((r) => ({
          id: r.noteId,
          title: r.title || 'Untitled',
          snippet: stripTags(r.snippetHtml).slice(0, 240)
        }))
        return ok(hits, `${hits.length} result${hits.length === 1 ? '' : 's'} for “${query}”`)
      }

      case 'read_note': {
        const note = s.notes.get(String(a.id ?? ''))
        if (!note) return err(`read_note: no note with id ${String(a.id)}`)
        if (note.trashedAt !== null) return err('read_note: that note is in the trash')
        return ok(
          { id: note.id, title: note.title || 'Untitled', contentMd: note.contentMd, updatedAt: note.updatedAt },
          `Read “${note.title || 'Untitled'}”`
        )
      }

      case 'create_note': {
        const title = String(a.title ?? '').trim()
        const contentMd = String(a.contentMd ?? '')
        // titleSource 'ai': a later manual rename flips it to 'user' and wins permanently.
        const note = s.notes.create({ title, contentMd, titleSource: 'ai' })
        undo.createdNoteIds.push(note.id)
        s.indexer.enqueue(note.id)
        s.emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'ai' })
        return ok({ id: note.id, title: note.title || 'Untitled' }, `Created “${note.title || 'Untitled'}”`)
      }

      case 'update_note': {
        const id = String(a.id ?? '')
        const note = s.notes.get(id)
        if (!note) return err(`update_note: no note with id ${id}`)
        // Trashed guard: an isError toolResult the model can react to — never a throw.
        if (note.trashedAt !== null) return err('update_note: that note is in the trash — it must be restored first')
        // Snapshot the PRE-edit state BEFORE the write (kind ai_edit) → per-turn undo + version history.
        const versionId = s.versions.snapshot(note, 'ai_edit')
        undo.snapshots.push({ noteId: id, versionId })
        const incoming = String(a.contentMd ?? '')
        const contentMd =
          a.mode === 'append' ? (note.contentMd ? `${note.contentMd}\n\n${incoming}` : incoming) : incoming
        // CAS on the just-read updatedAt: nothing awaited since the read, but it
        // documents the dirty-editor contract and catches future refactors.
        const res = s.notes.update(id, { contentMd }, note.updatedAt)
        if (res.conflict) return err('update_note: the note changed while editing — read it again')
        s.indexer.enqueue(id)
        s.emitDataChanged({ entity: 'note', ids: [id], op: 'update', origin: 'ai' })
        return ok(
          { id, title: note.title || 'Untitled', updatedAt: res.updatedAt },
          `Updated “${note.title || 'Untitled'}”`
        )
      }

      case 'list_collections': {
        const cols = s.collections.list().map((c) => ({ id: c.id, name: c.name, noteCount: c.noteCount }))
        return ok(cols, `${cols.length} collection${cols.length === 1 ? '' : 's'}`)
      }

      case 'add_to_collection': {
        const noteId = String(a.noteId ?? '')
        const ref = String(a.collection ?? '').trim()
        const note = s.notes.get(noteId)
        if (!note) return err(`add_to_collection: no note with id ${noteId}`)
        if (note.trashedAt !== null) return err('add_to_collection: that note is in the trash')
        let col = s.collections.getByName(ref) ?? s.collections.get(ref)
        if (!col) {
          if (a.createIfMissing !== true) return err(`add_to_collection: no collection named “${ref}” (set createIfMissing to create it)`)
          col = s.collections.create({ name: ref })
          s.emitDataChanged({ entity: 'collection', ids: [col.id], op: 'create', origin: 'ai' })
        }
        s.collections.bulk([noteId], [col.id], [])
        s.emitDataChanged({ entity: 'note', ids: [noteId], op: 'update', origin: 'ai' })
        return ok(
          { noteId, noteTitle: note.title || 'Untitled', collectionId: col.id, collection: col.name },
          `Added “${note.title || 'Untitled'}” to “${col.name}”`
        )
      }

      case 'get_recent_notes': {
        const days = typeof a.sinceDays === 'number' && a.sinceDays > 0 ? Math.min(a.sinceDays, 365) : 7
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
        const { items } = s.notes.list({ scope: 'all', limit: 100 })
        const recent = items
          .filter((n) => n.updatedAt >= cutoff)
          .slice(0, 20)
          .map((n) => ({ id: n.id, title: n.title || 'Untitled', updatedAt: n.updatedAt }))
        return ok(recent, `${recent.length} note${recent.length === 1 ? '' : 's'} from the last ${days} days`)
      }

      default:
        return err(`unknown tool: ${call.name}`)
    }
  } catch (e) {
    return err(`${call.name} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
