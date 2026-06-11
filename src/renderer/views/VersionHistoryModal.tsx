import { useEffect, useMemo, useState } from 'react'
import { diffWordsWithSpace } from 'diff'
import type { VersionKind, VersionMeta } from '@shared/types'
import { invoke } from '../api'
import { toast } from '../stores/ui'

/** Above this combined size the word diff gets quadratic-ugly — plain preview instead. */
const DIFF_MAX_COMBINED_CHARS = 60_000

const KIND_LABEL: Record<VersionKind, string> = {
  session: 'session',
  pre_cleanup: 'pre-cleanup',
  pre_restore: 'pre-restore',
  import: 'import',
  ai_edit: 'ai edit'
}

// Fjord palette (v1.2): muted Nordic tones — gray-violet (cleanup), sand
// (restore), muted green (import), fjord blue (ai) — semantics kept, saturation dropped.
const KIND_CLASS: Record<VersionKind, string> = {
  session: 'bg-hover text-ink-muted',
  pre_cleanup: 'bg-[#7d7a8c]/10 text-[#6d6a7d] dark:text-[#a8a5b8]',
  pre_restore: 'bg-[#a98e5f]/10 text-[#8a7349] dark:text-[#c4ab7d]',
  import: 'bg-[#6f8472]/10 text-[#5e7361] dark:text-[#9cb09f]',
  ai_edit: 'bg-[#5b7c99]/10 text-[#4a6e8f] dark:text-[#7d9cb8]'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function relativeTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function sizeLabel(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`
}

/**
 * Version history — an overlay in the main window (no extra BrowserWindow).
 * Left: versions:list. Right: the selected version with a word-level diff
 * against the CURRENT note: <ins> (blue) = text a restore would bring back,
 * <del> (red strikethrough) = current text a restore would drop. All diff text
 * is HTML-escaped before injection.
 */
export default function VersionHistoryModal({
  noteId,
  currentMd,
  onClose,
  onRestore
}: {
  noteId: string
  currentMd: string
  onClose: () => void
  onRestore: (versionId: string) => Promise<void>
}): React.JSX.Element {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ title: string; contentMd: string } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    void invoke('versions:list', { noteId }).then((list) => {
      setVersions(list)
      setSelectedId(list[0]?.id ?? null)
    })
  }, [noteId])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    setSelected(null)
    void invoke('versions:get', { versionId: selectedId }).then((v) => {
      if (!cancelled) setSelected(v)
    })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const preview = useMemo(() => {
    if (!selected) return null
    if (selected.contentMd.length + currentMd.length > DIFF_MAX_COMBINED_CHARS) {
      return { html: escapeHtml(selected.contentMd), plain: true }
    }
    // timeout: pathological pairs can take seconds synchronously; undefined = timed out
    const parts = diffWordsWithSpace(currentMd, selected.contentMd, { timeout: 1000 })
    if (!parts) return { html: escapeHtml(selected.contentMd), plain: true }
    const html = parts
      .map((part) =>
        part.added
          ? `<ins>${escapeHtml(part.value)}</ins>`
          : part.removed
            ? `<del>${escapeHtml(part.value)}</del>`
            : escapeHtml(part.value)
      )
      .join('')
    return { html, plain: false }
  }, [selected, currentMd])

  return (
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={onClose}>
      <div
        className="mx-auto mt-[8vh] flex h-[76vh] w-[52rem] max-w-[92vw] overflow-hidden rounded-xl border border-hairline bg-surface shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex w-60 shrink-0 flex-col border-r border-hairline">
          <div className="border-b border-hairline px-3 py-2.5 text-[12px] font-semibold">
            Version history
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {versions === null ? null : versions.length === 0 ? (
              <p className="px-2 py-4 text-[12px] text-ink-muted">
                No versions yet — they accumulate as you edit.
              </p>
            ) : (
              versions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                    v.id === selectedId ? 'bg-accent/15' : 'hover:bg-hover'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`rounded px-1 py-px text-[10px] font-medium ${KIND_CLASS[v.kind]}`}
                    >
                      {KIND_LABEL[v.kind]}
                    </span>
                    <span className="text-[12px]">{relativeTime(v.createdAt)}</span>
                  </span>
                  <span className="text-[11px] text-ink-muted">{sizeLabel(v.sizeChars)}</span>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {versions !== null && versions.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-ink-muted">
              Nothing to show.
            </div>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {preview && (
                  <pre
                    className="version-diff whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: preview.html }}
                  />
                )}
              </div>
              <div className="flex items-center justify-between border-t border-hairline px-4 py-2.5">
                <span className="text-[11px] text-ink-muted">
                  {preview?.plain
                    ? 'Too large for a word diff — showing the version as-is.'
                    : 'Blue = restored by this version · red = removed by it.'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onClose}
                    className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
                  >
                    Close
                  </button>
                  <button
                    disabled={!selectedId || restoring}
                    onClick={() => {
                      if (!selectedId) return
                      setRestoring(true)
                      void onRestore(selectedId)
                        .catch(() => toast('Restore failed — note is in Trash'))
                        .finally(() => setRestoring(false))
                    }}
                    className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {restoring ? 'Restoring…' : 'Restore this version'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
