import { complete as piComplete } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from '@earendil-works/pi-ai'
import type { DataChangedEvent } from '@shared/ipc'
import type { NotesRepo } from '../db/repos/notesRepo'
import { NOTE_TITLE_SYSTEM_PROMPT } from './prompts'

/**
 * Note-title generation (M8): a concurrency-1 utility-model queue. Trigger:
 * a content edit lands on a note with an empty title and ≥80 chars of content
 * → 10 s debounce after the LAST edit → one completion → write the title ONLY
 * if it is still empty (the user may have typed one meanwhile).
 *
 * Rules: generate at most once per note (in-memory 'titled' set + skip when
 * title_source is already 'ai'); a user title edit locks the note permanently
 * (the notes:update handler pins title_source 'user' and tells us); the queue
 * pauses while any chat turn streams; offline/no-provider → skip silently.
 *
 * Display fallback ("first non-empty line"): NOT written to the DB — the note
 * list already shows 'Untitled' + an excerpt, which covers the offline case
 * without fake titles (documented deviation from the plan's display fallback).
 */

export type CompleteFn = (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => Promise<AssistantMessage>

const DEBOUNCE_MS = 10_000
const MIN_CONTENT_CHARS = 80
const MAX_TITLE_CHARS = 60
/** Poll interval while a chat turn is streaming (the queue stays paused). */
const PAUSE_POLL_MS = 1000

export interface TitlesDeps {
  notes: NotesRepo
  emitDataChanged: (ev: DataChangedEvent) => void
  getApiKey: (providerId: string) => Promise<string>
  utilityModel: () => { providerId: string; modelId: string } | null
  resolveModel: (providerId: string, modelId: string) => Model<Api> | null
  /** agent.isStreaming — true while any chat turn streams. */
  isChatStreaming: () => boolean
  completeFn?: CompleteFn
  debounceMs?: number
  pausePollMs?: number
}

export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '')
    .replace(/[.。!?]+$/, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim()
}

export function createTitlesService(deps: TitlesDeps) {
  const completeFn = deps.completeFn ?? (piComplete as CompleteFn)
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const pausePollMs = deps.pausePollMs ?? PAUSE_POLL_MS

  const titled = new Set<string>() // generated once per note, per app run
  const userLocked = new Set<string>() // the user touched the title this run — never regenerate
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const queue: string[] = []
  let pumping = false
  let completions = 0 // test hook

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  function eligible(noteId: string): boolean {
    if (titled.has(noteId) || userLocked.has(noteId)) return false
    const note = deps.notes.get(noteId)
    if (!note || note.trashedAt !== null) return false
    if (note.title !== '') return false
    if (note.titleSource === 'ai') return false // AI titled it in a previous run; user cleared it — leave it be
    return note.contentMd.length >= MIN_CONTENT_CHARS
  }

  async function processOne(noteId: string): Promise<void> {
    if (!eligible(noteId)) return
    const choice = deps.utilityModel()
    const model = choice ? deps.resolveModel(choice.providerId, choice.modelId) : null
    if (!choice || !model) return // no provider → skip silently (list shows 'Untitled' + excerpt)
    const note = deps.notes.get(noteId)
    if (!note) return
    try {
      const apiKey = await deps.getApiKey(choice.providerId)
      completions++
      // 64 maxTokens (not the plan's ~16): reasoning models spend tokens before
      // the answer — same allowance the chat-title path uses.
      const result = await completeFn(
        model,
        {
          systemPrompt: NOTE_TITLE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: note.contentMd.slice(0, 2000), timestamp: Date.now() }]
        },
        { apiKey, maxTokens: 64 }
      )
      if (result.stopReason !== 'stop' && result.stopReason !== 'length') return
      const title = sanitizeTitle(
        result.content
          .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
          .map((c) => c.text)
          .join('')
      )
      if (!title) return
      titled.add(noteId)
      // Re-check at write time: the user may have typed a title (or trashed the
      // note) while the completion was in flight — their state always wins.
      const fresh = deps.notes.get(noteId)
      if (!fresh || fresh.trashedAt !== null || fresh.title !== '' || userLocked.has(noteId)) return
      deps.notes.update(noteId, { title, titleSource: 'ai' })
      deps.emitDataChanged({ entity: 'note', ids: [noteId], op: 'update', origin: 'ai' })
    } catch {
      // offline / auth hiccup → skip silently; a later content edit retries
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        if (deps.isChatStreaming()) {
          await sleep(pausePollMs) // paused — chat latency beats background titling
          continue
        }
        const noteId = queue.shift()!
        await processOne(noteId)
      }
    } finally {
      pumping = false
    }
  }

  return {
    /** Call on every notes:update that carried contentMd (and on captures). */
    noteContentEdited(noteId: string): void {
      if (!eligible(noteId)) return
      // Debounce per note: a newer edit replaces the pending request (drop-if-stale).
      const existing = timers.get(noteId)
      if (existing) clearTimeout(existing)
      timers.set(
        noteId,
        setTimeout(() => {
          timers.delete(noteId)
          if (!queue.includes(noteId)) queue.push(noteId)
          void pump()
        }, debounceMs)
      )
    },

    /** Call when the user edits a title via notes:update — permanently stops generation. */
    noteTitleEdited(noteId: string): void {
      userLocked.add(noteId)
      const timer = timers.get(noteId)
      if (timer) {
        clearTimeout(timer)
        timers.delete(noteId)
      }
      const qi = queue.indexOf(noteId)
      if (qi >= 0) queue.splice(qi, 1)
    },

    /** Test hooks. */
    completionCount(): number {
      return completions
    },
    idle(): boolean {
      return !pumping && queue.length === 0 && timers.size === 0
    },
    /** Clear pending debounce timers (app quit / smoke teardown). */
    dispose(): void {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      queue.length = 0
    }
  }
}

export type TitlesService = ReturnType<typeof createTitlesService>
