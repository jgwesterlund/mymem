import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchResult } from '@shared/types'
import { invoke, on } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { useTabsStore } from '../stores/tabs'

/** Only <mark> survives: escape everything, then resurrect the snippet's mark tags. */
function snippetHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}

// data:changed → re-query AFTER the indexer's 2 s debounce so fresh chunks are
// in FTS; trash/delete drop chunks synchronously → re-query right away.
const REINDEX_DELAY_MS = 2300
const IMMEDIATE_DELAY_MS = 50

export default function SearchResultsView({ query }: { query: string }): React.JSX.Element {
  const collections = useCollectionsStore((s) => s.items)
  const [q, setQ] = useState(query)
  const [collectionId, setCollectionId] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState(false)
  const latest = useRef({ q: query, collectionId: '' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const run = useCallback(async (): Promise<void> => {
    const trimmed = latest.current.q.trim()
    const mySeq = ++seq.current
    if (!trimmed) {
      setResults([])
      setSearched(false)
      return
    }
    const res = await invoke('search:query', {
      q: trimmed,
      mode: 'keyword',
      collectionId: latest.current.collectionId || undefined
    })
    if (seq.current !== mySeq) return // a newer query superseded this one
    setResults(res.results)
    setSearched(true)
  }, [])

  useEffect(() => {
    void run()
    const off = on('data:changed', (ev) => {
      if (ev.entity !== 'note') return
      const delay = ev.op === 'trash' || ev.op === 'delete' ? IMMEDIATE_DELAY_MS : REINDEX_DELAY_MS
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        void run()
      }, delay)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [run])

  function openNote(noteId: string, inNewTab: boolean): void {
    const tabs = useTabsStore.getState()
    if (inNewTab) tabs.openTab({ kind: 'note', noteId })
    else tabs.openInCurrentTab({ kind: 'note', noteId })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <h1 className="mb-4 px-1 text-xl font-semibold tracking-tight">Search</h1>
      <div className="mb-4 flex items-center gap-2 px-1">
        <input
          autoFocus={!query}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // full-text runs on Enter, never per keystroke — and data:changed
            // refreshes re-run the SUBMITTED query, not half-typed input
            if (e.key === 'Enter') {
              latest.current.q = e.currentTarget.value
              void run()
            }
          }}
          placeholder="Search notes…"
          className="w-full max-w-md rounded-lg border border-hairline bg-surface-dim px-3 py-1.5 text-[13px] outline-none"
        />
        <select
          value={collectionId}
          onChange={(e) => {
            setCollectionId(e.target.value)
            latest.current.collectionId = e.target.value
            void run()
          }}
          className="shrink-0 rounded-lg border border-hairline bg-surface-dim px-2 py-1.5 text-[12px] outline-none"
        >
          <option value="">All collections</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-hairline text-[12px]">
          <button className="bg-black/10 px-2.5 py-1.5 font-medium">Keyword</button>
          <button
            disabled
            title="Semantic search arrives with the embedding model (M5)"
            className="px-2.5 py-1.5 text-ink-muted/50"
          >
            Deep
          </button>
        </div>
      </div>
      {!searched ? (
        <p className="px-1 py-6 text-[13px] text-ink-muted">
          Type a query and press Enter to search your notes.
        </p>
      ) : results.length === 0 ? (
        <p className="px-1 py-6 text-[13px] text-ink-muted">
          No results for “{latest.current.q.trim()}”.
        </p>
      ) : (
        <div className="flex flex-col">
          {results.map((r) => (
            <div
              key={r.noteId}
              onClick={(e) => openNote(r.noteId, e.metaKey)}
              className="group cursor-default rounded-lg px-3 py-2 hover:bg-black/5"
            >
              <div className="truncate text-[14px] font-medium">{r.title || 'Untitled'}</div>
              <div
                className="search-snippet truncate text-[12px] text-ink-muted"
                dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippetHtml) }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
