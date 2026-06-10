/** Shared domain types. Expanded milestone by milestone — keep renderer/main in lockstep via this file only. */

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

export interface Collection {
  id: CollectionId
  name: string
  description: string
  createdAt: number
}
