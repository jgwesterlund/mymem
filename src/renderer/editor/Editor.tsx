import { useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import { invoke } from '../api'
import { getActiveContent, openContent } from '../stores/tabs'
import { useCollectionsStore } from '../stores/collections'
import { toast, useUiStore } from '../stores/ui'
import { buildExtensions, type EditorGlue } from './extensions'
import { shouldNudgeForPaste } from './pasteNudge'
import { FormatBar } from './FormatBar'
import { SuggestionPopup } from './SuggestionPopup'

export interface EditorProps {
  noteId: string
  initialMd: string
  onDocChanged: (editor: TipTapEditor) => void
  onEditorBlur: () => void
  onReady: (editor: TipTapEditor) => void
}

/** Notes already nudged about a big paste — max one Clean Up nudge per note per session. */
const pasteNudged = new Set<string>()

/** One TipTap instance per mounted NoteView; remounted (fresh undo history) via key. */
export default function Editor({ noteId, initialMd, onDocChanged, onEditorBlur, onReady }: EditorProps): React.JSX.Element {
  const extensions = useMemo(() => {
    const glue: EditorGlue = {
      onNavigateToNote(targetId, target) {
        openContent({ kind: 'note', noteId: targetId }, target)
      },
      async getNoteLinkItems(query) {
        const hits = await invoke('search:typeahead', { q: query })
        return hits.filter((h) => h.noteId !== noteId).map((h) => ({ id: h.noteId, title: h.title }))
      },
      getTemplates: () => invoke('templates:list'),
      getCollections: () => useCollectionsStore.getState().items.map((c) => ({ id: c.id, name: c.name })),
      onAddToCollection(collection) {
        void (async () => {
          const note = await invoke('notes:get', { id: noteId })
          if (!note.collectionIds.includes(collection.id)) {
            await invoke('collections:setForNote', {
              noteId,
              collectionIds: [...note.collectionIds, collection.id]
            })
          }
          toast(`Added to ${collection.name}`)
        })()
      }
    }
    return buildExtensions(glue)
    // noteId is fixed for the lifetime of a mount (keyed by the parent).
  }, [noteId])

  const editor = useEditor({
    extensions,
    content: initialMd,
    contentType: 'markdown',
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'editor-prose' },
      // Nudge only — returning false leaves TipTap's paste handling (the
      // Markdown extension's HTML→markdown parsing included) untouched.
      handlePaste: (_view, event) => {
        const data = event.clipboardData
        const pasted = data?.getData('text/plain') || data?.getData('text/html') || ''
        if (shouldNudgeForPaste(pasted, pasteNudged.has(noteId))) {
          pasteNudged.add(noteId)
          // Capture the note the paste landed in: the toast lingers ~8 s and the
          // user may have moved to another note/tab — requestCleanup targets the
          // FOCUSED pane, which would clean the WRONG note.
          const pastedNoteId = noteId
          useUiStore.getState().showToast('Pasted content — clean it up?', {
            label: 'Clean Up',
            onClick: () => {
              const active = getActiveContent()
              if (active?.kind === 'note' && active.noteId === pastedNoteId) {
                useUiStore.getState().requestCleanup(true) // webPaste: debris stripping allowed
              } else {
                // Bring the pasted note back instead of cleaning whatever is
                // focused now (opening + auto-running would race the note load).
                openContent({ kind: 'note', noteId: pastedNoteId }, 'self')
                toast('Opened the pasted note — press ⌘⇧U to clean it up')
              }
            }
          })
        }
        return false
      }
    },
    onCreate: ({ editor: e }) => onReady(e),
    onUpdate: ({ editor: e }) => onDocChanged(e),
    onBlur: () => onEditorBlur()
  })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {editor && <FormatBar editor={editor} />}
      <EditorContent editor={editor} className="flex-1 [&>div]:h-full" />
      <SuggestionPopup />
    </div>
  )
}
