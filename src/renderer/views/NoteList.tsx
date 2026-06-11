import { useEffect, useState } from 'react'
import type { NoteListItem } from '@shared/types'
import { invoke } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { openContent } from '../stores/tabs'
import { toast } from '../stores/ui'

function isTextTarget(e: KeyboardEvent): boolean {
  const t = e.target
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  )
}

/**
 * Shared notes list (Home + Collection). App-wide modifier contract for both
 * click and Enter: plain = current pane (pushing history), ⌘ = new tab,
 * ⌥ = other pane (splitting if needed). j/k keyboard nav, hover trash button.
 * Only the ACTIVE tab mounts — but a split tab can mount two lists, so the
 * window-level keydown listener is gated on the pane's `focused` flag.
 */
export function NoteList({
  items,
  empty,
  focused = true
}: {
  items: NoteListItem[]
  empty: string
  focused?: boolean
}): React.JSX.Element {
  const [sel, setSel] = useState(0)
  const pins = useCollectionsStore((s) => s.pins)

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, items.length - 1)))
  }, [items.length])

  useEffect(() => {
    if (!focused) return
    function onKey(e: KeyboardEvent): void {
      if (isTextTarget(e) || e.ctrlKey) return
      if (e.key === 'Enter') {
        const item = items[sel]
        if (!item) return
        e.preventDefault()
        // Same contract as clicks: ⌘↩ new tab, ⌥↩ other pane (split if needed).
        openContent({ kind: 'note', noteId: item.id }, e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')
        return
      }
      if (e.metaKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, items.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, sel, focused])

  function open(item: NoteListItem, e: React.MouseEvent): void {
    openContent({ kind: 'note', noteId: item.id }, e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')
  }

  if (items.length === 0) {
    return <p className="px-1 py-6 text-[13px] text-ink-muted">{empty}</p>
  }

  return (
    <div className="flex flex-col">
      {items.map((n, i) => {
        const pinned = pins.some((p) => p.itemType === 'note' && p.itemId === n.id)
        return (
          <div
            key={n.id}
            data-testid="note-list-item"
            onClick={(e) => open(n, e)}
            onMouseEnter={() => setSel(i)}
            className={`group cursor-default rounded-lg px-3 py-2 ${i === sel ? 'bg-hover' : ''}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[14px] font-medium">{n.title || 'Untitled'}</span>
              <span className="shrink-0 text-[11px] text-ink-muted">
                {new Date(n.updatedAt).toLocaleDateString()}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-[12px] text-ink-muted">{n.excerpt || 'Empty note'}</span>
              <span className="hidden shrink-0 items-center gap-2 group-hover:flex">
                <button
                  title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                  onClick={(e) => {
                    e.stopPropagation()
                    void invoke('pins:set', { itemType: 'note', itemId: n.id, pinned: !pinned }).then(
                      () => toast(pinned ? 'Unpinned' : 'Pinned to sidebar')
                    )
                  }}
                  className={`text-[11px] ${pinned ? 'font-medium text-accent' : 'text-ink-muted hover:text-accent'}`}
                >
                  {pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  title="Move to Trash"
                  onClick={(e) => {
                    e.stopPropagation()
                    void invoke('notes:trash', { id: n.id })
                  }}
                  className="text-[11px] text-ink-muted hover:text-[#b0524a] dark:hover:text-[#c97a72]"
                >
                  Trash
                </button>
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
