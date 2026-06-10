import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Note } from '@shared/types'
import type { MarkdownManager } from '@tiptap/markdown'
import { invoke, on } from '../api'
import { useTabsStore } from '../stores/tabs'
import Editor from '../editor/Editor'

/** Saved markdown is canonical without trailing newlines. */
function normalizeMd(md: string): string {
  return md.replace(/\n+$/, '')
}

interface SaveState {
  base: number // baseUpdatedAt for the CAS guard
  lastMd: string
  lastTitle: string
  title: string
  timer: ReturnType<typeof setTimeout> | null
  inflight: Promise<void> | null
  disabled: boolean // note trashed/deleted — nothing may be written anymore
  editor: TipTapEditor | null
  // Doc + manager are captured on every update so a flush still works after the
  // editor instance has been destroyed (tab close races React cleanup order).
  doc: PMNode | null
  manager: MarkdownManager | null
}

type NoteWithRefs = Note & { collectionIds: string[]; pinned: boolean }

export default function NoteView({ noteId }: { noteId: string }): React.JSX.Element {
  const [note, setNote] = useState<NoteWithRefs | null>(null)
  const [title, setTitle] = useState('')
  const [banner, setBanner] = useState<'conflict' | 'external' | null>(null)
  const [gone, setGone] = useState<'missing' | 'trashed' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [epoch, setEpoch] = useState(0)

  const save = useRef<SaveState>({
    base: 0,
    lastMd: '',
    lastTitle: '',
    title: '',
    timer: null,
    inflight: null,
    disabled: false,
    editor: null,
    doc: null,
    manager: null
  })

  const currentMd = useCallback((): string | null => {
    const s = save.current
    if (!s.doc || !s.manager) return null
    return normalizeMd(s.manager.serialize(s.doc.toJSON()))
  }, [])

  const isDirty = useCallback((): boolean => {
    const s = save.current
    if (s.timer !== null || s.inflight !== null) return true
    if (s.title !== s.lastTitle) return true
    const md = currentMd()
    return md !== null && md !== s.lastMd
  }, [currentMd])

  const flush = useCallback(async (): Promise<void> => {
    const s = save.current
    if (s.timer) {
      clearTimeout(s.timer)
      s.timer = null
    }
    // Loop until clean: keystrokes typed while a save was in flight must land in
    // a follow-up save before a terminal flush (unmount/blur/quit) returns.
    for (;;) {
      if (s.inflight) {
        await s.inflight
        continue
      }
      if (s.disabled) return
      const md = currentMd()
      const patch: { title?: string; contentMd?: string } = {}
      if (md !== null && md !== s.lastMd) patch.contentMd = md
      if (s.title !== s.lastTitle) patch.title = s.title
      if (Object.keys(patch).length === 0) return
      let halted = false
      const run = (async (): Promise<void> => {
        try {
          const res = await invoke('notes:update', { id: noteId, patch, baseUpdatedAt: s.base })
          if (res.conflict) {
            halted = true // CAS lost — looping on the stale base would spin forever
            setBanner('conflict')
            return
          }
          s.base = res.updatedAt
          if (patch.contentMd !== undefined) s.lastMd = patch.contentMd
          if (patch.title !== undefined) s.lastTitle = patch.title
          setSavedAt(res.updatedAt)
        } catch (err) {
          halted = true // e.g. note trashed mid-save; surfaced via the gone state
          console.error('note save failed', err)
        } finally {
          s.inflight = null
        }
      })()
      s.inflight = run
      await run
      if (halted) return
    }
  }, [noteId, currentMd])

  const flushRef = useRef(flush)
  flushRef.current = flush

  const schedule = useCallback((): void => {
    const s = save.current
    if (s.timer) clearTimeout(s.timer)
    s.timer = setTimeout(() => {
      s.timer = null
      void flushRef.current()
    }, 800)
  }, [])

  // Load (and reload on epoch bump). Editor remounts via key on note.updatedAt.
  useEffect(() => {
    let cancelled = false
    void invoke('notes:get', { id: noteId })
      .then((n) => {
        if (cancelled) return
        const s = save.current
        if (s.timer) {
          clearTimeout(s.timer) // a pending save from the outgoing editor must not fire mid-reload
          s.timer = null
        }
        s.base = n.updatedAt
        s.lastMd = normalizeMd(n.contentMd)
        s.lastTitle = n.title
        s.title = n.title
        s.doc = null // stale doc belongs to the editor about to be remounted
        s.disabled = false
        setNote(n)
        setTitle(n.title)
        setBanner(null)
        setGone(null)
      })
      .catch(() => {
        // Stale noteId (session restore, history after delete) — offer to close.
        if (!cancelled) setGone('missing')
      })
    return () => {
      cancelled = true
    }
  }, [noteId, epoch])

  // Flush on tab switch/close (unmount) and best-effort on window blur/unload.
  // beforeunload cannot await; the blur flush plus the ≤800 ms autosave window
  // keep the quit race acceptable (flush itself never drops in-flight typing).
  useEffect(() => {
    const onUnload = (): void => {
      void flushRef.current()
    }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('blur', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('blur', onUnload)
      void flushRef.current()
    }
  }, [])

  // External writes (AI/import/capture/api): silent reload when clean, banner when dirty.
  // An external reload remounts the editor — undo history resets by design.
  useEffect(() => {
    return on('data:changed', (ev) => {
      if (ev.entity !== 'note' || !ev.ids.includes(noteId)) return
      // The open note got trashed/deleted (any origin): stop saving, offer to close.
      if (ev.op === 'trash' || ev.op === 'delete') {
        const s = save.current
        if (s.timer) {
          clearTimeout(s.timer)
          s.timer = null
        }
        s.disabled = true
        setGone(ev.op === 'trash' ? 'trashed' : 'missing')
        return
      }
      if (ev.op === 'restore') {
        setEpoch((e) => e + 1) // reload clears the gone state and re-enables saves
        return
      }
      if (ev.origin === 'user') return
      if (isDirty()) setBanner('external')
      else setEpoch((e) => e + 1)
    })
  }, [noteId, isDirty])

  if (gone) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-ink-muted">
          {gone === 'trashed'
            ? 'This note was moved to Trash.'
            : 'Note not found — it may have been deleted.'}
        </p>
        <button
          onClick={() => useTabsStore.getState().closeTab()}
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
        >
          Close tab
        </button>
      </div>
    )
  }

  if (!note) return <div className="flex-1" />

  const savedLabel = savedAt
    ? `Saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {banner && (
        <div className="flex items-center justify-between border-b border-hairline bg-amber-100 px-4 py-1.5 text-[12px] text-amber-900">
          <span>
            {banner === 'conflict'
              ? 'Save conflict — this note changed elsewhere.'
              : 'Note changed elsewhere.'}
          </span>
          <button
            onClick={() => {
              if (
                isDirty() &&
                !window.confirm('Reload this note? Your unsaved local edits will be discarded.')
              ) {
                return
              }
              setEpoch((e) => e + 1)
            }}
            className="rounded-md bg-amber-200 px-2 py-0.5 font-medium hover:bg-amber-300"
          >
            Reload
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-10 py-6">
        <div className="flex items-baseline justify-between gap-4">
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              save.current.title = e.target.value
              schedule()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault()
                save.current.editor?.commands.focus('start')
              }
            }}
            onBlur={() => void flushRef.current()}
            placeholder="Untitled"
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold tracking-tight outline-none placeholder:text-ink-muted/40"
          />
          <span className="shrink-0 text-[11px] text-ink-muted">{savedLabel}</span>
        </div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <Editor
            key={`${epoch}:${note.updatedAt}`}
            noteId={noteId}
            initialMd={note.contentMd}
            onReady={(e) => {
              const s = save.current
              s.editor = e
              s.doc = e.state.doc
              s.manager = e.storage.markdown.manager
              // Baseline = the editor's OWN serialization: stored markdown that
              // is merely non-canonical (e.g. '* ' bullets) must not count as
              // dirty — an unedited note is never rewritten on flush.
              s.lastMd = currentMd() ?? s.lastMd
            }}
            onDocChanged={(e) => {
              if (e !== save.current.editor) return // outgoing instance during an epoch reload
              save.current.doc = e.state.doc
              schedule()
            }}
            onEditorBlur={() => void flushRef.current()}
          />
        </div>
      </div>
    </div>
  )
}
