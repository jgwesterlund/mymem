import { useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import { invoke } from '../api'
import { useTabsStore } from '../stores/tabs'
import { useNotesStore } from '../stores/notes'
import { useCollectionsStore } from '../stores/collections'
import { toast } from '../stores/ui'
import { buildExtensions, type EditorGlue } from './extensions'
import { filterNotesByTitle } from './extensions/NoteLink'
import { FormatBar } from './FormatBar'
import { SuggestionPopup } from './SuggestionPopup'

export interface EditorProps {
  noteId: string
  initialMd: string
  onDocChanged: (editor: TipTapEditor) => void
  onEditorBlur: () => void
  onReady: (editor: TipTapEditor) => void
}

/** One TipTap instance per mounted NoteView; remounted (fresh undo history) via key. */
export default function Editor({ noteId, initialMd, onDocChanged, onEditorBlur, onReady }: EditorProps): React.JSX.Element {
  const extensions = useMemo(() => {
    const glue: EditorGlue = {
      onNavigateToNote(targetId, inNewTab) {
        const tabs = useTabsStore.getState()
        if (inNewTab) tabs.openTab({ kind: 'note', noteId: targetId })
        else tabs.openInCurrentTab({ kind: 'note', noteId: targetId })
      },
      getNoteLinkItems(query) {
        const notes = useNotesStore
          .getState()
          .items.filter((n) => n.id !== noteId)
          .map((n) => ({ id: n.id, title: n.title }))
        return filterNotesByTitle(notes, query)
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
      attributes: { class: 'editor-prose' }
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
