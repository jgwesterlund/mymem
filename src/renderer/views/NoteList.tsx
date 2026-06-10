import { useEffect, useState } from 'react'
import type { NoteListItem } from '@shared/types'
import { invoke } from '../api'
import { useTabsStore } from '../stores/tabs'

function isTextTarget(e: KeyboardEvent): boolean {
  const t = e.target
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  )
}

/**
 * Shared notes list (Home + Collection): click opens in the current tab
 * (pushing history), Cmd+click opens a new tab, j/k/Enter keyboard nav,
 * hover trash button. Only mounted in the active tab, so a window-level
 * keydown listener is safe.
 */
export function NoteList({ items, empty }: { items: NoteListItem[]; empty: string }): React.JSX.Element {
  const [sel, setSel] = useState(0)

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)))
  }, [items.length])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (isTextTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, items.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
      } else if (e.key === 'Enter') {
        const item = items[sel]
        if (item) {
          e.preventDefault()
          useTabsStore.getState().openInCurrentTab({ kind: 'note', noteId: item.id })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, sel])

  function open(item: NoteListItem, metaKey: boolean): void {
    const tabs = useTabsStore.getState()
    if (metaKey) tabs.openTab({ kind: 'note', noteId: item.id })
    else tabs.openInCurrentTab({ kind: 'note', noteId: item.id })
  }

  if (items.length === 0) {
    return <p className="px-1 py-6 text-[13px] text-ink-muted">{empty}</p>
  }

  return (
    <div className="flex flex-col">
      {items.map((n, i) => (
        <div
          key={n.id}
          onClick={(e) => open(n, e.metaKey)}
          onMouseEnter={() => setSel(i)}
          className={`group cursor-default rounded-lg px-3 py-2 ${i === sel ? 'bg-black/5' : ''}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[14px] font-medium">{n.title || 'Untitled'}</span>
            <span className="shrink-0 text-[11px] text-ink-muted">
              {new Date(n.updatedAt).toLocaleDateString()}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="truncate text-[12px] text-ink-muted">{n.excerpt || 'Empty note'}</span>
            <button
              title="Move to Trash"
              onClick={(e) => {
                e.stopPropagation()
                void invoke('notes:trash', { id: n.id })
              }}
              className="hidden shrink-0 text-[11px] text-ink-muted hover:text-red-600 group-hover:block"
            >
              Trash
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
