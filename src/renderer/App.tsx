import { useCallback, useEffect, useRef, useState } from 'react'
import type { Note, NoteListItem } from '@shared/types'
import { invoke, on } from './api'

/**
 * M1 THROWAWAY UI: a bare notes list + textarea editor proving the data spine end-to-end
 * (CRUD over real IPC, data:changed invalidation, trash/restore, restart persistence).
 * Replaced wholesale by the real shell + TipTap editor in M2.
 */
export default function App(): React.JSX.Element {
  const [items, setItems] = useState<NoteListItem[]>([])
  const [trashCount, setTrashCount] = useState(0)
  const [scope, setScope] = useState<'all' | 'trash'>('all')
  const [open, setOpen] = useState<Note | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const live = await invoke('notes:list', { scope })
    setItems(live.items)
    const trash = await invoke('notes:list', { scope: 'trash', limit: 1 })
    setTrashCount(trash.total)
  }, [scope])

  useEffect(() => {
    void refresh()
    return on('data:changed', () => void refresh())
  }, [refresh])

  async function createNote(): Promise<void> {
    const note = await invoke('notes:create', { title: '', contentMd: '' })
    setOpen(note)
  }

  async function openNote(id: string): Promise<void> {
    setOpen(await invoke('notes:get', { id }))
  }

  function scheduleSave(next: Note): void {
    setOpen(next)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void invoke('notes:update', {
        id: next.id,
        patch: { title: next.title, contentMd: next.contentMd }
      })
    }, 800)
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col bg-transparent">
        <div className="titlebar-drag h-13 shrink-0" />
        <div className="flex items-center gap-2 px-3 pb-2">
          <button
            onClick={() => void createNote()}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
          >
            New note
          </button>
          <button
            onClick={() => setScope(scope === 'all' ? 'trash' : 'all')}
            className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5"
          >
            {scope === 'all' ? `Trash (${trashCount})` : '← Notes'}
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 text-[13px]">
          {items.map((n) => (
            <div
              key={n.id}
              onClick={() => void openNote(n.id)}
              className={`group cursor-default rounded-md px-2.5 py-1.5 ${open?.id === n.id ? 'bg-black/10' : 'hover:bg-black/5'}`}
            >
              <div className="truncate font-medium">{n.title || 'Untitled'}</div>
              <div className="flex items-center justify-between">
                <span className="truncate text-[11px] text-ink-muted">{n.excerpt || '—'}</span>
                {scope === 'all' ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (open?.id === n.id) setOpen(null)
                      void invoke('notes:trash', { id: n.id })
                    }}
                    className="hidden text-[11px] text-ink-muted hover:text-red-600 group-hover:block"
                  >
                    ✕
                  </button>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void invoke('notes:restore', { id: n.id })
                    }}
                    className="hidden text-[11px] text-accent group-hover:block"
                  >
                    restore
                  </button>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="px-2.5 py-4 text-[12px] text-ink-muted">
              {scope === 'all' ? 'No notes yet — create one, or press ⌃⌘Space.' : 'Trash is empty.'}
            </div>
          )}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm">
        <div className="titlebar-drag h-13 shrink-0 border-b border-hairline" />
        {open ? (
          <div className="flex flex-1 flex-col overflow-y-auto px-10 py-6">
            <input
              value={open.title}
              onChange={(e) => scheduleSave({ ...open, title: e.target.value })}
              placeholder="Untitled"
              className="bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-ink-muted/40"
            />
            <textarea
              value={open.contentMd}
              onChange={(e) => scheduleSave({ ...open, contentMd: e.target.value })}
              placeholder="Write something… (markdown; the real editor lands in M2)"
              className="mt-4 flex-1 resize-none bg-transparent text-[15px] leading-relaxed outline-none"
              style={{ userSelect: 'text', cursor: 'text' }}
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-sm text-center text-sm text-ink-muted">
              Select or create a note. This throwaway UI proves the M1 data spine; the real
              editor, tabs and search arrive in M2–M3.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
