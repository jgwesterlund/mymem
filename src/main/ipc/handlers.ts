import { writeFileSync } from 'node:fs'
import { app, dialog, nativeTheme } from 'electron'
import { uuidv7 } from 'uuidv7'
import { getDb } from '../db/connection'
import { createNotesRepo } from '../db/repos/notesRepo'
import { createCollectionsRepo } from '../db/repos/collectionsRepo'
import { createChatsRepo } from '../db/repos/chatsRepo'
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
import { createCredentialsStore } from '../ai/credentials'
import { createProviderManager } from '../ai/providers'
import { createRag } from '../ai/rag'
import { createAgent } from '../ai/agent'
import { createUndoRegistry } from '../ai/undoRegistry'
import { createCleanupService } from '../ai/cleanup'
import { createOrganizeService } from '../ai/organize'
import { createTitlesService } from '../ai/titles'
import { typedHandle, emitDataChanged, push } from './registry'
import { getMainWindow } from '../windows/mainWindow'
import { hideQuickCapture } from '../windows/quickCapture'
import { setTrayEnabled } from '../tray'

export interface Services {
  notes: ReturnType<typeof createNotesRepo>
  collections: ReturnType<typeof createCollectionsRepo>
  pins: ReturnType<typeof createPinsRepo>
  templates: ReturnType<typeof createTemplatesRepo>
  versions: ReturnType<typeof createVersionsRepo>
  settings: ReturnType<typeof createSettingsRepo>
  chats: ReturnType<typeof createChatsRepo>
  indexer: ReturnType<typeof createIndexer>
  embedder: ReturnType<typeof createEmbedderClient>
  embedQueue: ReturnType<typeof createEmbedQueue>
  search: ReturnType<typeof createSearchService>
  related: ReturnType<typeof createRelatedService>
  versionsService: ReturnType<typeof createVersionsService>
  importer: ReturnType<typeof createImportService>
  providers: ReturnType<typeof createProviderManager>
  agent: ReturnType<typeof createAgent>
  undoRegistry: ReturnType<typeof createUndoRegistry>
  cleanup: ReturnType<typeof createCleanupService>
  organize: ReturnType<typeof createOrganizeService>
  titles: ReturnType<typeof createTitlesService>
}

let services: Services | null = null

export function getServices(): Services {
  if (services) return services
  const db = getDb()
  const notes = createNotesRepo(db)
  const collections = createCollectionsRepo(db)
  const versions = createVersionsRepo(db)
  const settings = createSettingsRepo(db)
  const chats = createChatsRepo(db)
  const embedder = createEmbedderClient()
  const embedQueue = createEmbedQueue(db, embedder)
  const indexer = createIndexer(db, () => embedQueue.kick())
  const search = createSearchService(db, embedder)
  const credentials = createCredentialsStore(settings)
  const providers = createProviderManager({
    credentials,
    settings,
    onDeviceCode: (info) => push('oauth:prompt', info)
  })
  const toolServices = { notes, collections, versions, indexer, search, emitDataChanged }
  // ONE undo registry: chat turns and auto-organize mint tokens into the same
  // store, so a single ai:undo channel reverts either.
  const undoRegistry = createUndoRegistry(toolServices)
  const agent = createAgent({
    chats,
    settings,
    services: toolServices,
    rag: createRag(db, embedder),
    getApiKey: (providerId) => providers.getApiKeyFor(providerId),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId),
    emit: (chatId, requestId, ev) => push('chat:event', { chatId, requestId, ev }),
    undoRegistry
  })
  const cleanup = createCleanupService({
    notes,
    versions,
    indexer,
    emitDataChanged,
    pushResult: (payload) => push('ai:cleanup:result', payload),
    getApiKey: (providerId) => providers.getApiKeyFor(providerId),
    defaultModel: () => providers.defaultModel(),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId)
  })
  const organize = createOrganizeService({
    notes,
    collections,
    emitDataChanged,
    undoRegistry,
    getApiKey: (providerId) => providers.getApiKeyFor(providerId),
    utilityModel: () => providers.utilityModel(),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId)
  })
  const titles = createTitlesService({
    notes,
    emitDataChanged,
    getApiKey: (providerId) => providers.getApiKeyFor(providerId),
    utilityModel: () => providers.utilityModel(),
    resolveModel: (providerId, modelId) => providers.resolveModel(providerId, modelId),
    isChatStreaming: () => agent.isStreaming()
  })
  services = {
    notes,
    collections,
    pins: createPinsRepo(db),
    templates: createTemplatesRepo(db),
    versions,
    settings,
    chats,
    indexer,
    embedder,
    embedQueue,
    search,
    related: createRelatedService(db, embedder),
    versionsService: createVersionsService(db, { notes, versions }),
    importer: createImportService({
      notes,
      collections,
      versions,
      indexer,
      onProgress: (done, total) => push('import:progress', { done, total })
    }),
    providers,
    agent,
    undoRegistry,
    cleanup,
    organize,
    titles
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

  // ── Launch at login (v1.2) ──
  // macOS 13+ backs these with SMAppService — works for our unsigned app, which
  // shows up as 'myMem' under System Settings → Login Items. The OS can refuse
  // a write, so the renderer re-reads via app:getLoginItem and reflects reality.
  typedHandle('app:getLoginItem', () => ({
    openAtLogin: app.getLoginItemSettings().openAtLogin
  }))
  typedHandle('app:setLoginItem', ({ openAtLogin }) => {
    app.setLoginItemSettings({ openAtLogin })
    return { ok: true as const }
  })

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
      // Titles (M8): a user title edit locks the note out of generation forever;
      // a content edit (re)schedules the 10 s-debounced utility-model titling.
      if (patch.title !== undefined) s.titles.noteTitleEdited(id)
      else if (patch.contentMd !== undefined) s.titles.noteContentEdited(id)
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
  typedHandle('settings:get', ({ key }) => {
    // ai.creds.* rows are safeStorage-encrypted credential blobs. The renderer has
    // no decrypt path and no business holding ciphertext (it narrows brute-force /
    // exfiltration targets if the renderer is ever compromised) — serve null.
    if (key.startsWith('ai.creds.')) return null
    return s.settings.get(key)
  })
  typedHandle('settings:set', ({ key, value }) => {
    s.settings.set(key, value)
    push('settings:changed', { key, value })
    // Consent flips the embeddings worker on (also the renderer's retry path).
    if (key === 'embeddings.consent') {
      if (value === true) s.embedder.start()
      else s.embedder.disable() // consent off takes effect immediately, stays restartable
    }
    // Menu bar icon toggles live (default ON — only an explicit false disables).
    if (key === 'ui.menuBarIcon') setTrayEnabled(value !== false)
    return { ok: true as const }
  })
  typedHandle('theme:set', ({ theme }) => {
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      throw new Error(`invalid theme '${String(theme)}'`)
    }
    s.settings.set('ui.theme', theme)
    // themeSource fires nativeTheme 'updated' → index.ts pushes theme:changed →
    // the renderer toggles .dark. The renderer never writes back, so no loop.
    nativeTheme.themeSource = theme
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

  // ── Chat / AI (M7) ──
  typedHandle('chat:send', ({ chatId, content, contextChips, model }) => {
    let chat = chatId ? s.chats.get(chatId) : null
    // Validate BEFORE creating the chat row or locking the model: a throw here
    // must not orphan a 'New chat' row, and a bogus renderer-supplied pair must
    // not lock in and brick the chat.
    let choice: { providerId: string; modelId: string } | null = null
    if (!chat?.providerId || !chat.modelId) {
      // Model locks at first send: explicit pick > settings default > first available.
      choice = model ?? s.providers.defaultModel()
      if (!choice) throw new Error('No AI provider connected — connect one in Settings → AI.')
      const connected = s.providers.status().providers.find((p) => p.id === choice!.providerId)?.connected
      if (!connected || !s.providers.resolveModel(choice.providerId, choice.modelId)) {
        throw new Error(`Model ${choice.providerId}/${choice.modelId} is not available — pick another model.`)
      }
    }
    if (!chat) chat = s.chats.create()
    if (choice) s.chats.setModel(chat.id, choice.providerId, choice.modelId)
    const requestId = uuidv7()
    // Fire and return — the turn streams back via chat:event pushes.
    void s.agent.runTurn({ chatId: chat.id, requestId, content, chips: contextChips })
    return { chatId: chat.id, requestId }
  })
  typedHandle('chat:cancel', ({ chatId }) => {
    s.agent.cancel(chatId)
    return { ok: true as const }
  })
  typedHandle('chats:list', () => s.chats.list())
  typedHandle('chats:get', ({ chatId }) => {
    const chat = s.chats.get(chatId)
    if (!chat) throw new Error(`chat not found: ${chatId}`)
    return { chat, messages: s.chats.messages(chatId) }
  })
  typedHandle('chats:delete', ({ chatId }) => {
    s.chats.delete(chatId)
    return { ok: true as const }
  })
  typedHandle('chat:saveAsNote', ({ chatId, messageId }) => {
    const chat = s.chats.get(chatId)
    if (!chat) throw new Error(`chat not found: ${chatId}`)
    const row = s.chats.messages(chatId).find((m) => m.id === messageId)
    if (!row || row.role !== 'assistant') throw new Error(`assistant message not found: ${messageId}`)
    const content = (row.content as { content?: { type: string; text?: string }[] }).content ?? []
    const text = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n\n')
    if (!text.trim()) throw new Error('that message has no text to save')
    const note = s.notes.create({ title: chat.title === 'New chat' ? '' : chat.title, contentMd: text, titleSource: 'ai' })
    s.indexer.enqueue(note.id)
    // origin 'user': saving is an explicit user action (and must not trigger the
    // "Note updated by chat — Reload" treatment AI writes get).
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'user' })
    return note
  })
  typedHandle('ai:models', () => s.providers.models())
  typedHandle('ai:undo', ({ undoToken }) => {
    // One registry behind both chat-turn and auto-organize tokens.
    s.undoRegistry.undo(undoToken)
    return { ok: true as const }
  })

  // ── Clean Up / Auto-organize (M8) ──
  typedHandle('ai:cleanup:start', (input) => s.cleanup.start(input))
  typedHandle('ai:cleanup:refine', (input) => s.cleanup.refine(input))
  typedHandle('ai:cleanup:accept', (input) => s.cleanup.accept(input))
  typedHandle('ai:cleanup:cancel', (input) => s.cleanup.cancel(input))
  typedHandle('ai:autoOrganize', ({ noteId }) => s.organize.run(noteId))
  typedHandle('oauth:login', ({ provider, method }) => s.providers.login(provider, method))
  typedHandle('oauth:cancel', ({ provider }) => {
    s.providers.cancelLogin(provider)
    return { ok: true as const }
  })
  typedHandle('oauth:logout', ({ provider }) => {
    s.providers.logout(provider)
    return { ok: true as const }
  })
  typedHandle('oauth:status', () => s.providers.status())
  typedHandle('apikey:set', ({ provider, apiKey }) => s.providers.setApiKey(provider, apiKey))

  // ── Quick capture ──
  typedHandle('capture:save', ({ text, autoOrganize }) => {
    const firstLine = text.split('\n', 1)[0]!.replace(/^#+\s*/, '').trim()
    const note = s.notes.create({
      title: firstLine.length <= 80 ? firstLine : '',
      contentMd: text
    })
    s.indexer.enqueue(note.id)
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'capture' })
    // M8: fire-and-forget organize (panel toggle) + titling for long first lines.
    // registerUndo: false — the token would be discarded here, and registering it
    // would evict older, still-reachable records from the shared registry.
    if (autoOrganize) {
      void s.organize
        .run(note.id, { registerUndo: false })
        .catch((err) => console.error('capture auto-organize failed', err))
    }
    if (note.title === '') s.titles.noteContentEdited(note.id)
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
