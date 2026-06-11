import { useEffect, useRef, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import { clearFind, getFindState, moveFind, setFindQuery } from './extensions/findInNote'

/**
 * Cmd+F bar for the focused pane's NoteView. The matching itself lives in the
 * FindInNote ProseMirror plugin (decorations, doc-change recompute) — this bar
 * only drives it: typing sets the query, Enter/Shift+Enter cycle matches,
 * Esc closes (NoteView clears + refocuses the editor via onClose).
 */
export function FindBar({
  editor,
  focusSeq,
  onClose
}: {
  editor: TipTapEditor
  /** Bumped by NoteView on every Cmd+F so an already-open bar refocuses. */
  focusSeq: number
  onClose: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState({ index: 0, count: 0 })
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSeq])

  // Attach to the (possibly swapped — epoch reload) editor instance: mirror the
  // plugin's match state into 'n of m' on every transaction, and re-apply the
  // current query so highlights survive an editor remount under an open bar.
  useEffect(() => {
    if (editor.isDestroyed) return
    const sync = (): void => {
      const s = getFindState(editor)
      setPos({ index: s.index, count: s.matches.length })
    }
    if (queryRef.current) setFindQuery(editor, queryRef.current)
    sync()
    editor.on('transaction', sync)
    return () => {
      editor.off('transaction', sync)
      if (!editor.isDestroyed) clearFind(editor)
    }
  }, [editor])

  const move = (dir: 1 | -1): void => {
    if (!editor.isDestroyed) moveFind(editor, dir)
  }

  return (
    <div
      data-testid="find-bar"
      className="absolute right-6 top-2 z-20 flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-2 py-1 shadow-md"
    >
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          if (!editor.isDestroyed) setFindQuery(editor, e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            move(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
        placeholder="Find in note"
        className="w-44 bg-transparent text-[12px] outline-none placeholder:text-ink-muted/60"
      />
      <span className="min-w-12 text-right text-[11px] tabular-nums text-ink-muted">
        {query ? (pos.count > 0 ? `${pos.index + 1} of ${pos.count}` : '0 of 0') : ''}
      </span>
      <button
        title="Previous match (Shift+Enter)"
        onClick={() => move(-1)}
        className="rounded px-1 text-[13px] leading-none text-ink-muted hover:bg-active"
      >
        ‹
      </button>
      <button
        title="Next match (Enter)"
        onClick={() => move(1)}
        className="rounded px-1 text-[13px] leading-none text-ink-muted hover:bg-active"
      >
        ›
      </button>
      <button
        title="Close (Esc)"
        onClick={onClose}
        className="rounded px-1 text-[12px] leading-none text-ink-muted hover:bg-active"
      >
        ✕
      </button>
    </div>
  )
}
