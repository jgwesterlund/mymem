import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Note } from '@shared/types'
import type { MarkdownManager } from '@tiptap/markdown'
import { invoke, on } from '../api'
import { useTabsStore } from '../stores/tabs'
import { useUiStore, toast } from '../stores/ui'
import Editor from '../editor/Editor'
import CleanUpOverlay from '../editor/diff/CleanUpOverlay'
import { FindBar } from '../editor/FindBar'
import VersionHistoryModal from './VersionHistoryModal'
import OrganizeModal from './OrganizeModal'

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

/**
 * `focused` = this NoteView sits in the ACTIVE pane of the active tab. A split
 * tab can mount TWO NoteViews (possibly on the SAME note), so everything that
 * must fire exactly once per command — export/cleanup/find requests and the
 * history/organize modals — is gated on it (only the focused pane responds).
 */
export default function NoteView({
  noteId,
  focused = true
}: {
  noteId: string
  focused?: boolean
}): React.JSX.Element {
  const [note, setNote] = useState<NoteWithRefs | null>(null)
  const [title, setTitle] = useState('')
  const [banner, setBanner] = useState<'conflict' | 'external' | null>(null)
  const [gone, setGone] = useState<'missing' | 'trashed' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [epoch, setEpoch] = useState(0)
  // Live TipTap instance as React state (not just the save ref): the FindBar
  // needs to re-render/re-attach when an epoch reload swaps the editor.
  const [liveEditor, setLiveEditor] = useState<TipTapEditor | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  // Bumped on every Cmd+F so an already-open FindBar refocuses its input.
  const [findFocusSeq, setFindFocusSeq] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false) // the ⋯ menu (Save as template)
  // Base markdown of the open cleanup session (captured ONCE at open, post-flush);
  // null = overlay closed.
  const [cleanupBase, setCleanupBase] = useState<string | null>(null)
  // Paste-nudge origin of the open session (captured with cleanupBase): the
  // session may then strip web debris under the relaxed length floor.
  const [cleanupWebPaste, setCleanupWebPaste] = useState(false)
  // True while the overlay's accept invoke is in flight — its own data:changed
  // (origin 'ai') push must not trip the external-change belt below.
  const cleanupAccepting = useRef(false)
  const historyOpen = useUiStore((s) => s.historyNoteId === noteId)
  const organizeOpen = useUiStore((s) => s.organizeNoteId === noteId)

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

  // Menu File > Export routes here (the registry can't flush): flush, then export.
  // Unfocused instances TRACK the counter but swallow the request (split tab,
  // same note in both panes → exactly one export) — and never retro-fire it
  // when they later gain focus.
  const exportRequest = useUiStore((s) => s.exportRequest)
  const lastExportReq = useRef(exportRequest)
  useEffect(() => {
    if (exportRequest === lastExportReq.current) return
    lastExportReq.current = exportRequest
    if (!focused) return
    void flushRef.current().then(() =>
      invoke('notes:export', { id: noteId })
        .then((res) => {
          if (res.path) toast(`Exported to ${res.path}`)
        })
        .catch(() => toast('Export failed'))
    )
  }, [exportRequest, noteId, focused])

  // Clean Up (Cmd+Shift+U) routes here like export: flush the editor FIRST so
  // the session's base markdown matches the screen (and the post-accept reload
  // finds a clean editor → silent, no banner). Focused pane only (see export).
  const cleanupRequest = useUiStore((s) => s.cleanupRequest)
  const lastCleanupReq = useRef(cleanupRequest)
  useEffect(() => {
    if (cleanupRequest === lastCleanupReq.current) return
    lastCleanupReq.current = cleanupRequest
    if (!focused || save.current.disabled) return
    void flushRef.current().then(() => {
      setCleanupWebPaste(useUiStore.getState().cleanupWebPaste)
      setCleanupBase(currentMd() ?? save.current.lastMd)
    })
  }, [cleanupRequest, currentMd, focused])

  // Find in note (Cmd+F): the focused pane opens (or refocuses) its FindBar.
  const findRequest = useUiStore((s) => s.findRequest)
  const lastFindReq = useRef(findRequest)
  useEffect(() => {
    if (findRequest === lastFindReq.current) return
    lastFindReq.current = findRequest
    if (!focused || save.current.disabled) return
    setFindOpen(true)
    setFindFocusSeq((n) => n + 1)
  }, [findRequest, focused])

  const closeFind = useCallback((): void => {
    setFindOpen(false)
    const e = save.current.editor
    if (e && !e.isDestroyed) e.commands.focus()
  }, [])

  // While the overlay covers the editor it must not swallow keystrokes either:
  // ProseMirror keeps focus under an absolute cover, and autosave would persist
  // edits the user cannot see (and accept would then hit the staleness guard).
  useEffect(() => {
    if (cleanupBase === null) return
    const editor = save.current.editor
    if (editor && !editor.isDestroyed) {
      editor.setEditable(false)
      editor.commands.blur()
    }
    return () => {
      const e = save.current.editor
      if (e && !e.isDestroyed) e.setEditable(true)
    }
  }, [cleanupBase])

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
        if (n.trashedAt !== null) {
          // Session-restored tab pointing at a note trashed in a previous run.
          save.current.disabled = true
          setGone('trashed')
          return
        }
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

  // A history/organize modal left open must not follow the user to another
  // tab/note. Focused instance only: when a split collapses, the UNFOCUSED
  // co-mounted view (same noteId) unmounts too and must not close the modal
  // the surviving pane is rendering.
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  useEffect(() => {
    return () => {
      if (!focusedRef.current) return
      const ui = useUiStore.getState()
      if (ui.historyNoteId === noteId) ui.closeHistory()
      if (ui.organizeNoteId === noteId) ui.closeOrganize()
    }
  }, [noteId])

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
      if (ev.origin === 'user') {
        // TWO-PANE CASE (Cmd+. default = same note in both panes): pane A's
        // autosave lands here in pane B as origin 'user'. The old blanket skip
        // left pane B's CAS base permanently stale → first keystroke in pane B
        // could only ever conflict. Instead, decide per INSTANCE:
        //  - timer/inflight set → we are the saver (or have edits queued that
        //    our own save pipeline will reconcile): skip — reloading would
        //    remount the editor mid-typing;
        //  - dirty → skip silently: the CAS guard surfaces the conflict banner
        //    at save time (keep-mine / take-theirs via Reload);
        //  - clean → check whether our base is stale. The saver's event finds
        //    base === updatedAt (its save already adopted) → no-op; a clean
        //    co-mounted view on the same note finds a newer updatedAt and
        //    silently adopts the save (reload, exactly like an external write —
        //    undo history resets by design).
        const s = save.current
        if (s.timer !== null || s.inflight !== null) return
        if (isDirty()) return
        void invoke('notes:get', { id: noteId })
          .then((n) => {
            if (n.updatedAt === save.current.base) return // our own (or already-adopted) save
            if (cleanupBase !== null && !cleanupAccepting.current) {
              // Same belt as below: the other pane rewrote the note under our
              // open Clean Up overlay — its diff is stale, cancel it.
              setCleanupBase(null)
              toast('Note changed — Clean Up cancelled')
            }
            setEpoch((e) => e + 1)
          })
          .catch(() => {
            // Fetch raced a trash/delete — the matching data:changed handles it.
          })
        return
      }
      // Belt for the cleanup staleness guard: any non-user write landing while
      // the overlay is open invalidates its diff — close it (the unmount cancels
      // the session) instead of letting accept fail later. Accept's own push is
      // exempt (cleanupAccepting), and the reload below still runs.
      if (cleanupBase !== null && !cleanupAccepting.current) {
        setCleanupBase(null)
        toast('Note changed — Clean Up cancelled')
      }
      if (isDirty()) setBanner('external')
      else setEpoch((e) => e + 1)
    })
  }, [noteId, isDirty, cleanupBase])

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
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      {banner && (
        <div className="flex items-center justify-between border-b border-hairline bg-[#a98e5f]/15 px-4 py-1.5 text-[12px] text-[#7a653f] dark:bg-[#a98e5f]/15 dark:text-[#cbb68a]">
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
            className="rounded-md bg-[#a98e5f]/25 px-2 py-0.5 font-medium hover:bg-[#a98e5f]/35 dark:bg-[#a98e5f]/30 dark:hover:bg-[#a98e5f]/40"
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
          <div className="flex shrink-0 items-baseline gap-3 text-[11px] text-ink-muted">
            <span>{savedLabel}</span>
            {/* Same path as ⌘⇧U: the FOCUSED NoteView flushes, then opens the
                overlay (the click focused this pane via PaneArea's capture). */}
            <button
              title="Clean Up with AI (⌘⇧U)"
              onClick={() => useUiStore.getState().requestCleanup()}
              className="hover:text-ink"
            >
              🧹 Clean Up
            </button>
            <button
              title="Version History"
              onClick={() => useUiStore.getState().openHistory(noteId)}
              className="hover:text-ink"
            >
              History
            </button>
            <button
              title="Export as Markdown"
              onClick={() => {
                // Flush first so the exported file matches what's on screen.
                void flushRef.current().then(() =>
                  invoke('notes:export', { id: noteId }).then((res) => {
                    if (res.path) toast(`Exported to ${res.path}`)
                  })
                )
              }}
              className="hover:text-ink"
            >
              Export
            </button>
            <div className="relative">
              <button
                title="More"
                onClick={() => setMoreOpen((v) => !v)}
                className="px-0.5 hover:text-ink"
              >
                ⋯
              </button>
              {moreOpen && (
                <>
                  {/* click-away layer under the menu */}
                  <div className="fixed inset-0 z-40" onMouseDown={() => setMoreOpen(false)} />
                  <div className="absolute right-0 top-5 z-50 w-44 rounded-lg border border-hairline bg-surface p-1 shadow-lg">
                    <button
                      onClick={() => {
                        setMoreOpen(false)
                        // Flush first: the template must capture what's on screen.
                        void flushRef.current().then(() => {
                          const md = currentMd() ?? save.current.lastMd
                          return invoke('templates:create', {
                            name: save.current.title.trim() || 'Untitled template',
                            contentMd: md
                          }).then((t) => toast(`Saved template “${t.name}”`))
                        })
                      }}
                      className="w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-ink hover:bg-hover"
                    >
                      Save as template
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
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
              setLiveEditor(e) // the FindBar re-attaches to the new instance
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
      {findOpen && liveEditor && !liveEditor.isDestroyed && (
        <FindBar editor={liveEditor} focusSeq={findFocusSeq} onClose={closeFind} />
      )}
      {cleanupBase !== null && (
        <CleanUpOverlay
          noteId={noteId}
          baseMd={cleanupBase}
          webPaste={cleanupWebPaste}
          acceptingRef={cleanupAccepting}
          onClose={() => setCleanupBase(null)}
        />
      )}
      {/* Modals mount in the FOCUSED pane only — a split tab showing the same
          note in both panes must not render them twice. */}
      {organizeOpen && focused && (
        <OrganizeModal noteId={noteId} onClose={() => useUiStore.getState().closeOrganize()} />
      )}
      {historyOpen && focused && (
        <VersionHistoryModal
          noteId={noteId}
          currentMd={currentMd() ?? normalizeMd(note.contentMd)}
          onClose={() => useUiStore.getState().closeHistory()}
          onRestore={async (versionId) => {
            // Park pending edits first so a stale autosave can't clobber the
            // restored content; the reload then arrives via data:changed
            // (op 'restore' — see the versions:restore handler).
            await flushRef.current()
            await invoke('versions:restore', { versionId })
            useUiStore.getState().closeHistory()
          }}
        />
      )}
    </div>
  )
}
