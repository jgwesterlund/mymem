import { Type, stream as piStream } from '@earendil-works/pi-ai'
import type { Api, Context, Message, Model, Tool, ToolCall } from '@earendil-works/pi-ai'
import type { DataChangedEvent } from '@shared/ipc'
import type { NotesRepo } from '../db/repos/notesRepo'
import type { CollectionsRepo } from '../db/repos/collectionsRepo'
import type { StreamFn } from './agent'
import type { UndoRegistry } from './undoRegistry'
import { ORGANIZE_SYSTEM_PROMPT } from './prompts'

/**
 * Auto-organize (Cmd+Shift+O, single note — bulk is a deliberate cut): ONE
 * forced file_note tool call on the utility model, applied main-side with
 * hard-coded thresholds (0.55 existing / 0.7 new — dogfood-iterated), undo via
 * the shared registry.
 *
 * toolChoice forcing: Anthropic honors it (passed through stream options);
 * Codex/openai do NOT — there the only-tool + 'MUST call exactly once' system
 * instruction + validate + ONE retry path applies (verified in the M7 review).
 */

export const THRESHOLD_EXISTING = 0.55
export const THRESHOLD_NEW = 0.7
/** Note content cap for the prompt: ~6k tokens at chars/4. */
const CONTENT_CAP_CHARS = 24_000
/** Model-output hardening: at most 5 assignments, collection names ≤100 chars. */
const MAX_ASSIGNMENTS = 5
const MAX_COLLECTION_NAME_CHARS = 100

export const FILE_NOTE_TOOL: Tool = {
  name: 'file_note',
  description:
    'File the note into collections. assignments may be empty when nothing fits. Call this tool exactly once.',
  parameters: Type.Object({
    assignments: Type.Array(
      Type.Object({
        collection: Type.String({ description: 'Collection name (existing name verbatim, or the proposed new name)' }),
        confidence: Type.Number({ description: 'How sure you are the note belongs there, 0..1' }),
        isNew: Type.Boolean({ description: 'true when proposing a collection that does not exist yet' }),
        reason: Type.String({ description: 'One short sentence: why this collection' })
      })
    )
  })
}

export interface Assignment {
  collection: string
  confidence: number
  isNew: boolean
  reason: string
}

export interface OrganizeResult {
  applied: { collectionId: string; name: string }[]
  created: { collectionId: string; name: string }[]
  undoToken: string
}

export interface OrganizeDeps {
  notes: NotesRepo
  collections: CollectionsRepo
  emitDataChanged: (ev: DataChangedEvent) => void
  undoRegistry: UndoRegistry
  getApiKey: (providerId: string) => Promise<string>
  utilityModel: () => { providerId: string; modelId: string } | null
  resolveModel: (providerId: string, modelId: string) => Model<Api> | null
  streamFn?: StreamFn
}

/** Extract + validate the forced tool call; null → caller retries/errors. */
function parseAssignments(content: (ToolCall | { type: string })[]): Assignment[] | null {
  const call = content.find((c): c is ToolCall => c.type === 'toolCall' && (c as ToolCall).name === 'file_note')
  if (!call) return null
  const args = call.arguments as { assignments?: unknown }
  if (!Array.isArray(args.assignments)) return null
  const out: Assignment[] = []
  for (const raw of args.assignments) {
    const a = raw as Partial<Assignment>
    if (typeof a.collection !== 'string' || typeof a.confidence !== 'number' || typeof a.isNew !== 'boolean') {
      return null
    }
    out.push({
      collection: a.collection,
      confidence: Math.min(1, Math.max(0, a.confidence)),
      isNew: a.isNew,
      reason: typeof a.reason === 'string' ? a.reason : ''
    })
  }
  return out
}

export function createOrganizeService(deps: OrganizeDeps) {
  const streamFn = deps.streamFn ?? (piStream as StreamFn)

  async function callModel(noteId: string): Promise<Assignment[]> {
    const note = deps.notes.get(noteId)
    if (!note) throw new Error(`note not found: ${noteId}`)
    if (note.trashedAt !== null) throw new Error('That note is in the trash.')
    const choice = deps.utilityModel()
    const model = choice ? deps.resolveModel(choice.providerId, choice.modelId) : null
    if (!choice || !model) throw new Error('No AI provider connected — connect one in Settings → AI.')
    const apiKey = await deps.getApiKey(choice.providerId)

    const collections = deps.collections.list()
    const collectionLines =
      collections.length === 0
        ? '(none yet)'
        : collections
            .map((c) => `- ${c.name}${c.description ? ` — ${c.description}` : ''} (${c.noteCount} notes)`)
            .join('\n')
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          `<note title="${(note.title || 'Untitled').replace(/"/g, '&quot;')}">`,
          note.contentMd.slice(0, CONTENT_CAP_CHARS),
          '</note>',
          '',
          '<collections>',
          collectionLines,
          '</collections>'
        ].join('\n'),
        timestamp: Date.now()
      }
    ]
    const context: Context = { systemPrompt: ORGANIZE_SYSTEM_PROMPT, messages, tools: [FILE_NOTE_TOOL] }
    // Anthropic honors toolChoice (ProviderStreamOptions passthrough); Codex has no
    // such option — the instruction + validate + retry below covers it.
    const options: Record<string, unknown> = { apiKey }
    if (model.api === 'anthropic-messages') options.toolChoice = { type: 'tool', name: 'file_note' }

    for (let attempt = 0; attempt < 2; attempt++) {
      const s = streamFn(model, context, options)
      const result = await s.result()
      if (result.stopReason === 'error') throw new Error(result.errorMessage ?? 'The model request failed.')
      const assignments = parseAssignments(result.content)
      if (assignments !== null) return assignments
      // ONE retry: feed the miss back so the model corrects itself.
      context.messages = [
        ...messages,
        result,
        {
          role: 'user',
          content: 'You must call the file_note tool exactly once with your assignments. Do not answer in text.',
          timestamp: Date.now()
        }
      ]
    }
    throw new Error('The model did not return a valid file_note call.')
  }

  return {
    /**
     * ai:autoOrganize — returns what was applied; empty arrays + '' token when
     * nothing qualified. registerUndo: false (quick capture's fire-and-forget
     * path discards the token) skips the shared 20-record registry so it cannot
     * evict undoable chat-turn/organize records; the token comes back ''.
     */
    async run(noteId: string, opts?: { registerUndo?: boolean }): Promise<OrganizeResult> {
      const assignments = (await callModel(noteId)).slice(0, MAX_ASSIGNMENTS)

      const refs = deps.notes.getWithRefs(noteId)
      if (!refs) throw new Error(`note not found: ${noteId}`)
      const member = new Set(refs.collectionIds)
      const seen = new Set<string>()
      const applied: { collectionId: string; name: string }[] = []
      const created: { collectionId: string; name: string }[] = []
      const memberships: { noteId: string; collectionId: string }[] = []
      const createdCollectionIds: string[] = []

      for (const a of assignments) {
        const name = a.collection.trim().slice(0, MAX_COLLECTION_NAME_CHARS)
        if (!name || seen.has(name.toLowerCase())) continue
        seen.add(name.toLowerCase())
        // Resolve by name first: a claimed-new collection that already exists is
        // treated as existing (and judged on the existing threshold).
        const existing = deps.collections.getByName(name)
        if (existing) {
          if (a.confidence < THRESHOLD_EXISTING || member.has(existing.id)) continue
          deps.collections.bulk([noteId], [existing.id], [])
          member.add(existing.id)
          memberships.push({ noteId, collectionId: existing.id })
          applied.push({ collectionId: existing.id, name: existing.name })
        } else if (a.isNew && a.confidence >= THRESHOLD_NEW) {
          const col = deps.collections.create({ name })
          createdCollectionIds.push(col.id)
          deps.collections.bulk([noteId], [col.id], [])
          member.add(col.id)
          memberships.push({ noteId, collectionId: col.id })
          created.push({ collectionId: col.id, name: col.name })
        }
      }

      if (createdCollectionIds.length > 0) {
        deps.emitDataChanged({ entity: 'collection', ids: createdCollectionIds, op: 'create', origin: 'ai' })
      }
      if (memberships.length > 0) {
        deps.emitDataChanged({ entity: 'note', ids: [noteId], op: 'update', origin: 'ai' })
      }

      const undoToken =
        opts?.registerUndo === false
          ? ''
          : deps.undoRegistry.register({ snapshots: [], createdNoteIds: [], memberships, createdCollectionIds }) ?? ''
      return { applied, created, undoToken }
    }
  }
}

export type OrganizeService = ReturnType<typeof createOrganizeService>
