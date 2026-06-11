/**
 * THE single IPC contract between main and renderer (critique resolution: one file,
 * one naming scheme — `domain:action` colon channels for both invoke and push).
 *
 * The full channel surface is declared here on day one; handlers register milestone by
 * milestone (invoking an unregistered channel rejects at runtime, which is fine —
 * the renderer only calls what its milestone shipped).
 */
import type {
  ChatEvent,
  ChatMeta,
  Collection,
  CollectionWithCount,
  ContextChip,
  EmbeddingsStatus,
  ModelChoice,
  Note,
  NoteListItem,
  Pin,
  ProviderStatus,
  RelatedCollection,
  RelatedNote,
  SearchResult,
  Template,
  VersionMeta
} from './types'

export type DataChangedEvent = {
  entity: 'note' | 'collection' | 'pin' | 'template'
  ids: string[]
  op: 'create' | 'update' | 'trash' | 'restore' | 'delete'
  origin: 'user' | 'ai' | 'import' | 'capture' | 'api'
}

/** CommandIds dispatched from the native menu into the renderer command registry (M2). */
export type CommandId =
  | 'new-note'
  | 'new-chat'
  | 'open-search'
  | 'toggle-sidebar'
  | 'toggle-right-panel'
  | 'toggle-heads-up'
  | 'open-settings'
  | 'organize'
  | 'auto-organize'
  | 'clean-up'
  | 'toggle-pin'
  | 'split-pane'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'nav-back'
  | 'nav-forward'
  | 'find-in-note'
  | 'export-note'
  | 'import-files'
  | 'view-history'
  // Cmd+1–9 tab activation goes through the native menu like every other shortcut
  | 'activate-tab-1'
  | 'activate-tab-2'
  | 'activate-tab-3'
  | 'activate-tab-4'
  | 'activate-tab-5'
  | 'activate-tab-6'
  | 'activate-tab-7'
  | 'activate-tab-8'
  | 'activate-tab-9'

export interface IpcInvokeMap {
  'app:ping': {
    args: []
    result: { ok: true; version: string; electron: string; node: string }
  }

  // ── Notes ──────────────────────────────────────────────────────────────────
  'notes:create': {
    args: [{ title?: string; contentMd?: string; collectionIds?: string[] }]
    result: Note
  }
  'notes:get': {
    args: [{ id: string }]
    result: Note & { collectionIds: string[]; pinned: boolean }
  }
  'notes:update': {
    // baseUpdatedAt = compare-and-swap guard: mismatch → {conflict: true} (critique: agent-vs-editor writes)
    args: [{ id: string; patch: { title?: string; contentMd?: string }; baseUpdatedAt?: number }]
    result: { updatedAt: number; conflict?: boolean }
  }
  'notes:list': {
    args: [
      {
        scope: 'all' | 'collection' | 'trash'
        collectionId?: string
        limit?: number
        offset?: number
      }
    ]
    result: { items: NoteListItem[]; total: number }
  }
  'notes:trash': { args: [{ id: string }]; result: { ok: true } }
  'notes:restore': { args: [{ id: string }]; result: { ok: true } }
  'notes:deleteForever': { args: [{ id: string }]; result: { ok: true } }
  'notes:emptyTrash': { args: []; result: { deleted: number } }
  'notes:import': { args: [{ filePaths: string[] }]; result: { createdIds: string[] } }
  'notes:export': { args: [{ id: string }]; result: { ok: true; path?: string } }

  // ── Collections ────────────────────────────────────────────────────────────
  'collections:create': { args: [{ name: string; description?: string }]; result: Collection }
  'collections:update': {
    args: [{ id: string; patch: { name?: string; description?: string } }]
    result: Collection
  }
  'collections:delete': { args: [{ id: string }]; result: { ok: true } }
  'collections:list': { args: []; result: CollectionWithCount[] }
  'collections:setForNote': {
    args: [{ noteId: string; collectionIds: string[] }]
    result: { ok: true }
  }
  'collections:bulk': {
    args: [{ noteIds: string[]; add: string[]; remove: string[] }]
    result: { ok: true }
  }

  // ── Pins / Templates / Versions ────────────────────────────────────────────
  'pins:list': { args: []; result: Pin[] }
  'pins:set': {
    args: [{ itemType: 'note' | 'collection'; itemId: string; pinned: boolean }]
    result: Pin[]
  }
  'pins:reorder': {
    args: [{ orderedKeys: { itemType: 'note' | 'collection'; itemId: string }[] }]
    result: Pin[]
  }
  'templates:list': { args: []; result: Template[] }
  'templates:create': { args: [{ name: string; contentMd: string }]; result: Template }
  'templates:update': {
    args: [{ id: string; patch: { name?: string; contentMd?: string } }]
    result: Template
  }
  'templates:delete': { args: [{ id: string }]; result: { ok: true } }
  'versions:list': { args: [{ noteId: string }]; result: VersionMeta[] }
  'versions:get': {
    args: [{ versionId: string }]
    result: { title: string; contentMd: string; createdAt: number }
  }
  'versions:restore': { args: [{ versionId: string }]; result: Note }

  // ── Search / related (M3, M5) ──────────────────────────────────────────────
  'search:typeahead': { args: [{ q: string }]; result: { noteId: string; title: string }[] }
  'search:query': {
    args: [{ q: string; mode: 'keyword' | 'deep'; collectionId?: string; limit?: number }]
    result: { results: SearchResult[]; usedMode: 'keyword' | 'deep' }
  }
  'related:forNote': {
    args: [{ noteId: string; broaden?: boolean }]
    result: { notes: RelatedNote[]; collections: RelatedCollection[]; unavailableReason?: string }
  }
  'index:rebuild': { args: []; result: { jobId: string } }
  'embeddings:status': { args: []; result: EmbeddingsStatus }

  // ── Settings ───────────────────────────────────────────────────────────────
  'settings:get': { args: [{ key: string }]; result: unknown }
  'settings:set': { args: [{ key: string; value: unknown }]; result: { ok: true } }
  // Theme is a real channel (not a bare settings:set): main must also flip
  // nativeTheme.themeSource, which drives both the vibrancy material and the
  // theme:changed push that toggles the renderer's .dark class.
  'theme:set': { args: [{ theme: 'light' | 'dark' | 'system' }]; result: { ok: true } }

  // ── Chat / AI (M7–M8) ─────────────────────────────────────────────────────
  'chat:send': {
    args: [
      {
        chatId?: string
        content: string
        contextChips: ContextChip[]
        model?: { providerId: string; modelId: string }
      }
    ]
    result: { chatId: string; requestId: string }
  }
  'chat:cancel': { args: [{ chatId: string }]; result: { ok: true } }
  'chats:list': { args: []; result: ChatMeta[] }
  'chats:get': { args: [{ chatId: string }]; result: { chat: ChatMeta; messages: unknown[] } }
  'chats:delete': { args: [{ chatId: string }]; result: { ok: true } }
  'chat:saveAsNote': { args: [{ chatId: string; messageId: string }]; result: Note }
  'ai:cleanup:start': {
    // webPaste (v1.1): set by the paste-nudge toast path — relaxes the cleanup
    // contract to allow stripping web debris (nav/cookie/footer junk). Optional
    // and absent for ordinary Cmd+Shift+U cleanups (backward compatible).
    args: [{ noteId: string; webPaste?: boolean }]
    result: { sessionId: string }
  }
  'ai:cleanup:refine': {
    args: [{ sessionId: string; instruction: string }]
    result: { ok: true }
  }
  'ai:cleanup:accept': { args: [{ sessionId: string }]; result: { updatedAt: number } }
  'ai:cleanup:cancel': { args: [{ sessionId: string }]; result: { ok: true } }
  'ai:autoOrganize': {
    args: [{ noteId: string }]
    result: {
      applied: { collectionId: string; name: string }[]
      created: { collectionId: string; name: string }[]
      undoToken: string
    }
  }
  'ai:undo': { args: [{ undoToken: string }]; result: { ok: true } }
  'ai:models': { args: []; result: ModelChoice[] }
  'oauth:login': { args: [{ provider: string; method?: 'browser' | 'device_code' }]; result: { ok: boolean; error?: string } }
  'oauth:cancel': { args: [{ provider: string }]; result: { ok: true } }
  'oauth:logout': { args: [{ provider: string }]; result: { ok: true } }
  // encryptionAvailable=false → safeStorage has no keychain access: AI features are
  // disabled entirely (no plaintext credential fallback — deliberate).
  'oauth:status': { args: []; result: { providers: ProviderStatus[]; encryptionAvailable: boolean } }
  'apikey:set': { args: [{ provider: string; apiKey: string }]; result: { ok: boolean; error?: string } }

  // ── Quick capture ──────────────────────────────────────────────────────────
  'capture:save': {
    args: [{ text: string; autoOrganize?: boolean }]
    result: { noteId: string | null }
  }
  'capture:hide': { args: []; result: void }
}

export interface IpcPushMap {
  'data:changed': DataChangedEvent
  'menu:command': { commandId: CommandId }
  'theme:changed': { dark: boolean }
  'settings:changed': { key: string; value: unknown }
  'index:progress': { jobId: string; phase: 'chunking' | 'embedding'; done: number; total: number }
  'embeddings:status-changed': EmbeddingsStatus
  'chat:event': { chatId: string; requestId: string; ev: ChatEvent }
  'ai:cleanup:result': { sessionId: string; cleanedMd?: string; error?: string }
  'oauth:prompt': { provider: string; verificationUrl: string; userCode: string }
  'import:progress': { done: number; total: number }
  'capture:focus': undefined
}

export type InvokeChannel = keyof IpcInvokeMap
export type PushChannel = keyof IpcPushMap

// Runtime allowlists used by the preload bridge. Derived as literal lists (keyof is
// type-level only); a unit test in M2 asserts these stay in sync with the maps above.
export const INVOKE_CHANNELS = [
  'app:ping',
  'notes:create', 'notes:get', 'notes:update', 'notes:list', 'notes:trash', 'notes:restore',
  'notes:deleteForever', 'notes:emptyTrash', 'notes:import', 'notes:export',
  'collections:create', 'collections:update', 'collections:delete', 'collections:list',
  'collections:setForNote', 'collections:bulk',
  'pins:list', 'pins:set', 'pins:reorder',
  'templates:list', 'templates:create', 'templates:update', 'templates:delete',
  'versions:list', 'versions:get', 'versions:restore',
  'search:typeahead', 'search:query', 'related:forNote', 'index:rebuild', 'embeddings:status',
  'settings:get', 'settings:set', 'theme:set',
  'chat:send', 'chat:cancel', 'chats:list', 'chats:get', 'chats:delete', 'chat:saveAsNote',
  'ai:cleanup:start', 'ai:cleanup:refine', 'ai:cleanup:accept', 'ai:cleanup:cancel',
  'ai:autoOrganize', 'ai:undo', 'ai:models',
  'oauth:login', 'oauth:cancel', 'oauth:logout', 'oauth:status', 'apikey:set',
  'capture:save', 'capture:hide'
] as const satisfies readonly InvokeChannel[]

export const PUSH_CHANNELS = [
  'data:changed', 'menu:command', 'theme:changed', 'settings:changed',
  'index:progress', 'embeddings:status-changed',
  'chat:event', 'ai:cleanup:result', 'oauth:prompt', 'import:progress',
  'capture:focus'
] as const satisfies readonly PushChannel[]
