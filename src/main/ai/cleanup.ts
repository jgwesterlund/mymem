import { uuidv7 } from 'uuidv7'
import { stream as piStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai'
import type { DataChangedEvent, IpcPushMap } from '@shared/ipc'
import type { NotesRepo } from '../db/repos/notesRepo'
import type { VersionsRepo } from '../db/repos/miscRepos'
import type { Indexer } from '../indexing/indexer'
import type { StreamFn } from './agent'
import { CLEANUP_SYSTEM_PROMPT } from './prompts'

/**
 * Clean Up (Cmd+Shift+U): main-side session API. start streams a full revised
 * markdown on the DEFAULT chat model (quality over cost — decided); the result
 * arrives via the ai:cleanup:result push. refine re-streams with the running
 * transcript (max 5 rounds); accept snapshots pre_cleanup THEN writes; cancel
 * aborts any in-flight generation. Sessions are in-memory and die with the app.
 *
 * Deliberate cut: NO sectioned cleanup for long notes — a hard token cap
 * rejects them with a 'too long' error instead.
 */

const MAX_REFINEMENTS = 5
/** Hard cap: min(12k tokens, a quarter of the model's context window), chars/4. */
const HARD_CAP_TOKENS = 12_000
const RATIO_MIN = 0.5
const RATIO_MAX = 2.0
/** A refine that explicitly asks for a length change lifts the ratio guard. */
const LENGTH_INTENT = /\b(shorten|shorter|longer|lengthen|expand|trim|condense|cut|förkorta|utöka)\b/i

interface CleanupSession {
  noteId: string
  baseMd: string
  /** note.updatedAt at start — accept refuses when anything wrote the note since. */
  baseUpdatedAt: number
  transcript: Message[]
  /** Latest valid cleaned markdown (what accept writes). */
  latest: string | null
  refineCount: number
  /** Instruction behind the CURRENT generation (null for the initial pass). */
  lastInstruction: string | null
  controller: AbortController | null
  generating: boolean
  model: Model<Api>
  providerId: string
}

export interface CleanupDeps {
  notes: NotesRepo
  versions: VersionsRepo
  indexer: Indexer
  emitDataChanged: (ev: DataChangedEvent) => void
  pushResult: (payload: IpcPushMap['ai:cleanup:result']) => void
  getApiKey: (providerId: string) => Promise<string>
  defaultModel: () => { providerId: string; modelId: string } | null
  resolveModel: (providerId: string, modelId: string) => Model<Api> | null
  streamFn?: StreamFn
}

/** Count fenced code blocks (chunker-style fence pairing) — must survive cleanup unchanged. */
export function countCodeBlocks(md: string): number {
  const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
  let blocks = 0
  let close: RegExp | null = null
  for (const line of md.split('\n')) {
    if (close) {
      if (close.test(line)) close = null
      continue
    }
    const m = FENCE_OPEN.exec(line)
    if (m) {
      blocks++
      const marker = m[1]!
      close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
    }
  }
  return blocks
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

/** Models sometimes fence the whole reply despite instructions — unwrap that one case. */
function unwrapOuterFence(text: string, baseMd: string): string {
  if (/^ {0,3}(```|~~~)/.test(baseMd)) return text // the note itself starts fenced — leave it
  const m = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(text)
  return m ? m[1]! : text
}

/** Returns a violation reason, or null when the candidate passes. */
export function validateCleanup(baseMd: string, cleanedMd: string, instruction: string | null): string | null {
  if (cleanedMd.trim() === '') return 'empty response'
  if (countCodeBlocks(cleanedMd) !== countCodeBlocks(baseMd)) return 'code-block count changed'
  const lengthIntended = instruction !== null && LENGTH_INTENT.test(instruction)
  if (!lengthIntended && baseMd.length > 0) {
    const ratio = cleanedMd.length / baseMd.length
    if (ratio < RATIO_MIN || ratio > RATIO_MAX) return 'length changed too much'
  }
  return null
}

export function createCleanupService(deps: CleanupDeps) {
  const streamFn = deps.streamFn ?? (piStream as StreamFn)
  const sessions = new Map<string, CleanupSession>()

  /** Streams once (plus ONE silent retry on a validation violation), then pushes the result. */
  async function generate(sessionId: string, session: CleanupSession): Promise<void> {
    const controller = new AbortController()
    session.controller = controller
    session.generating = true
    try {
      const apiKey = await deps.getApiKey(session.providerId)
      let violation = 'no attempt ran'
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = streamFn(
          session.model,
          { systemPrompt: CLEANUP_SYSTEM_PROMPT, messages: session.transcript },
          { apiKey, signal: controller.signal }
        )
        const result = await s.result()
        if (result.stopReason === 'aborted' || controller.signal.aborted) return // cancelled — session is gone
        if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'The model request failed.')
        const cleaned = unwrapOuterFence(textOf(result).trim(), session.baseMd)
        const reason = validateCleanup(session.baseMd, cleaned, session.lastInstruction)
        if (reason === null) {
          session.latest = cleaned
          deps.pushResult({ sessionId, cleanedMd: cleaned })
          return
        }
        violation = reason
      }
      deps.pushResult({ sessionId, error: `The cleanup did not pass validation (${violation}) — try again.` })
    } catch (err) {
      if (controller.signal.aborted) return
      deps.pushResult({ sessionId, error: err instanceof Error ? err.message : String(err) })
    } finally {
      session.generating = false
      session.controller = null
    }
  }

  return {
    start({ noteId }: { noteId: string }): { sessionId: string } {
      const note = deps.notes.get(noteId)
      if (!note) throw new Error(`note not found: ${noteId}`)
      if (note.trashedAt !== null) throw new Error('That note is in the trash.')
      const choice = deps.defaultModel()
      const model = choice ? deps.resolveModel(choice.providerId, choice.modelId) : null
      if (!choice || !model) throw new Error('No AI provider connected — connect one in Settings → AI.')

      const sessionId = uuidv7()
      // Hard length cap (chars/4 ≈ tokens) — error via the SAME push channel the
      // overlay already listens on (it buffers pushes until start resolves).
      const cap = Math.min(HARD_CAP_TOKENS, model.contextWindow / 4)
      if ((note.title.length + note.contentMd.length) / 4 > cap) {
        deps.pushResult({ sessionId, error: 'note too long to clean' })
        return { sessionId }
      }

      const session: CleanupSession = {
        noteId,
        baseMd: note.contentMd,
        baseUpdatedAt: note.updatedAt,
        transcript: [{ role: 'user', content: `<note>\n${note.contentMd}\n</note>`, timestamp: Date.now() }],
        latest: null,
        refineCount: 0,
        lastInstruction: null,
        controller: null,
        generating: false,
        model,
        providerId: choice.providerId
      }
      sessions.set(sessionId, session)
      void generate(sessionId, session)
      return { sessionId }
    },

    refine({ sessionId, instruction }: { sessionId: string; instruction: string }): { ok: true } {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('Cleanup session not found — it may have been cancelled.')
      if (session.generating) throw new Error('A cleanup is already generating — wait for it to finish.')
      if (session.latest === null) throw new Error('Nothing to refine yet.')
      if (session.refineCount >= MAX_REFINEMENTS) {
        throw new Error(`Refinement limit reached (${MAX_REFINEMENTS}) — accept or cancel.`)
      }
      session.refineCount++
      session.lastInstruction = instruction
      // The previous candidate becomes part of the conversation the model refines.
      session.transcript.push({
        role: 'assistant',
        content: [{ type: 'text', text: session.latest }],
        api: session.model.api,
        provider: session.model.provider,
        model: session.model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'stop',
        timestamp: Date.now()
      })
      session.transcript.push({
        role: 'user',
        content: `Refine: ${instruction} — return the full revised markdown`,
        timestamp: Date.now()
      })
      void generate(sessionId, session)
      return { ok: true }
    },

    accept({ sessionId }: { sessionId: string }): { updatedAt: number } {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('Cleanup session not found — it may have been cancelled.')
      if (session.generating || session.latest === null) throw new Error('The cleanup is still generating.')
      const note = deps.notes.get(session.noteId)
      if (!note) throw new Error(`note not found: ${session.noteId}`)
      // Guard BEFORE the snapshot — notes.update throws on trashed notes and an
      // already-committed pre_cleanup row would be orphaned (same as versions:restore).
      if (note.trashedAt !== null) throw new Error('That note is in the trash.')
      // Staleness guard: anything that wrote the note since start (chat agent,
      // CLI/API patch, a leaked keystroke) must win — never silently clobber it.
      if (note.updatedAt !== session.baseUpdatedAt) {
        sessions.delete(sessionId) // the session's base is gone — a retry can never succeed
        throw new Error('The note changed while cleaning up — close and rerun Clean Up.')
      }
      deps.versions.snapshot(note, 'pre_cleanup')
      const res = deps.notes.update(session.noteId, { contentMd: session.latest })
      deps.indexer.enqueue(session.noteId)
      deps.emitDataChanged({ entity: 'note', ids: [session.noteId], op: 'update', origin: 'ai' })
      sessions.delete(sessionId)
      return { updatedAt: res.updatedAt }
    },

    /** Tolerant of unknown ids — the overlay fires this on unmount as a catch-all. */
    cancel({ sessionId }: { sessionId: string }): { ok: true } {
      const session = sessions.get(sessionId)
      if (session) {
        session.controller?.abort()
        sessions.delete(sessionId)
      }
      return { ok: true }
    },

    /** Test hook: number of live sessions. */
    sessionCount(): number {
      return sessions.size
    }
  }
}

export type CleanupService = ReturnType<typeof createCleanupService>
