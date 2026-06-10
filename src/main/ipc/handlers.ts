import { writeFileSync } from 'node:fs'
import { app, dialog } from 'electron'
import { getDb } from '../db/connection'
import { createNotesRepo } from '../db/repos/notesRepo'
import { createCollectionsRepo } from '../db/repos/collectionsRepo'
import {
  createPinsRepo,
  createSettingsRepo,
  createTemplatesRepo,
  createVersionsRepo
} from '../db/repos/miscRepos'
import { createIndexer } from '../indexing/indexer'
import { createEmbedderClient } from '../indexing/embedderClient'
import { createEmbedQueue } from '../indexing/embedQueue'
import { createSearchService } from '../search/searchService'
import { createRelatedService } from '../search/relatedService'
import { createVersionsService } from '../services/versionsService'
import { createImportService } from '../services/importService'
import { typedHandle, emitDataChanged, push } from './registry'
import { getMainWindow } from '../windows/mainWindow'
import { hideQuickCapture } from '../windows/quickCapture'

export interface Services {
  notes: ReturnType<typeof createNotesRepo>
  collections: ReturnType<typeof createCollectionsRepo>
  pins: ReturnType<typeof createPinsRepo>
  templates: ReturnType<typeof createTemplatesRepo>
  versions: ReturnType<typeof createVersionsRepo>
  settings: ReturnType<typeof createSettingsRepo>
  indexer: ReturnType<typeof createIndexer>
  embedder: ReturnType<typeof createEmbedderClient>
  embedQueue: ReturnType<typeof createEmbedQueue>
  search: ReturnType<typeof createSearchService>
  related: ReturnType<typeof createRelatedService>
  versionsService: ReturnType<typeof createVersionsService>
  importer: ReturnType<typeof createImportService>
}

let services: Services | null = null

export function getServices(): Services {
  if (services) return services
  const db = getDb()
  const notes = createNotesRepo(db)
  const collections = createCollectionsRepo(db)
  const versions = createVersionsRepo(db)
  const embedder = createEmbedderClient()
  const embedQueue = createEmbedQueue(db, embedder)
  const indexer = createIndexer(db, () => embedQueue.kick())
  services = {
    notes,
    collections,
    pins: createPinsRepo(db),
    templates: createTemplatesRepo(db),
    versions,
    settings: createSettingsRepo(db),
    indexer,
    embedder,
    embedQueue,
    search: createSearchService(db, embedder),
    related: createRelatedService(db, embedder),
    versionsService: createVersionsService(db, { notes, versions }),
    importer: createImportService({
      notes,
      collections,
      versions,
      indexer,
      onProgress: (done, total) => push('import:progress', { done, total })
    })
  }
  return services
}

/** M1 surface: app/notes/collections/pins/templates/versions/settings/capture. M3 adds search/index. */
export function registerIpcHandlers(): void {
  const s = getServices()

  typedHandle('app:ping', () => ({
    ok: true as const,
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }))

  // ── Notes ──
  typedHandle('notes:create', (input) => {
    const note = s.notes.create(input)
    if (input.collectionIds?.length) s.collections.setForNote(note.id, input.collectionIds)
    s.indexer.enqueue(note.id)
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'user' })
    return note
  })
  typedHandle('notes:get', ({ id }) => {
    const note = s.notes.getWithRefs(id)
    if (!note) throw new Error(`note not found: ${id}`)
    return note
  })
  typedHandle('notes:update', ({ id, patch, baseUpdatedAt }) => {
    // This channel is only reachable from the renderer (= the user typing), so a title
    // edit pins title_source to 'user'. AI titling (M8) writes through the repo directly.
    const repoPatch = patch.title !== undefined ? { ...patch, titleSource: 'user' as const } : patch
    // Session-snapshot policy: content edits capture the PRE-edit state (once per
    // session — see versionsService). Title-only patches never snapshot.
    if (patch.contentMd !== undefined) s.versionsService.onContentEdit(id)
    const res = s.notes.update(id, repoPatch, baseUpdatedAt)
    if (!res.conflict) {
      s.indexer.enqueue(id)
      emitDataChanged({ entity: 'note', ids: [id], op: 'update', origin: 'user' })
    }
    return res
  })
  typedHandle('notes:list', (opts) => s.notes.list(opts))
  typedHandle('notes:trash', ({ id }) => {
    s.notes.trash(id)
    emitDataChanged({ entity: 'note', ids: [id], op: 'trash', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('notes:restore', ({ id }) => {
    s.notes.restore(id)
    s.indexer.enqueue(id) // re-chunk: trash dropped this note's chunks
    emitDataChanged({ entity: 'note', ids: [id], op: 'restore', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('notes:deleteForever', ({ id }) => {
    s.notes.deleteForever(id)
    emitDataChanged({ entity: 'note', ids: [id], op: 'delete', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('notes:emptyTrash', () => {
    const deleted = s.notes.emptyTrash()
    emitDataChanged({ entity: 'note', ids: [], op: 'delete', origin: 'user' })
    return { deleted }
  })
  typedHandle('notes:import', async ({ filePaths }) => {
    // Empty filePaths = the import-files menu command: the dialog is main-side
    // (a sandboxed renderer has no fs). Non-empty = drag-and-drop paths.
    let paths = filePaths
    if (paths.length === 0) {
      const win = getMainWindow()
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [{ name: 'Markdown / text', extensions: ['md', 'markdown', 'txt'] }]
      }
      const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      if (res.canceled || res.filePaths.length === 0) return { createdIds: [] }
      paths = res.filePaths
    }
    const { createdIds } = await s.importer.importPaths(paths)
    // ONE event for the whole batch — per-file emits would refetch lists N times.
    if (createdIds.length > 0) {
      emitDataChanged({ entity: 'note', ids: createdIds, op: 'create', origin: 'import' })
    }
    return { createdIds }
  })
  typedHandle('notes:export', async ({ id }) => {
    const note = s.notes.get(id)
    if (!note) throw new Error(`note not found: ${id}`)
    const win = getMainWindow()
    const options: Electron.SaveDialogOptions = {
      defaultPath: `${(note.title || 'Untitled').replace(/[/\\:]/g, '-')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (res.canceled || !res.filePath) return { ok: true as const }
    // content_md verbatim — the title lives in the filename, no synthesized H1.
    writeFileSync(res.filePath, note.contentMd, 'utf8')
    return { ok: true as const, path: res.filePath }
  })

  // ── Collections ──
  typedHandle('collections:create', (input) => {
    const c = s.collections.create(input)
    emitDataChanged({ entity: 'collection', ids: [c.id], op: 'create', origin: 'user' })
    return c
  })
  typedHandle('collections:update', ({ id, patch }) => {
    const c = s.collections.update(id, patch)
    emitDataChanged({ entity: 'collection', ids: [id], op: 'update', origin: 'user' })
    return c
  })
  typedHandle('collections:delete', ({ id }) => {
    s.collections.delete(id)
    emitDataChanged({ entity: 'collection', ids: [id], op: 'delete', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('collections:list', () => s.collections.list())
  typedHandle('collections:setForNote', ({ noteId, collectionIds }) => {
    s.collections.setForNote(noteId, collectionIds)
    emitDataChanged({ entity: 'note', ids: [noteId], op: 'update', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('collections:bulk', ({ noteIds, add, remove }) => {
    s.collections.bulk(noteIds, add, remove)
    emitDataChanged({ entity: 'note', ids: noteIds, op: 'update', origin: 'user' })
    return { ok: true as const }
  })

  // ── Pins / Templates / Versions / Settings ──
  typedHandle('pins:list', () => s.pins.list())
  typedHandle('pins:set', ({ itemType, itemId, pinned }) => {
    const pins = s.pins.set(itemType, itemId, pinned)
    emitDataChanged({ entity: 'pin', ids: [itemId], op: 'update', origin: 'user' })
    return pins
  })
  typedHandle('pins:reorder', ({ orderedKeys }) => {
    const pins = s.pins.reorder(orderedKeys)
    emitDataChanged({ entity: 'pin', ids: [], op: 'update', origin: 'user' })
    return pins
  })
  typedHandle('templates:list', () => s.templates.list())
  typedHandle('templates:create', ({ name, contentMd }) => {
    const t = s.templates.create(name, contentMd)
    emitDataChanged({ entity: 'template', ids: [t.id], op: 'create', origin: 'user' })
    return t
  })
  typedHandle('templates:update', ({ id, patch }) => {
    const t = s.templates.update(id, patch)
    emitDataChanged({ entity: 'template', ids: [id], op: 'update', origin: 'user' })
    return t
  })
  typedHandle('templates:delete', ({ id }) => {
    s.templates.delete(id)
    emitDataChanged({ entity: 'template', ids: [id], op: 'delete', origin: 'user' })
    return { ok: true as const }
  })
  typedHandle('versions:list', ({ noteId }) => s.versions.list(noteId))
  typedHandle('versions:get', ({ versionId }) => {
    const v = s.versions.get(versionId)
    if (!v) throw new Error(`version not found: ${versionId}`)
    return v
  })
  typedHandle('versions:restore', ({ versionId }) => {
    const v = s.versions.get(versionId)
    const noteId = s.versions.getNoteId(versionId)
    if (!v || !noteId) throw new Error(`version not found: ${versionId}`)
    const current = s.notes.get(noteId)
    if (!current) throw new Error(`note not found: ${noteId}`)
    // Guard BEFORE the snapshot — notes.update throws on trashed notes and an
    // already-committed pre_restore row would be orphaned (review M-1).
    if (current.trashedAt !== null) throw new Error('note is trashed')
    s.versions.snapshot(current, 'pre_restore') // non-destructive restore
    s.notes.update(noteId, { title: v.title, contentMd: v.contentMd })
    s.indexer.enqueue(noteId)
    // op 'restore' (not 'update'): an open NoteView filters its own origin-'user'
    // updates but must reload after a version restore — same path as untrash.
    emitDataChanged({ entity: 'note', ids: [noteId], op: 'restore', origin: 'user' })
    return s.notes.get(noteId)!
  })
  typedHandle('settings:get', ({ key }) => s.settings.get(key))
  typedHandle('settings:set', ({ key, value }) => {
    s.settings.set(key, value)
    push('settings:changed', { key, value })
    // Consent flips the embeddings worker on (also the renderer's retry path).
    if (key === 'embeddings.consent') {
      if (value === true) s.embedder.start()
      else s.embedder.disable() // consent off takes effect immediately, stays restartable
    }
    return { ok: true as const }
  })

  // ── Search / related / index (M3 keyword, M5 deep + Heads Up) ──
  typedHandle('search:typeahead', ({ q }) => s.search.typeahead(q))
  typedHandle('search:query', ({ q, mode, collectionId, limit }) =>
    mode === 'deep'
      ? s.search.deep(q, collectionId, limit)
      : { results: s.search.keyword(q, collectionId, limit), usedMode: 'keyword' as const }
  )
  typedHandle('related:forNote', ({ noteId, broaden }) => s.related.forNote(noteId, broaden ?? false))
  typedHandle('index:rebuild', () => s.indexer.rebuildAll())
  typedHandle('embeddings:status', () => s.embedder.status())

  // ── Quick capture ──
  typedHandle('capture:save', ({ text }) => {
    const firstLine = text.split('\n', 1)[0]!.replace(/^#+\s*/, '').trim()
    const note = s.notes.create({
      title: firstLine.length <= 80 ? firstLine : '',
      contentMd: text
    })
    s.indexer.enqueue(note.id)
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'capture' })
    return { noteId: note.id }
  })
  typedHandle('capture:hide', () => {
    hideQuickCapture()
  })

  // Boot pass: index live notes whose chunks are missing (created while the app
  // was down, or whose 2 s debounce died with it). Full rebuild stays manual.
  s.indexer.enqueueMissing()

  // ── Embeddings lifecycle ──
  s.embedder.onStatusChange((status) => {
    push('embeddings:status-changed', status)
    if (status.state === 'ready') s.embedQueue.kick() // drain backlog on (re)start
  })
  // Worker only spawns with consent — a fresh offline install stays a keyword app.
  if (s.settings.get('embeddings.consent') === true) s.embedder.start()
}
