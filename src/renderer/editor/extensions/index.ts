import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Image } from '@tiptap/extension-image'
import { Table, TableRow, TableHeader, TableCell, renderTableToMarkdown } from '@tiptap/extension-table'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { Placeholder } from '@tiptap/extension-placeholder'
import { UniqueID } from '@tiptap/extension-unique-id'
import { common, createLowlight } from 'lowlight'
import type { AnyExtension } from '@tiptap/core'
import type { Template } from '@shared/types'
import { NoteLink, NoteLinkSuggestion, type NoteLinkItem } from './NoteLink'
import { SlashCommand } from './SlashCommand'
import { CollectionTagSuggestion, type CollectionTagItem } from './CollectionTag'

const lowlight = createLowlight(common)

// Literal `|` in a cell must serialize as `\|` or the reload splits the cell at
// the pipe. GFM unescapes `\|` before inline lexing (even inside code spans),
// so escaping every pipe in the rendered cell text round-trips exactly.
const TableWithPipeEscapes = Table.extend({
  renderMarkdown(node, h) {
    return renderTableToMarkdown(node, {
      ...h,
      renderChildren: (nodes, separator) => h.renderChildren(nodes, separator).replace(/\|/g, '\\|')
    })
  }
})

// The stock renderer always emits ``` fences; content containing a ``` run
// would truncate the block on reload. Fence = longest backtick run + 1.
const CodeBlockWithSafeFences = CodeBlockLowlight.extend({
  renderMarkdown(node, h) {
    const language = String(node.attrs?.language ?? '')
    if (!node.content) return `\`\`\`${language}\n\n\`\`\``
    const content = h.renderChildren(node.content)
    const longestRun = content.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0
    const fence = '`'.repeat(Math.max(3, longestRun + 1))
    return [`${fence}${language}`, content, fence].join('\n')
  }
})

/**
 * Renderer-side glue injected into the interactive editor build. The markdown
 * round-trip tests call buildExtensions() WITHOUT glue: same schema + markdown
 * specs, no suggestion menus, no UniqueID churn, no click navigation.
 */
export interface EditorGlue {
  onNavigateToNote: (noteId: string, inNewTab: boolean) => void
  getNoteLinkItems: (query: string) => NoteLinkItem[]
  getTemplates: () => Promise<Template[]>
  getCollections: () => CollectionTagItem[]
  onAddToCollection: (collection: CollectionTagItem) => void
}

export function buildExtensions(glue?: EditorGlue): AnyExtension[] {
  const base: AnyExtension[] = [
    StarterKit.configure({
      codeBlock: false, // replaced by CodeBlockLowlight
      underline: false, // no clean markdown serialization — markdown-first contract
      link: { openOnClick: false }
    }),
    Markdown,
    // Inline so `text ![img](url) text` keeps its paragraph; `![alt](url)`
    // markdown must round-trip losslessly (content_md is the single truth).
    Image.configure({ inline: true }),
    TableWithPipeEscapes,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    CodeBlockWithSafeFences.configure({ lowlight }),
    NoteLink.configure({ onNavigate: glue ? glue.onNavigateToNote : null })
  ]

  if (!glue) return base

  return [
    ...base,
    Placeholder.configure({ placeholder: 'Write something…' }),
    // IDs anchor fold state/diffs/deep links later; they do NOT survive the
    // markdown round-trip (known plan constraint — no fold persistence).
    UniqueID.configure({
      types: ['heading', 'paragraph', 'listItem', 'taskItem', 'codeBlock', 'blockquote', 'table']
    }),
    NoteLinkSuggestion.configure({ getItems: glue.getNoteLinkItems }),
    SlashCommand.configure({ getTemplates: glue.getTemplates }),
    CollectionTagSuggestion.configure({
      getCollections: glue.getCollections,
      onSelect: glue.onAddToCollection
    })
  ]
}
