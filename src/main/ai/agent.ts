import { uuidv7 } from 'uuidv7'
import { stream as piStream, isContextOverflow } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  ProviderStreamOptions,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@earendil-works/pi-ai'
import type { ChatEvent, ContextChip } from '@shared/types'
import type { ChatsRepo } from '../db/repos/chatsRepo'
import type { SettingsRepo } from '../db/repos/miscRepos'
import { buildSystemPrompt, TITLE_SYSTEM_PROMPT } from './prompts'
import { AGENT_TOOLS, executeTool, toolLabel } from './tools'
import type { ToolServices, UndoRecord } from './tools'
import type { Rag } from './rag'
import { AuthRequiredError } from './providers'

/**
 * Chat agent: assembles Context from persisted pi-ai messages, streams with
 * the chat's locked model, executes tool calls against the real services,
 * persists every message as it finalizes and relays ChatEvents to the
 * renderer. The stream function is injectable so the smoke test can drive a
 * scripted turn with zero network.
 */
export type StreamFn = (model: Model<Api>, context: Context, options?: ProviderStreamOptions) => AssistantMessageEventStream

export interface AgentDeps {
  chats: ChatsRepo
  settings: SettingsRepo
  services: ToolServices
  rag: Rag
  getApiKey: (providerId: string) => Promise<string>
  resolveModel: (providerId: string, modelId: string) => Model<Api> | null
  emit: (chatId: string, requestId: string, ev: ChatEvent) => void
  streamFn?: StreamFn
}

const MAX_ITERATIONS = 12
/** Hard pre-send error above 80% of the context window (deliberate cut: no eliding). */
const CONTEXT_BUDGET = 0.8
const MAX_UNDO_RECORDS = 20

/** Markers for injected user-side context messages — the renderer hides these bubbles. */
export const WORKSPACE_CONTEXT_PREFIX = '<workspace_context'
export const ATTACHED_CONTEXT_PREFIX = '<attached_context'

function classifyError(message: string): { code: 'auth_expired' | 'rate_limited' | 'unknown' } {
  if (/\b(401|403)\b|unauthoriz|forbidden|invalid[ _]api[ _]key|authentication|token.*(expired|revoked)|expired.*token/i.test(message)) {
    return { code: 'auth_expired' }
  }
  if (/\b429\b|rate.?limit|too many requests|quota exceeded|overloaded/i.test(message)) {
    return { code: 'rate_limited' }
  }
  return { code: 'unknown' }
}

/** chars/4 ≈ tokens — over the serialized system prompt + messages + tool schemas. */
function estimateTokens(systemPrompt: string, messages: Message[]): number {
  return Math.ceil((systemPrompt.length + JSON.stringify(messages).length + JSON.stringify(AGENT_TOOLS).length) / 4)
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('')
}

export function createAgent(deps: AgentDeps) {
  const streamFn = deps.streamFn ?? (piStream as StreamFn)
  const active = new Map<string, AbortController>() // chatId → in-flight turn
  const undoStore = new Map<string, UndoRecord>() // in-memory by design — undo is per-session

  function buildChipsContext(chips: ContextChip[]): string | null {
    const parts: string[] = []
    for (const chip of chips) {
      if (chip.type === 'note') {
        const note = deps.services.notes.get(chip.id)
        if (!note || note.trashedAt !== null) continue
        parts.push(`<note id="${note.id}" title="${(note.title || 'Untitled').replace(/"/g, '&quot;')}">\n${note.contentMd}\n</note>`)
      } else {
        const col = deps.services.collections.get(chip.id)
        if (!col) continue
        const { items } = deps.services.notes.list({ scope: 'collection', collectionId: col.id, limit: 100 })
        const titles = items.map((n) => `- ${n.title || 'Untitled'} (id: ${n.id})`).join('\n')
        parts.push(`<collection name="${col.name.replace(/"/g, '&quot;')}">\n${titles || '(empty)'}\n</collection>`)
      }
    }
    if (parts.length === 0) return null
    return `<attached_context note="attached by the user; cite notes you use as [Title](mymem://note/<id>)">\n${parts.join('\n')}\n</attached_context>`
  }

  /** Cheap post-turn title on the SAME model (utility-model selection is M8). Never throws. */
  async function generateTitle(chatId: string, model: Model<Api>, providerId: string, firstUserContent: string): Promise<void> {
    const fallback = firstUserContent.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat'
    let title = ''
    try {
      const apiKey = await deps.getApiKey(providerId)
      const ctx: Context = {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: firstUserContent.slice(0, 2000), timestamp: Date.now() }]
      }
      // 64 maxTokens: reasoning models may spend a few tokens before the answer.
      const result = await streamFn(model, ctx, { apiKey, maxTokens: 64 }).result()
      if (result.stopReason === 'stop' || result.stopReason === 'length') {
        title = textOf(result).replace(/^["'\s]+|["'.\s]+$/g, '').slice(0, 60)
      }
    } catch {
      // offline / auth hiccup → heuristic fallback below
    }
    deps.chats.updateTitle(chatId, title || fallback)
  }

  return {
    async runTurn(input: { chatId: string; requestId: string; content: string; chips: ContextChip[] }): Promise<void> {
      const { chatId, requestId, content, chips } = input
      const turnId = uuidv7()
      const emit = (ev: ChatEvent): void => deps.emit(chatId, requestId, ev)

      if (active.has(chatId)) {
        emit({ type: 'error', turnId, code: 'unknown', message: 'A turn is already running in this chat.' })
        return
      }
      const controller = new AbortController()
      active.set(chatId, controller)
      const undo: UndoRecord = { snapshots: [], createdNoteIds: [] }
      const usage = { input: 0, output: 0, costUsd: 0 }

      emit({ type: 'turn_start', turnId })
      try {
        const chat = deps.chats.get(chatId)
        if (!chat?.providerId || !chat.modelId) throw new Error('chat has no model locked')
        const model = deps.resolveModel(chat.providerId, chat.modelId)
        if (!model) throw new Error(`model ${chat.providerId}/${chat.modelId} is not available`)

        const prior = deps.chats.messages(chatId).map((m) => m.content as Message)
        const isFirstTurn = prior.length === 0
        const messages: Message[] = [...prior]

        const persistUser = (text: string): void => {
          const msg: UserMessage = { role: 'user', content: text, timestamp: Date.now() }
          deps.chats.appendMessage(chatId, 'user', msg)
          messages.push(msg)
        }

        // Context injection: chips when attached; otherwise turn-1 implicit RAG
        // (rag applies its own guards: ≥5 live notes, sanitizable query, score floor).
        if (chips.length > 0) {
          const chipCtx = buildChipsContext(chips)
          if (chipCtx) persistUser(chipCtx)
        } else if (isFirstTurn) {
          const ragCtx = await deps.rag.buildContext(content)
          if (ragCtx) persistUser(ragCtx)
        }
        persistUser(content)

        const systemPrompt = buildSystemPrompt({
          chatInstructions: deps.settings.get<string>('ai.chatInstructions')
        })

        let final: { message: AssistantMessage; messageId: string } | null = null

        for (let iteration = 0; iteration < MAX_ITERATIONS && final === null; iteration++) {
          // Hard 80% pre-check BEFORE sending (deliberate cut: no eliding).
          if (estimateTokens(systemPrompt, messages) > CONTEXT_BUDGET * model.contextWindow) {
            emit({
              type: 'error',
              turnId,
              code: 'context_too_long',
              message: 'This conversation no longer fits the model\'s context window — start a new chat.'
            })
            return
          }

          const apiKey = await deps.getApiKey(chat.providerId)
          const s = streamFn(model, { systemPrompt, messages, tools: AGENT_TOOLS }, { apiKey, signal: controller.signal })
          for await (const ev of s) {
            // Relay only when the consumer isn't gone: a cancelled turn stops emitting deltas.
            if (controller.signal.aborted) continue
            if (ev.type === 'text_delta') emit({ type: 'text_delta', turnId, delta: ev.delta })
            else if (ev.type === 'thinking_delta') emit({ type: 'thinking', turnId, delta: ev.delta })
          }
          const result = await s.result()
          usage.input += result.usage.input
          usage.output += result.usage.output
          usage.costUsd += result.usage.cost.total

          if (result.stopReason === 'aborted' || controller.signal.aborted) {
            emit({ type: 'error', turnId, code: 'cancelled', message: 'Cancelled.' })
            return
          }
          if (result.stopReason === 'error') {
            const message = result.errorMessage ?? 'The model request failed.'
            if (isContextOverflow(result, model.contextWindow)) {
              emit({ type: 'error', turnId, code: 'context_too_long', message: 'This conversation no longer fits the model\'s context window — start a new chat.' })
            } else {
              emit({ type: 'error', turnId, ...classifyError(message), message })
            }
            return
          }

          const row = deps.chats.appendMessage(chatId, 'assistant', result)
          messages.push(result)

          const toolCalls = result.content.filter((c): c is ToolCall => c.type === 'toolCall')
          if (toolCalls.length === 0) {
            final = { message: result, messageId: row.id }
            break
          }
          const answered = new Set<string>()
          for (const call of toolCalls) {
            if (controller.signal.aborted) break
            emit({ type: 'tool_start', turnId, callId: call.id, name: call.name, label: toolLabel(call) })
            const outcome = await executeTool(call, deps.services, undo)
            const toolMsg: ToolResultMessage = {
              role: 'toolResult',
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: 'text', text: JSON.stringify(outcome.json) }],
              isError: outcome.isError,
              timestamp: Date.now()
            }
            deps.chats.appendMessage(chatId, 'toolResult', toolMsg)
            messages.push(toolMsg)
            answered.add(call.id)
            emit({ type: 'tool_end', turnId, callId: call.id, ok: !outcome.isError, summary: outcome.summary })
          }
          if (controller.signal.aborted) {
            // The assistant message with its toolCalls is already persisted. Every
            // unexecuted call needs a synthetic toolResult — a dangling toolCall
            // makes the provider reject EVERY later send in this chat.
            for (const call of toolCalls) {
              if (answered.has(call.id)) continue
              const cancelled: ToolResultMessage = {
                role: 'toolResult',
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: 'text', text: 'cancelled by user' }],
                isError: true,
                timestamp: Date.now()
              }
              deps.chats.appendMessage(chatId, 'toolResult', cancelled)
            }
            emit({ type: 'error', turnId, code: 'cancelled', message: 'Cancelled.' })
            return
          }
        }

        if (final === null) {
          emit({
            type: 'error',
            turnId,
            code: 'unknown',
            message: `Stopped after ${MAX_ITERATIONS} tool rounds without a final answer — ask again to continue.`
          })
          return
        }

        let undoToken: string | undefined
        if (undo.snapshots.length > 0 || undo.createdNoteIds.length > 0) {
          undoToken = uuidv7()
          undoStore.set(undoToken, undo)
          while (undoStore.size > MAX_UNDO_RECORDS) {
            const oldest = undoStore.keys().next().value
            if (oldest === undefined) break
            undoStore.delete(oldest)
          }
        }
        emit({ type: 'turn_end', turnId, messageId: final.messageId, usage, undoToken })

        if (isFirstTurn) void generateTitle(chatId, model, chat.providerId, content)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (controller.signal.aborted) {
          emit({ type: 'error', turnId, code: 'cancelled', message: 'Cancelled.' })
        } else if (err instanceof AuthRequiredError) {
          emit({ type: 'error', turnId, code: 'auth_expired', message })
        } else {
          emit({ type: 'error', turnId, ...classifyError(message), message })
        }
      } finally {
        active.delete(chatId)
      }
    },

    /** chat:cancel — aborts the in-flight pi-ai stream (StreamOptions.signal) and the tool loop. */
    cancel(chatId: string): void {
      active.get(chatId)?.abort()
    },

    /**
     * ai:undo — restore ai_edit snapshots in reverse order, trash created notes.
     * (add_to_collection memberships are not undone — spec'd scope.)
     */
    undo(undoToken: string): void {
      const rec = undoStore.get(undoToken)
      if (!rec) throw new Error('Nothing to undo — the undo window has passed.')
      undoStore.delete(undoToken)
      const restored: string[] = []
      for (const { noteId, versionId } of [...rec.snapshots].reverse()) {
        const v = deps.services.versions.get(versionId)
        const note = deps.services.notes.get(noteId)
        if (!v || !note) continue
        if (note.trashedAt !== null) continue // user trashed it since — do not silently untrash
        // Snapshot the CURRENT state before clobbering it (mirror versions:restore's
        // pre_restore): post-turn user edits stay recoverable from version history.
        deps.services.versions.snapshot(note, 'pre_restore')
        deps.services.notes.update(noteId, { title: v.title, contentMd: v.contentMd })
        deps.services.indexer.enqueue(noteId)
        restored.push(noteId)
      }
      const trashed: string[] = []
      for (const id of rec.createdNoteIds) {
        const note = deps.services.notes.get(id)
        if (!note || note.trashedAt !== null) continue
        deps.services.notes.trash(id)
        trashed.push(id)
      }
      if (restored.length > 0) deps.services.emitDataChanged({ entity: 'note', ids: restored, op: 'update', origin: 'ai' })
      if (trashed.length > 0) deps.services.emitDataChanged({ entity: 'note', ids: trashed, op: 'trash', origin: 'ai' })
    }
  }
}

export type Agent = ReturnType<typeof createAgent>
