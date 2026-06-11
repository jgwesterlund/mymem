import { useEffect, useRef, useState } from 'react'
import { invoke } from '../api'
import { useChatStore, type ChatItem, type Chip } from '../stores/chat'
import { useCollectionsStore } from '../stores/collections'
import { useNotesStore } from '../stores/notes'
import { useTabsStore, selectActiveContent } from '../stores/tabs'
import { useUiStore } from '../stores/ui'
import { ModelPicker } from '../shell/ModelPicker'
import { ChatMarkdown } from './ChatMarkdown'

/**
 * Chat tab of the right panel (M7): conversation list, streaming message view
 * (markdown + mymem:// citation chips + thinking disclosure + tool cards),
 * context chips, model picker (locked after the first send), cancel, undo
 * toast and save-as-note.
 */

function Thinking({ text }: { text: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!text) return null
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] font-medium text-ink-muted hover:text-ink"
      >
        {open ? '▾' : '▸'} Thinking…
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-hover px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink-muted">
          {text}
        </pre>
      )}
    </div>
  )
}

function ToolCard({ item }: { item: ChatItem & { kind: 'tool' } }): React.JSX.Element {
  return (
    <div
      className={`my-1 flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] ${
        item.status === 'error' ? 'border-[#b0524a]/40 text-[#b0524a] dark:border-[#c97a72]/40 dark:text-[#c97a72]' : 'border-hairline text-ink-muted'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          item.status === 'running' ? 'animate-pulse bg-accent' : item.status === 'ok' ? 'bg-[#6f8472]' : 'bg-[#b0524a]'
        }`}
      />
      <span className="truncate">{item.summary ?? item.label}</span>
    </div>
  )
}

function Message({ item }: { item: ChatItem }): React.JSX.Element | null {
  if (item.kind === 'tool') return <ToolCard item={item} />
  if (item.kind === 'user') {
    return (
      <div className="my-1.5 flex justify-end">
        <div className="max-w-[88%] select-text whitespace-pre-wrap rounded-xl rounded-br-sm bg-accent/10 px-3 py-1.5 text-[13px]">
          {item.text}
        </div>
      </div>
    )
  }
  return (
    <div className="group my-1.5">
      <Thinking text={item.thinking} />
      {item.text && (
        <div className="chat-markdown select-text text-[13px] leading-relaxed">
          <ChatMarkdown text={item.text} />
        </div>
      )}
      {item.streaming && <span className="inline-block h-3.5 w-0.5 animate-pulse bg-accent align-middle" />}
      {!item.streaming && item.messageId && item.text && (
        <button
          onClick={() => void useChatStore.getState().saveAsNote(item.messageId!)}
          className="mt-0.5 hidden text-[11px] text-ink-muted hover:text-ink group-hover:block"
        >
          Save as note
        </button>
      )}
    </div>
  )
}

function ConversationList(): React.JSX.Element {
  const chats = useChatStore((s) => s.chats)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
      {chats.length === 0 && (
        <p className="px-3 py-6 text-center text-[12px] text-ink-muted">No conversations yet.</p>
      )}
      {chats.map((c) => (
        <div
          key={c.id}
          onClick={() => void useChatStore.getState().openChat(c.id)}
          className="group flex cursor-default items-center justify-between rounded-md px-2.5 py-1.5 hover:bg-hover"
        >
          <div className="min-w-0">
            <div className="truncate text-[13px]">{c.title || 'New chat'}</div>
            <div className="text-[11px] text-ink-muted">{new Date(c.updatedAt).toLocaleDateString()}</div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              void useChatStore.getState().deleteChat(c.id)
            }}
            className="hidden shrink-0 rounded px-1.5 text-[11px] text-ink-muted hover:bg-active group-hover:block"
            title="Delete conversation"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function ChipPicker({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const [notes, setNotes] = useState<{ noteId: string; title: string }[]>([])
  const collections = useCollectionsStore((s) => s.items)
  const seq = useRef(0)

  useEffect(() => {
    const mySeq = ++seq.current
    const t = setTimeout(() => {
      void invoke('search:typeahead', { q }).then((rows) => {
        if (seq.current === mySeq) setNotes(rows)
      })
    }, 120)
    return () => clearTimeout(t)
  }, [q])

  const matchingCollections = collections.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 5)
  const add = (chip: Chip): void => {
    useChatStore.getState().addChip(chip)
    onClose()
  }

  return (
    <div className="absolute bottom-full left-0 z-20 mb-1 w-72 overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        placeholder="Attach a note or collection…"
        className="w-full border-b border-hairline bg-transparent px-3 py-2 text-[12px] outline-none"
      />
      <div className="max-h-56 overflow-y-auto p-1">
        {notes.slice(0, 6).map((n) => (
          <button
            key={n.noteId}
            onClick={() => add({ type: 'note', id: n.noteId, label: n.title || 'Untitled' })}
            className="block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-hover"
          >
            📄 {n.title || 'Untitled'}
          </button>
        ))}
        {matchingCollections.map((c) => (
          <button
            key={c.id}
            onClick={() => add({ type: 'collection', id: c.id, label: c.name })}
            className="block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-hover"
          >
            🗂 {c.name}
          </button>
        ))}
        {notes.length === 0 && matchingCollections.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-ink-muted">No matches.</p>
        )}
      </div>
    </div>
  )
}

// Titles resolved via notes:get for notes the 500-item notes-store cache missed
// (module-level so a re-render / panel toggle never re-fetches the same note).
const noteTitleFallbacks = new Map<string, string>()

function Composer(): React.JSX.Element {
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const chips = useChatStore((s) => s.chips)
  const streaming = useChatStore((s) => s.streaming)
  const model = useChatStore((s) => s.model)
  const modelLocked = useChatStore((s) => s.modelLocked)
  const modelChoices = useChatStore((s) => s.modelChoices)
  const activeChipDismissed = useChatStore((s) => s.activeChipDismissed)
  // Auto-attached chip for the note open in the focused pane (mem-parity, v1.1):
  // send() recomputes the same selector — this renders what will be sent.
  const activeContent = useTabsStore(selectActiveContent)
  const activeNoteId = activeContent?.kind === 'note' ? activeContent.noteId : null
  // undefined = cache miss (the store holds only the newest 500 notes) — fall
  // back to one notes:get instead of mislabeling the chip 'Untitled'.
  const cachedNoteTitle = useNotesStore((s) => {
    if (!activeNoteId) return null
    const n = s.items.find((x) => x.id === activeNoteId)
    return n ? n.title || 'Untitled' : undefined
  })
  const [fetchedTitle, setFetchedTitle] = useState<string | null>(null)
  const cacheMiss = activeNoteId !== null && cachedNoteTitle === undefined
  useEffect(() => {
    setFetchedTitle(null)
    if (!cacheMiss || !activeNoteId) return
    const hit = noteTitleFallbacks.get(activeNoteId)
    if (hit !== undefined) {
      setFetchedTitle(hit)
      return
    }
    let alive = true
    void invoke('notes:get', { id: activeNoteId })
      .then((n) => {
        const title = n.title || 'Untitled'
        noteTitleFallbacks.set(activeNoteId, title)
        if (alive) setFetchedTitle(title)
      })
      .catch(() => {
        // Note gone — the chip disappears with the pane content shortly anyway.
      })
    return () => {
      alive = false
    }
  }, [activeNoteId, cacheMiss])
  const activeNoteTitle = activeNoteId ? cachedNoteTitle ?? fetchedTitle ?? 'Untitled' : null
  const showActiveChip =
    activeNoteId !== null &&
    !activeChipDismissed &&
    !chips.some((c) => c.type === 'note' && c.id === activeNoteId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function submit(): void {
    const content = text.trim()
    if (!content || streaming) return
    setText('')
    void useChatStore.getState().send(content)
  }

  const currentLabel =
    modelChoices.find((c) => c.providerId === model?.providerId && c.modelId === model?.modelId)?.label ??
    (model ? `${model.providerId} · ${model.modelId}` : 'No model')

  return (
    <div className="shrink-0 border-t border-hairline p-2">
      <div className="relative flex flex-wrap items-center gap-1 pb-1">
        {showActiveChip && (
          <span
            title="The note you're viewing — attached automatically. Remove to leave it out of this conversation."
            className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px]"
          >
            📄 <span className="max-w-32 truncate">{activeNoteTitle}</span>
            <button
              onClick={() => useChatStore.getState().dismissActiveChip()}
              className="text-ink-muted hover:text-ink"
            >
              ✕
            </button>
          </span>
        )}
        {chips.map((chip) => (
          <span
            key={`${chip.type}:${chip.id}`}
            className="flex items-center gap-1 rounded-full border border-hairline bg-surface-dim px-2 py-0.5 text-[11px]"
          >
            {chip.type === 'note' ? '📄' : '🗂'} <span className="max-w-32 truncate">{chip.label}</span>
            <button onClick={() => useChatStore.getState().removeChip(chip)} className="text-ink-muted hover:text-ink">
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={() => setPickerOpen((o) => !o)}
          title="Attach context"
          className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-muted hover:bg-hover"
        >
          + context
        </button>
        {pickerOpen && <ChipPicker onClose={() => setPickerOpen(false)} />}
      </div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // mem-parity: Enter sends, Shift+Enter inserts a newline.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        placeholder="Ask — or tell me to create or edit notes…"
        className="w-full resize-none rounded-lg border border-hairline bg-surface-dim px-2.5 py-1.5 text-[13px] outline-none focus:border-accent/50"
        style={{ userSelect: 'text' }}
      />
      <div className="flex items-center justify-between pt-1">
        {modelLocked ? (
          <span
            className="max-w-44 truncate text-[11px] text-ink-muted"
            title="The model is locked once a conversation has messages — start a new chat to switch."
          >
            {currentLabel}
          </span>
        ) : (
          <ModelPicker
            choices={modelChoices}
            value={model}
            noneLabel="No model"
            direction="up"
            triggerClassName="flex max-w-44 items-center gap-1 rounded border border-hairline bg-surface px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-hover"
            onChange={(m) => {
              if (m) useChatStore.getState().setModel(m)
            }}
          />
        )}
        {streaming ? (
          <button
            onClick={() => useChatStore.getState().cancel()}
            className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            Send ↩
          </button>
        )}
      </div>
    </div>
  )
}

export function ChatPanel(): React.JSX.Element {
  const listOpen = useChatStore((s) => s.listOpen)
  const items = useChatStore((s) => s.items)
  const error = useChatStore((s) => s.error)
  const undoToken = useChatStore((s) => s.undoToken)
  const modelChoices = useChatStore((s) => s.modelChoices)
  const chats = useChatStore((s) => s.chats)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    void useChatStore.getState().refreshModels()
    void useChatStore.getState().refreshChats()
  }, [])

  // Auto-scroll while streaming unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [items])

  const title = chats.find((c) => c.id === activeChatId)?.title ?? 'New chat'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline px-2 py-1.5">
        <button
          onClick={() => useChatStore.getState().setListOpen(!listOpen)}
          title="Conversations"
          className="rounded px-1.5 py-0.5 text-[12px] text-ink-muted hover:bg-hover"
        >
          ☰
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[12px] font-medium">
          {listOpen ? 'Conversations' : title || 'New chat'}
        </span>
        <button
          onClick={() => useChatStore.getState().newChat()}
          title="New chat"
          className="rounded px-1.5 py-0.5 text-[13px] text-ink-muted hover:bg-hover"
        >
          +
        </button>
      </div>

      {listOpen ? (
        <ConversationList />
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
          >
            {items.length === 0 &&
              (modelChoices.length === 0 ? (
                <div className="mt-8 rounded-lg border border-hairline bg-surface-dim px-4 py-3 text-center">
                  <p className="text-[13px] font-medium">Connect an AI provider</p>
                  <p className="mt-1 text-[12px] text-ink-muted">
                    Sign in with your ChatGPT or Claude subscription — or an API key — to chat with your notes.
                  </p>
                  <button
                    onClick={() => useUiStore.getState().setSettingsOpen(true)}
                    className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                  >
                    Open Settings
                  </button>
                </div>
              ) : (
                <div className="mt-8 text-center text-[12px] text-ink-muted">
                  <p>Ask anything about your notes. The first question pulls in relevant notes automatically.</p>
                  <p className="mt-2">
                    I can also create and edit notes — try “Save this as a note” or “Fix the headings in this note”.
                  </p>
                </div>
              ))}
            {items.map((item) => (
              <Message key={item.key} item={item} />
            ))}
            {error && error.code === 'auth_expired' && (
              <div className="my-2 rounded-md border border-[#a98e5f]/35 bg-[#a98e5f]/12 px-3 py-2 text-[12px] text-[#7a653f] dark:border-[#a98e5f]/35 dark:bg-[#a98e5f]/15 dark:text-[#cbb68a]">
                Your AI session expired.{' '}
                <button
                  onClick={() => useUiStore.getState().setSettingsOpen(true)}
                  className="font-medium underline"
                >
                  Reconnect
                </button>
              </div>
            )}
            {error && error.code !== 'auth_expired' && (
              <div className="my-2 rounded-md border border-[#b0524a]/35 bg-[#b0524a]/10 px-3 py-2 text-[12px] text-[#b0524a] dark:border-[#c97a72]/35 dark:bg-[#c97a72]/12 dark:text-[#c97a72]">
                {error.message}
              </div>
            )}
          </div>

          {undoToken && (
            <div className="mx-2 mb-1 flex items-center justify-between rounded-md border border-hairline bg-surface-dim px-2.5 py-1.5 text-[12px]">
              <span>Chat edited your notes</span>
              <span className="flex gap-2">
                <button onClick={() => void useChatStore.getState().undo()} className="font-medium text-accent">
                  Undo
                </button>
                <button onClick={() => useChatStore.getState().dismissUndo()} className="text-ink-muted">
                  ✕
                </button>
              </span>
            </div>
          )}
          <Composer />
        </>
      )}
    </div>
  )
}
