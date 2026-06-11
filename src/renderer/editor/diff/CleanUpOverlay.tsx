import { useEffect, useMemo, useRef, useState } from 'react'
import type { IpcPushMap } from '@shared/ipc'
import { invoke, on } from '../../api'
import { toast } from '../../stores/ui'
import { buildDiffDoc } from './buildDiffDoc'
import type { DiffBlock } from './buildDiffDoc'

/**
 * Clean Up overlay (Cmd+Shift+U): covers the editor area of the active
 * NoteView (the editor stays mounted but unreachable — it was flushed before
 * opening, so the post-accept data:changed origin-'ai' reload is silent).
 *
 * The diff is a READ-ONLY styled segment view, not a TipTap instance — see
 * buildDiffDoc.ts for the documented decision. <ins>/<del> reuse the
 * .version-diff palette.
 */

type Phase = 'generating' | 'preview' | 'error'

function DiffView({ blocks }: { blocks: DiffBlock[] }): React.JSX.Element {
  return (
    <div className="version-diff select-text text-[14px] leading-relaxed">
      {blocks.map((b, i) => {
        const segments = b.segments.map((seg, j) =>
          seg.type === 'ins' ? (
            <ins key={j}>{seg.text}</ins>
          ) : seg.type === 'del' ? (
            <del key={j}>{seg.text}</del>
          ) : (
            <span key={j}>{seg.text}</span>
          )
        )
        return b.kind === 'code' ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-surface-dim px-3 py-2 font-mono text-[12px]"
          >
            {segments}
          </pre>
        ) : (
          <p key={i} className="my-2 whitespace-pre-wrap break-words">
            {segments}
          </p>
        )
      })}
    </div>
  )
}

const MAX_REFINEMENTS = 5 // mirrors the main-side cap in ai/cleanup.ts

export default function CleanUpOverlay({
  noteId,
  baseMd,
  acceptingRef,
  onClose
}: {
  noteId: string
  baseMd: string
  /** Set while accept is in flight — NoteView's external-change belt must not
   *  mistake accept's own data:changed push for a conflicting write. */
  acceptingRef: { current: boolean }
  onClose: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('generating')
  const [cleanedMd, setCleanedMd] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refineText, setRefineText] = useState('')
  const [refinesLeft, setRefinesLeft] = useState(MAX_REFINEMENTS)
  const [attempt, setAttempt] = useState(0) // bump → restart the whole session
  const [busy, setBusy] = useState(false)
  const sessionRef = useRef<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let sessionId: string | null = null
    // The error push for a too-long note can arrive BEFORE the start invoke
    // resolves (push vs invoke ordering is not guaranteed) — buffer until then.
    const buffered: IpcPushMap['ai:cleanup:result'][] = []

    const handle = (p: IpcPushMap['ai:cleanup:result']): void => {
      if (disposed) return
      if (p.error !== undefined) {
        setError(p.error)
        setPhase('error')
      } else if (p.cleanedMd !== undefined) {
        setCleanedMd(p.cleanedMd)
        setPhase('preview')
      }
    }

    const off = on('ai:cleanup:result', (p) => {
      if (sessionId === null) {
        buffered.push(p)
        return
      }
      if (p.sessionId === sessionId) handle(p)
    })

    setPhase('generating')
    setError(null)
    setCleanedMd(null)
    setRefinesLeft(MAX_REFINEMENTS) // Retry starts a FRESH session — full budget again
    void invoke('ai:cleanup:start', { noteId })
      .then(({ sessionId: sid }) => {
        sessionId = sid
        sessionRef.current = sid
        for (const p of buffered) if (p.sessionId === sid) handle(p)
        buffered.length = 0
      })
      .catch((err: unknown) => {
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
        setPhase('error')
      })

    return () => {
      disposed = true
      off()
      // Catch-all: aborts an in-flight generation and frees the session.
      // (No-op for sessions already consumed by accept.)
      if (sessionId) void invoke('ai:cleanup:cancel', { sessionId })
      sessionRef.current = null
    }
  }, [noteId, attempt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose() // unmount cleanup cancels the session
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Pull focus out of the (now read-only) editor so stray keystrokes land here.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const blocks = useMemo(
    () => (cleanedMd !== null ? buildDiffDoc(baseMd, cleanedMd) : null),
    [baseMd, cleanedMd]
  )

  const accept = (): void => {
    const sessionId = sessionRef.current
    if (!sessionId || busy) return
    setBusy(true)
    acceptingRef.current = true
    void invoke('ai:cleanup:accept', { sessionId })
      .then(() => {
        sessionRef.current = null // consumed — the unmount cancel becomes a no-op
        toast('Note cleaned up')
        onClose() // the editor reloads via data:changed origin 'ai' (clean → silent)
      })
      .catch((err: unknown) => {
        // Accept failures are terminal (stale base, trashed, session gone) —
        // close so the user sees the live note instead of a dead preview.
        toast(err instanceof Error ? err.message : 'Accept failed')
        onClose()
      })
      .finally(() => {
        acceptingRef.current = false
        setBusy(false)
      })
  }

  const refine = (): void => {
    const sessionId = sessionRef.current
    const instruction = refineText.trim()
    if (!sessionId || !instruction || busy) return
    setRefineText('')
    setPhase('generating')
    void invoke('ai:cleanup:refine', { sessionId, instruction })
      .then(() => setRefinesLeft((n) => n - 1))
      .catch((err: unknown) => {
        // e.g. the 5-refinement cap — stay on the current preview.
        toast(err instanceof Error ? err.message : 'Refine failed')
        setPhase('preview')
      })
  }

  return (
    <div ref={containerRef} tabIndex={-1} className="absolute inset-0 z-30 flex flex-col bg-surface outline-none">
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-2">
        <span className="text-[13px] font-semibold">Clean Up</span>
        <span className="text-[11px] text-ink-muted">
          {phase === 'generating'
            ? 'Generating…'
            : phase === 'preview'
              ? 'Red = removed · blue = added'
              : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-5">
        {phase === 'generating' && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-hairline border-t-accent" />
            <p className="text-[12px] text-ink-muted">Cleaning up this note…</p>
            <button
              onClick={onClose}
              className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
            >
              Cancel
            </button>
          </div>
        )}
        {phase === 'error' && (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="max-w-md text-center text-[13px] text-red-700">{error}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setAttempt((a) => a + 1)}
                className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
              >
                Retry
              </button>
              <button
                onClick={onClose}
                className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
              >
                Close
              </button>
            </div>
          </div>
        )}
        {phase === 'preview' && blocks && <DiffView blocks={blocks} />}
      </div>

      {phase === 'preview' && (
        <div className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-2.5">
          <input
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                refine()
              }
            }}
            placeholder={refinesLeft > 0 ? 'Refine… (e.g. keep my headings)' : 'Refinement limit reached'}
            disabled={refinesLeft <= 0}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-dim px-2.5 py-1.5 text-[12px] outline-none focus:border-accent/50 disabled:opacity-50"
            style={{ userSelect: 'text' }}
          />
          <button
            onClick={refine}
            disabled={!refineText.trim() || refinesLeft <= 0 || busy}
            className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5 disabled:opacity-50"
          >
            Refine
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
          >
            Cancel
          </button>
          <button
            onClick={accept}
            disabled={busy}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            Accept
          </button>
        </div>
      )}
    </div>
  )
}
