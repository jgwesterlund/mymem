import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmbeddingsStatus, RelatedCollection, RelatedNote } from '@shared/types'
import { invoke, on } from '../api'
import { useTabsStore } from '../stores/tabs'

/**
 * Heads Up: related notes/collections for the active note tab. Refreshes
 * immediately on tab switch and 1.5 s after a data:changed for that note
 * (the indexer's own 2 s debounce means the next edit-triggered refresh may
 * still see old chunks — the following data:changed catches up).
 */
const EDIT_DEBOUNCE_MS = 1500

type Related = { notes: RelatedNote[]; collections: RelatedCollection[]; unavailableReason?: string }

const UNAVAILABLE_COPY: Record<string, string> = {
  'embedding-pending': 'Indexing this note — related notes will appear shortly.',
  'no-content': 'Write something first — related notes appear once this note has content.',
  'embeddings-error': 'The embedding worker hit an error. Related notes are paused.',
  'embeddings-downloading': 'Preparing the model…',
  'embeddings-disabled': 'Semantic features are off.'
}

function ConsentCard({ status }: { status: EmbeddingsStatus }): React.JSX.Element {
  const [requested, setRequested] = useState(false)
  return (
    <div className="m-3 rounded-lg border border-hairline bg-surface-dim px-4 py-3">
      <p className="text-[13px] font-medium">Turn on semantic search</p>
      <p className="mt-1 text-[12px] text-ink-muted">
        Related notes and Deep Search need a small language model ({status.model.split('/')[1]},
        ~25 MB) downloaded once and run entirely on this Mac. Nothing leaves your machine.
      </p>
      <button
        disabled={requested}
        onClick={() => {
          setRequested(true)
          void invoke('settings:set', { key: 'embeddings.consent', value: true })
        }}
        className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {requested ? 'Starting…' : 'Download model'}
      </button>
    </div>
  )
}

function DownloadingCard({ status }: { status: EmbeddingsStatus }): React.JSX.Element {
  const pct = Math.round((status.progress ?? 0) * 100)
  return (
    <div className="m-3 rounded-lg border border-hairline bg-surface-dim px-4 py-3">
      <p className="text-[13px] font-medium">Downloading model… {pct}%</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/10">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ErrorCard({ status }: { status: EmbeddingsStatus }): React.JSX.Element {
  return (
    <div className="m-3 rounded-lg border border-hairline bg-surface-dim px-4 py-3">
      <p className="text-[13px] font-medium">Embeddings unavailable</p>
      <p className="mt-1 break-words text-[12px] text-ink-muted">{status.error ?? 'Unknown error.'}</p>
      <button
        onClick={() => void invoke('settings:set', { key: 'embeddings.consent', value: true })}
        className="mt-2 rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
      >
        Retry
      </button>
    </div>
  )
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-4 py-6 text-center text-[12px] text-ink-muted">{text}</p>
}

export function HeadsUpPanel(): React.JSX.Element {
  const activeContent = useTabsStore((s) => s.tabs[s.activeTabIndex]?.content)
  const noteId = activeContent?.kind === 'note' ? activeContent.noteId : null
  const [status, setStatus] = useState<EmbeddingsStatus | null>(null)
  const [related, setRelated] = useState<Related | null>(null)
  const [broadened, setBroadened] = useState(false)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let pushed = false
    const off = on('embeddings:status-changed', (st) => {
      pushed = true
      setStatus(st)
    })
    // Initial pull races the subscription: a push that lands first is fresher.
    void invoke('embeddings:status').then((st) => {
      if (!pushed) setStatus(st)
    })
    return off
  }, [])

  const ready = status?.state === 'ready'

  const refresh = useCallback(
    async (broaden: boolean): Promise<void> => {
      if (!noteId) return
      const mySeq = ++seq.current
      setLoading(true)
      try {
        const res = await invoke('related:forNote', { noteId, broaden })
        if (seq.current !== mySeq) return
        setRelated(res)
        setBroadened(broaden)
      } finally {
        if (seq.current === mySeq) setLoading(false)
      }
    },
    [noteId]
  )

  // Immediate on tab/note switch (and when the worker first becomes ready).
  useEffect(() => {
    seq.current++ // invalidate in-flight fetches for the previous note
    setRelated(null)
    setBroadened(false)
    if (noteId && ready) void refresh(false)
  }, [noteId, ready, refresh])

  // Debounced after edits to the active note.
  useEffect(() => {
    if (!noteId || !ready) return
    const off = on('data:changed', (ev) => {
      if (ev.entity !== 'note' || !ev.ids.includes(noteId)) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        void refresh(broadened)
      }, EDIT_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [noteId, ready, broadened, refresh])

  function openNote(id: string, inNewTab: boolean): void {
    const tabs = useTabsStore.getState()
    if (inNewTab) tabs.openTab({ kind: 'note', noteId: id })
    else tabs.openInCurrentTab({ kind: 'note', noteId: id })
  }

  if (!noteId) return <Empty text="Open a note to see related notes." />
  if (!status) return <div className="flex-1" />
  if (status.state === 'disabled') return <ConsentCard status={status} />
  if (status.state === 'downloading') return <DownloadingCard status={status} />
  if (status.state === 'error') return <ErrorCard status={status} />
  if (!related) return <Empty text={loading ? 'Finding related notes…' : ''} />
  if (related.unavailableReason) {
    return <Empty text={UNAVAILABLE_COPY[related.unavailableReason] ?? 'Related notes unavailable.'} />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
      {related.notes.length === 0 ? (
        <Empty text="No related notes yet." />
      ) : (
        <div className="flex flex-col gap-0.5 px-2">
          {related.notes.map((n) => (
            <div
              key={n.noteId}
              onClick={(e) => openNote(n.noteId, e.metaKey)}
              className="group cursor-default rounded-lg px-2.5 py-1.5 hover:bg-black/5"
            >
              <div className="truncate text-[13px] font-medium">{n.title || 'Untitled'}</div>
              <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-black/5">
                <div
                  className="h-full rounded-full bg-accent/60"
                  style={{ width: `${Math.round(Math.max(0, Math.min(1, n.score)) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {related.collections.length > 0 && (
        <div className="mt-3 px-3">
          <div className="pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Related collections
          </div>
          <div className="flex flex-wrap gap-1.5">
            {related.collections.map((c) => (
              <button
                key={c.collectionId}
                onClick={() =>
                  useTabsStore.getState().openInCurrentTab({ kind: 'collection', collectionId: c.collectionId })
                }
                className="rounded-full border border-hairline px-2 py-0.5 text-[11px] hover:bg-black/5"
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {!broadened && (
        <div className="mt-3 px-3">
          <button
            disabled={loading}
            onClick={() => void refresh(true)}
            className="w-full rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5 disabled:opacity-50"
          >
            Find More
          </button>
        </div>
      )}
    </div>
  )
}
