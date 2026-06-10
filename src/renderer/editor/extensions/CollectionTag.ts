import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { createSuggestionRenderer } from '../suggestionUi'

/**
 * '#' collection menu. DIVERGENCE FROM MEM (deliberate, v1): mem inserts an
 * inline collection chip into the document, but the markdown round-trip for a
 * collection chip is undefined (content_md is the single source of truth), so
 * selecting a collection here acts as a COMMAND ONLY — it adds the note to the
 * collection via collections:setForNote, removes the '#query' text and inserts
 * nothing into the doc. Feedback is a toast ("Added to <collection>").
 */
export interface CollectionTagItem {
  id: string
  name: string
}

export interface CollectionTagOptions {
  getCollections: () => CollectionTagItem[]
  onSelect: (collection: CollectionTagItem) => void
}

export const CollectionTagSuggestion = Extension.create<CollectionTagOptions>({
  name: 'collectionTagSuggestion',

  addOptions() {
    return { getCollections: () => [], onSelect: () => {} }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<CollectionTagItem, CollectionTagItem>({
        editor: this.editor,
        pluginKey: new PluginKey('collectionTagSuggestion'),
        char: '#',
        // Typing '# ' headings must not open the menu: '#' as the FIRST character
        // of a textblock means heading, so tagging works anywhere but column 0.
        allow: ({ state, range }) => range.from > state.doc.resolve(range.from).start(),
        items: ({ query }) => {
          const q = query.trim().toLowerCase()
          const all = this.options.getCollections()
          return (q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all).slice(0, 8)
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run()
          this.options.onSelect(props)
        },
        render: createSuggestionRenderer((item) => ({ label: item.name, hint: 'Collection' }))
      })
    ]
  }
})
