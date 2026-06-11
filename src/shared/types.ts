/** Shared domain types. Keep dependency-free and DOM-free (included by both tsconfigs). */

export type NoteId = string // UUIDv7
export type CollectionId = string // UUIDv7

export interface NoteMeta {
  id: NoteId
  title: string
  titleSource: 'user' | 'ai'
  createdAt: number
  updatedAt: number
  trashedAt: number | null
}

export interface Note extends NoteMeta {
  contentMd: string
}

export interface NoteListItem extends NoteMeta {
  excerpt: string
  collectionIds: CollectionId[]
}

export interface Collection {
  id: CollectionId
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

export interface CollectionWithCount extends Collection {
  noteCount: number
}

export interface Pin {
  itemType: 'note' | 'collection'
  itemId: string
  sortOrder: number
  pinnedAt: number
}

export interface Template {
  id: string
  name: string
  contentMd: string
  createdAt: number
  updatedAt: number
}

export type VersionKind = 'session' | 'pre_cleanup' | 'pre_restore' | 'import' | 'ai_edit'

export interface VersionMeta {
  id: string
  noteId: NoteId
  kind: VersionKind
  createdAt: number
  sizeChars: number
}

export interface SearchResult {
  noteId: NoteId
  title: string
  snippetHtml: string
  score: number
}

export interface RelatedNote {
  noteId: NoteId
  title: string
  score: number
}

export interface RelatedCollection {
  collectionId: CollectionId
  name: string
  score: number
}

export interface ChatMeta {
  id: string
  title: string
  providerId: string | null
  modelId: string | null
  createdAt: number
  updatedAt: number
}

export interface ContextChip {
  type: 'note' | 'collection'
  id: string
}

/**
 * Canonical chat stream union (design C, adopted by critique): models multi-iteration
 * agent turns. Keyed by turnId; relayed via WebContents.send correlated by requestId.
 */
export type ChatEvent =
  | { type: 'turn_start'; turnId: string }
  | { type: 'text_delta'; turnId: string; delta: string }
  | { type: 'thinking'; turnId: string; delta: string }
  | { type: 'tool_start'; turnId: string; callId: string; name: string; label: string }
  | { type: 'tool_end'; turnId: string; callId: string; ok: boolean; summary: string }
  | {
      type: 'turn_end'
      turnId: string
      messageId: string
      usage?: { input: number; output: number; costUsd?: number }
      /** Present when the turn mutated notes — feeds the "Chat edited your notes — Undo" toast (ai:undo). */
      undoToken?: string
    }
  | {
      type: 'error'
      turnId: string
      code: 'auth_expired' | 'rate_limited' | 'context_too_long' | 'cancelled' | 'unknown'
      message: string
    }

export type EmbeddingsState = 'downloading' | 'ready' | 'error' | 'disabled'

export interface EmbeddingsStatus {
  state: EmbeddingsState
  model: string
  dim: number
  progress?: number // 0..1 while downloading
  error?: string
}

export interface ProviderStatus {
  id: string
  label: string
  kind: 'oauth' | 'apiKey'
  connected: boolean
  account?: string
  /** An oauth:login flow is in flight — the Settings overlay derives its busy state from this. */
  pendingLogin?: boolean
}

export interface ModelChoice {
  providerId: string
  modelId: string
  label: string
  contextWindow: number
  reasoning: boolean
}
