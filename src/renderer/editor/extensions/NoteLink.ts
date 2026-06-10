import { mergeAttributes, Node, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { createSuggestionRenderer } from '../suggestionUi'

/**
 * Inline atom note-link node — the app-wide citation contract:
 * serializes to `[label](mymem://note/<id>)` and any such markdown link parses
 * back into a NoteLink node (chat citations, backlink extraction and the
 * editor all rely on this exact shape).
 */
export interface NoteLinkOptions {
  /** Click navigation; null in headless/test builds. */
  onNavigate: ((noteId: string, inNewTab: boolean) => void) | null
}

// Anchored at the suggestion-match position by the custom tokenizer below.
const NOTE_LINK_MD = /^\[((?:\\.|[^\]\\])*)\]\(mymem:\/\/note\/([0-9a-f-]+)\)/i

export const NoteLink = Node.create<NoteLinkOptions>({
  name: 'noteLink',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,

  addOptions() {
    return { onNavigate: null }
  },

  addAttributes() {
    return {
      id: { default: '' },
      label: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-note-link]',
        getAttrs: (el) => ({ id: el.getAttribute('data-id') ?? '', label: el.textContent ?? '' })
      }
    ]
  },

  renderHTML({ node }) {
    return [
      'span',
      mergeAttributes({ 'data-note-link': '', 'data-id': String(node.attrs.id), class: 'note-link' }),
      String(node.attrs.label)
    ]
  },

  // A custom marked tokenizer claims `[label](mymem://note/<id>)` BEFORE the
  // built-in link rule (the inline parse path consults only the first handler
  // per token type, so sharing the 'link' token with the Link mark is not an
  // option). External links keep flowing through the Link mark untouched.
  markdownTokenizer: {
    name: 'noteLink',
    level: 'inline',
    start: (src: string) => src.indexOf('['),
    tokenize(src: string) {
      const match = NOTE_LINK_MD.exec(src)
      if (!match) return undefined
      return {
        type: 'noteLink',
        raw: match[0],
        label: match[1]!.replace(/\\([\\[\]])/g, '$1'),
        id: match[2]!
      }
    }
  },

  parseMarkdown(token, helpers) {
    return helpers.createNode('noteLink', { id: String(token.id ?? ''), label: String(token.label ?? '') })
  },

  renderMarkdown(node) {
    // Backslash must be escaped too: a label ending in `\` would otherwise
    // escape the closing bracket and break the wire format.
    const label = String(node.attrs?.label ?? '').replace(/([\\[\]])/g, '\\$1')
    return `[${label}](mymem://note/${String(node.attrs?.id ?? '')})`
  },

  addProseMirrorPlugins() {
    const { onNavigate } = this.options
    if (!onNavigate) return []
    const name = this.name
    return [
      new Plugin({
        key: new PluginKey('noteLinkClick'),
        props: {
          handleClickOn(_view, _pos, node, _nodePos, event) {
            if (node.type.name !== name) return false
            onNavigate(String(node.attrs.id), event.metaKey)
            return true
          }
        }
      })
    ]
  }
})

// ── '@' mention menu ───────────────────────────────────────────────────────────
// search:typeahead ships in M3 — until then items come from the renderer-side
// notes cache filtered by title (prefix matches ranked first).
export interface NoteLinkItem {
  id: string
  title: string
}

export interface NoteLinkSuggestionOptions {
  getItems: (query: string) => NoteLinkItem[]
}

export const NoteLinkSuggestion = Extension.create<NoteLinkSuggestionOptions>({
  name: 'noteLinkSuggestion',

  addOptions() {
    return { getItems: () => [] }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<NoteLinkItem, NoteLinkItem>({
        editor: this.editor,
        pluginKey: new PluginKey('noteLinkSuggestion'),
        char: '@',
        items: ({ query }) => this.options.getItems(query).slice(0, 8),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'noteLink', attrs: { id: props.id, label: props.title || 'Untitled' } },
              { type: 'text', text: ' ' }
            ])
            .run()
        },
        render: createSuggestionRenderer((item) => ({ label: item.title || 'Untitled' }))
      })
    ]
  }
})

/** Default item source for the '@' menu: prefix matches first, then substring. */
export function filterNotesByTitle(notes: NoteLinkItem[], query: string): NoteLinkItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return notes
  const prefix: NoteLinkItem[] = []
  const rest: NoteLinkItem[] = []
  for (const n of notes) {
    const t = n.title.toLowerCase()
    if (t.startsWith(q)) prefix.push(n)
    else if (t.includes(q)) rest.push(n)
  }
  return [...prefix, ...rest]
}
