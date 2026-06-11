import { useEffect, useRef, useState } from 'react'
import { invoke } from '../api'
import { openContent, type PaneContent } from '../stores/tabs'
import { useUiStore } from '../stores/ui'

type Row = { kind: 'note'; noteId: string; title: string } | { kind: 'query'; query: string }

const TYPEAHEAD_DEBOUNCE_MS = 120

/**
 * Cmd+K palette. Typeahead is title-LIKE only — NEVER FTS per keystroke; the
 * trailing 'Search for …' row (or Enter with no match selected) opens a
 * full-text results tab instead. App-wide modifier contract (Enter AND click):
 * plain = current pane, ⌘ = new tab, ⌥ = other pane (splitting if needed).
 * Esc closes.
 */
export function SearchPalette(): React.JSX.Element | null {
  const open = useUiStore((s) => s.searchPaletteOpen)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ noteId: string; title: string }[]>([])
  const [sel, setSel] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    if (!open) return
    setQ('')
    setHits([]) // last session's rows must not be clickable during the refetch
    setSel(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const mySeq = ++seq.current
    const timer = setTimeout(() => {
      void invoke('search:typeahead', { q }).then((rows) => {
        if (seq.current !== mySeq) return // stale response — a newer keystroke won
        setHits(rows)
        setSel(0)
      })
    }, TYPEAHEAD_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, q])

  if (!open) return null

  const query = q.trim()
  const rows: Row[] = [
    ...hits.map<Row>((h) => ({ kind: 'note', noteId: h.noteId, title: h.title })),
    ...(query ? [{ kind: 'query', query } as Row] : [])
  ]

  function close(): void {
    useUiStore.getState().setSearchPaletteOpen(false)
  }

  function openRow(row: Row | undefined, target: 'self' | 'tab' | 'pane'): void {
    const content: PaneContent | null = row
      ? row.kind === 'note'
        ? { kind: 'note', noteId: row.noteId }
        : { kind: 'search', query: row.query }
      : query
        ? { kind: 'search', query }
        : null
    if (!content) return
    openContent(content, target)
    close()
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={close}>
      <div
        className="mx-auto mt-[14vh] w-[36rem] overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => (rows.length ? (s + 1) % rows.length : 0))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              openRow(rows[sel], e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')
            }
          }}
          placeholder="Search notes…"
          className="w-full border-b border-hairline bg-transparent px-4 py-3 text-[14px] outline-none placeholder:text-ink-muted/60"
        />
        {rows.length > 0 && (
          <div className="max-h-80 overflow-y-auto p-1.5">
            {rows.map((row, i) => (
              <button
                key={row.kind === 'note' ? row.noteId : '__query'}
                onMouseEnter={() => setSel(i)}
                onClick={(e) => openRow(row, e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')}
                className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                  i === sel ? 'bg-accent/15' : ''
                }`}
              >
                {row.kind === 'note' ? (
                  <span className="truncate">{row.title || 'Untitled'}</span>
                ) : (
                  <span className="truncate text-ink-muted">
                    Search for “<span className="text-ink">{row.query}</span>”
                  </span>
                )}
                {i === sel && (
                  <span className="ml-2 shrink-0 text-[11px] text-ink-muted">
                    ↩ open · ⌘↩ new tab · ⌥↩ other pane
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
