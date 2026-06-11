import { create } from 'zustand'
import type { ChatMeta, ContextChip, ModelChoice } from '@shared/types'
import type { IpcPushMap } from '@shared/ipc'
import { invoke, on } from '../api'
import { getActiveContent } from './tabs'
import { toast } from './ui'

/**
 * Chat store: render-model of the active conversation + the chat:event stream.
 * Text/thinking deltas are buffered and committed on requestAnimationFrame so a
 * fast token stream costs one React commit per frame, not one per token.
 */
export type ChatItem =
  | { kind: 'user'; key: number; text: string }
  | { kind: 'assistant'; key: number; messageId?: string; text: string; thinking: string; streaming: boolean }
  | { kind: 'tool'; key: number; callId: string; name: string; label: string; status: 'running' | 'ok' | 'error'; summary?: string }

export type Chip = ContextChip & { label: string }

const MUTATING_TOOLS = new Set(['create_note', 'update_note', 'add_to_collection'])
/** Injected user-side context messages (RAG / chips) — persisted but never shown as bubbles. */
const HIDDEN_USER_PREFIXES = ['<workspace_context', '<attached_context']

let nextKey = 1
const key = (): number => nextKey++

interface ChatState {
  chats: ChatMeta[]
  listOpen: boolean
  activeChatId: string | null
  items: ChatItem[]
  chips: Chip[]
  modelChoices: ModelChoice[]
  model: { providerId: string; modelId: string } | null
  modelLocked: boolean
  streaming: boolean
  requestId: string | null
  /** cancelled is silent; other codes render inline (auth_expired gets the Reconnect banner). */
  error: { code: string; message: string } | null
  undoToken: string | null
  /**
   * The open note's auto-attached chip was dismissed for THIS conversation
   * (mem-parity, v1.1). Reset whenever the conversation switches.
   */
  activeChipDismissed: boolean

  refreshChats: () => Promise<void>
  refreshModels: () => Promise<void>
  setListOpen: (open: boolean) => void
  newChat: () => void
  openChat: (chatId: string) => Promise<void>
  deleteChat: (chatId: string) => Promise<void>
  setModel: (model: { providerId: string; modelId: string }) => void
  addChip: (chip: Chip) => void
  removeChip: (chip: ContextChip) => void
  dismissActiveChip: () => void
  send: (content: string) => Promise<void>
  cancel: () => void
  undo: () => Promise<void>
  dismissUndo: () => void
  saveAsNote: (messageId: string) => Promise<void>
}

// ── rAF-batched streaming buffer (module-level — not React state) ─────────────
const buf = { text: '', thinking: '' }
let rafId: number | null = null

function flushBuffer(): void {
  rafId = null
  if (!buf.text && !buf.thinking) return
  const { text, thinking } = buf
  buf.text = ''
  buf.thinking = ''
  useChatStore.setState((s) => {
    const items = [...s.items]
    let last = items[items.length - 1]
    if (!last || last.kind !== 'assistant' || !last.streaming) {
      // New assistant segment (first delta, or text resuming after tool cards).
      last = { kind: 'assistant', key: key(), text: '', thinking: '', streaming: true }
      items.push(last)
    }
    items[items.length - 1] = {
      ...last,
      text: last.text + text,
      thinking: last.thinking + thinking
    }
    return { items }
  })
}

function scheduleFlush(): void {
  if (rafId === null) rafId = requestAnimationFrame(flushBuffer)
}

function flushNow(): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  flushBuffer()
}

// Mutating tool calls seen during the current turn — drives the undo toast.
let turnMutated = false
// Which note's content was last FULL-attached in the CURRENT conversation
// (v1.1): while {noteId, updatedAt} still match at send time, the active-note
// chip goes out light (main skips content re-injection; the "currently
// viewing" system line still applies). A note edit bumps updatedAt → the next
// send re-attaches the full content once. Reset on new/open chat — a reopened
// conversation conservatively re-attaches (the persisted transcript does not
// carry the updatedAt its old attachment was based on).
let lastContentAttached: { noteId: string; updatedAt: number } | null = null
// Events that raced ahead of the chat:send invoke result (push vs invoke ordering
// is not guaranteed) — replayed once the requestId is known.
let sendInFlight = false
let pendingEvents: IpcPushMap['chat:event'][] = []

function handleChatEvent(payload: IpcPushMap['chat:event']): void {
  const s = useChatStore.getState()
  if (s.requestId !== payload.requestId) {
    if (sendInFlight) pendingEvents.push(payload)
    return
  }
  const ev = payload.ev
  switch (ev.type) {
    case 'turn_start':
      turnMutated = false
      break
    case 'text_delta':
      buf.text += ev.delta
      scheduleFlush()
      break
    case 'thinking':
      buf.thinking += ev.delta
      scheduleFlush()
      break
    case 'tool_start': {
      flushNow()
      if (MUTATING_TOOLS.has(ev.name)) turnMutated = true
      useChatStore.setState((st) => {
        const items = st.items.map((it) =>
          it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it
        )
        return {
          items: [
            ...items,
            { kind: 'tool', key: key(), callId: ev.callId, name: ev.name, label: ev.label, status: 'running' } as ChatItem
          ]
        }
      })
      break
    }
    case 'tool_end':
      useChatStore.setState((st) => ({
        items: st.items.map((it) =>
          it.kind === 'tool' && it.callId === ev.callId
            ? { ...it, status: ev.ok ? 'ok' : 'error', summary: ev.summary }
            : it
        )
      }))
      break
    case 'turn_end': {
      flushNow()
      useChatStore.setState((st) => ({
        items: st.items.map((it, i) =>
          it.kind === 'assistant' && i === st.items.length - 1
            ? { ...it, streaming: false, messageId: ev.messageId }
            : it.kind === 'assistant'
              ? { ...it, streaming: false }
              : it
        ),
        streaming: false,
        undoToken: ev.undoToken && turnMutated ? ev.undoToken : st.undoToken
      }))
      // Title generation is async after turn_end — refresh now and once more shortly.
      void s.refreshChats()
      setTimeout(() => void useChatStore.getState().refreshChats(), 4000)
      break
    }
    case 'error': {
      flushNow()
      useChatStore.setState((st) => ({
        items: st.items.map((it) => (it.kind === 'assistant' ? { ...it, streaming: false } : it)),
        streaming: false,
        error: ev.code === 'cancelled' ? null : { code: ev.code, message: ev.message }
      }))
      break
    }
  }
}

let eventsInited = false
/** Call once from App (StrictMode-guarded) — events must flow even while the panel is closed. */
export function initChatEvents(): void {
  if (eventsInited) return
  eventsInited = true
  on('chat:event', handleChatEvent)
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('')
  }
  return null
}

export const useChatStore = create<ChatState>((set, get) => ({
  chats: [],
  listOpen: false,
  activeChatId: null,
  items: [],
  chips: [],
  modelChoices: [],
  model: null,
  modelLocked: false,
  streaming: false,
  requestId: null,
  error: null,
  undoToken: null,
  activeChipDismissed: false,

  async refreshChats() {
    set({ chats: await invoke('chats:list') })
  },

  async refreshModels() {
    const choices = await invoke('ai:models')
    set((s) => {
      let model = s.model
      if (!model || !choices.some((c) => c.providerId === model!.providerId && c.modelId === model!.modelId)) {
        model = null
      }
      if (!model && !s.modelLocked && choices[0]) {
        model = { providerId: choices[0].providerId, modelId: choices[0].modelId }
      }
      return { modelChoices: choices, model }
    })
    // Prefer the settings default when nothing is locked in yet.
    if (!get().modelLocked) {
      try {
        const pinned = (await invoke('settings:get', { key: 'ai.defaultModel' })) as
          | { providerId?: string; modelId?: string }
          | null
        if (
          pinned?.providerId &&
          pinned.modelId &&
          get().modelChoices.some((c) => c.providerId === pinned.providerId && c.modelId === pinned.modelId)
        ) {
          set({ model: { providerId: pinned.providerId, modelId: pinned.modelId } })
        }
      } catch {
        /* defaults are best-effort */
      }
    }
  },

  setListOpen(open) {
    set({ listOpen: open })
    if (open) void get().refreshChats()
  },

  newChat() {
    flushNow()
    lastContentAttached = null
    set({
      activeChatId: null,
      items: [],
      chips: [],
      modelLocked: false,
      streaming: false,
      requestId: null,
      error: null,
      undoToken: null,
      activeChipDismissed: false,
      listOpen: false
    })
    void get().refreshModels()
  },

  async openChat(chatId) {
    // Reopening the chat that is streaming RIGHT NOW must not rebuild from the
    // DB — that would null requestId and drop the turn's remaining events
    // (turn_end/undoToken). Keep the live stream state and just show it.
    if (get().streaming && get().activeChatId === chatId) {
      set({ listOpen: false })
      return
    }
    const { chat, messages } = await invoke('chats:get', { chatId })
    lastContentAttached = null
    const items: ChatItem[] = []
    const toolItems = new Map<string, ChatItem & { kind: 'tool' }>()
    for (const raw of messages as { id: string; role: string; content: unknown }[]) {
      if (raw.role === 'user') {
        const text = userText((raw.content as { content?: unknown })?.content)
        if (text === null || HIDDEN_USER_PREFIXES.some((p) => text.startsWith(p))) continue
        items.push({ kind: 'user', key: key(), text })
      } else if (raw.role === 'assistant') {
        const content = ((raw.content as { content?: { type: string }[] })?.content ?? []) as {
          type: string
          text?: string
          thinking?: string
          id?: string
          name?: string
          arguments?: Record<string, unknown>
        }[]
        const text = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
        const thinking = content.filter((c) => c.type === 'thinking').map((c) => c.thinking ?? '').join('')
        if (text || thinking) {
          items.push({ kind: 'assistant', key: key(), messageId: raw.id, text, thinking, streaming: false })
        }
        for (const c of content) {
          if (c.type !== 'toolCall' || !c.id || !c.name) continue
          const item: ChatItem & { kind: 'tool' } = {
            kind: 'tool',
            key: key(),
            callId: c.id,
            name: c.name,
            label: c.name.replace(/_/g, ' '),
            status: 'ok'
          }
          toolItems.set(c.id, item)
          items.push(item)
        }
      } else if (raw.role === 'toolResult') {
        const tr = raw.content as { toolCallId?: string; isError?: boolean }
        const item = tr.toolCallId ? toolItems.get(tr.toolCallId) : undefined
        if (item) item.status = tr.isError ? 'error' : 'ok'
      }
    }
    set({
      activeChatId: chatId,
      items,
      chips: [],
      model: chat.providerId && chat.modelId ? { providerId: chat.providerId, modelId: chat.modelId } : null,
      modelLocked: true,
      streaming: false,
      requestId: null,
      error: null,
      undoToken: null,
      activeChipDismissed: false,
      listOpen: false
    })
  },

  async deleteChat(chatId) {
    await invoke('chats:delete', { chatId })
    if (get().activeChatId === chatId) get().newChat()
    await get().refreshChats()
  },

  setModel(model) {
    if (!get().modelLocked) set({ model })
  },

  addChip(chip) {
    set((s) =>
      s.chips.some((c) => c.type === chip.type && c.id === chip.id) ? s : { chips: [...s.chips, chip] }
    )
  },

  removeChip(chip) {
    set((s) => ({ chips: s.chips.filter((c) => !(c.type === chip.type && c.id === chip.id)) }))
  },

  dismissActiveChip() {
    set({ activeChipDismissed: true })
  },

  async send(content) {
    const s = get()
    if (s.streaming || !content.trim()) return
    if (!s.model) {
      toast('Connect an AI provider in Settings first')
      return
    }
    set({
      items: [...s.items, { kind: 'user', key: key(), text: content }],
      streaming: true,
      error: null,
      undoToken: null
    })
    sendInFlight = true
    pendingEvents = []
    // Auto-attach the note open in the focused pane (mem-parity, v1.1): sent as
    // a regular note chip with active=true so main can add the "currently
    // viewing" system-prompt line. A manually attached chip for the same note
    // takes its place; dismissal (per conversation) suppresses the auto chip.
    const activeContent = getActiveContent()
    const activeNoteId = activeContent?.kind === 'note' ? activeContent.noteId : null
    // Re-injecting the full note EVERY turn bloats tokens and persists duplicate
    // <attached_context> messages — when this conversation already attached this
    // note's content and the note is unchanged since, send the chip light.
    // updatedAt comes straight from main (the notes-store cache can lag).
    const willAttachActive =
      activeNoteId !== null &&
      (!s.activeChipDismissed || s.chips.some((c) => c.type === 'note' && c.id === activeNoteId))
    let activeUpdatedAt: number | null = null
    if (activeNoteId !== null && willAttachActive) {
      try {
        activeUpdatedAt = (await invoke('notes:get', { id: activeNoteId })).updatedAt
      } catch {
        // Note gone (trashed/deleted) — main's buildChipsContext drops the chip anyway.
      }
    }
    const light =
      activeUpdatedAt !== null &&
      lastContentAttached?.noteId === activeNoteId &&
      lastContentAttached.updatedAt === activeUpdatedAt
    const contextChips: ContextChip[] = s.chips.map((c) =>
      c.type === 'note' && c.id === activeNoteId
        ? { type: c.type, id: c.id, active: true, ...(light && { light: true }) }
        : { type: c.type, id: c.id }
    )
    if (activeNoteId && !s.activeChipDismissed && !contextChips.some((c) => c.type === 'note' && c.id === activeNoteId)) {
      contextChips.unshift({ type: 'note', id: activeNoteId, active: true, ...(light && { light: true }) })
    }
    try {
      const res = await invoke('chat:send', {
        chatId: s.activeChatId ?? undefined,
        content,
        contextChips,
        model: s.model
      })
      if (
        activeNoteId !== null &&
        activeUpdatedAt !== null &&
        contextChips.some((c) => c.type === 'note' && c.id === activeNoteId)
      ) {
        lastContentAttached = { noteId: activeNoteId, updatedAt: activeUpdatedAt }
      }
      set({ activeChatId: res.chatId, requestId: res.requestId, modelLocked: true, chips: [] })
      const queued = pendingEvents
      pendingEvents = []
      sendInFlight = false
      for (const ev of queued) handleChatEvent(ev)
    } catch (err) {
      sendInFlight = false
      pendingEvents = []
      set({ streaming: false, error: { code: 'unknown', message: err instanceof Error ? err.message : String(err) } })
    }
  },

  cancel() {
    const chatId = get().activeChatId
    if (chatId) void invoke('chat:cancel', { chatId })
  },

  async undo() {
    const token = get().undoToken
    if (!token) return
    set({ undoToken: null })
    try {
      await invoke('ai:undo', { undoToken: token })
      toast('Chat edits undone')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Undo failed')
    }
  },

  dismissUndo() {
    set({ undoToken: null })
  },

  async saveAsNote(messageId) {
    const chatId = get().activeChatId
    if (!chatId) return
    try {
      await invoke('chat:saveAsNote', { chatId, messageId })
      toast('Saved as note')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save as note')
    }
  }
}))
