import { app } from 'electron'
import { getDb } from '../db/connection'
import { createNotesRepo } from '../db/repos/notesRepo'
import { createCollectionsRepo } from '../db/repos/collectionsRepo'
import {
  createPinsRepo,
  createSettingsRepo,
  createTemplatesRepo,
  createVersionsRepo
} from '../db/repos/miscRepos'
import { typedHandle, emitDataChanged, push } from './registry'
import { hideQuickCapture } from '../windows/quickCapture'

export interface Services {
  notes: ReturnType<typeof createNotesRepo>
  collections: ReturnType<typeof createCollectionsRepo>
  pins: ReturnType<typeof createPinsRepo>
  templates: ReturnType<typeof createTemplatesRepo>
  versions: ReturnType<typeof createVersionsRepo>
  settings: ReturnType<typeof createSettingsRepo>
}

let services: Services | null = null

export function getServices(): Services {
  if (services) return services
  const db = getDb()
  services = {
    notes: createNotesRepo(db),
    collections: createCollectionsRepo(db),
    pins: createPinsRepo(db),
    templates: createTemplatesRepo(db),
    versions: createVersionsRepo(db),
    settings: createSettingsRepo(db)
  }
  return services
}

/** M1 surface: app/notes/collections/pins/templates/versions/settings/capture. */
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
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'user' })
    return note
  })
  typedHandle('notes:get', ({ id }) => {
    const note = s.notes.getWithRefs(id)
    if (!note) throw new Error(`note not found: ${id}`)
    return note
  })
  typedHandle('notes:update', ({ id, patch, baseUpdatedAt }) => {
    const res = s.notes.update(id, patch, baseUpdatedAt)
    if (!res.conflict) emitDataChanged({ entity: 'note', ids: [id], op: 'update', origin: 'user' })
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
    s.versions.snapshot(current, 'pre_restore') // non-destructive restore
    s.notes.update(noteId, { title: v.title, contentMd: v.contentMd })
    emitDataChanged({ entity: 'note', ids: [noteId], op: 'update', origin: 'user' })
    return s.notes.get(noteId)!
  })
  typedHandle('settings:get', ({ key }) => s.settings.get(key))
  typedHandle('settings:set', ({ key, value }) => {
    s.settings.set(key, value)
    push('settings:changed', { key, value })
    return { ok: true as const }
  })

  // ── Quick capture ──
  typedHandle('capture:save', ({ text }) => {
    const firstLine = text.split('\n', 1)[0]!.replace(/^#+\s*/, '').trim()
    const note = s.notes.create({
      title: firstLine.length <= 80 ? firstLine : '',
      contentMd: text
    })
    emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'capture' })
    return { noteId: note.id }
  })
  typedHandle('capture:hide', () => {
    hideQuickCapture()
  })
}
