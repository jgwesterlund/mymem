import { Extension } from '@tiptap/core'
import type { Editor, Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import type { Template } from '@shared/types'
import { createSuggestionRenderer } from '../suggestionUi'

export interface SlashItem {
  label: string
  hint?: string
  keywords: string
  run: (editor: Editor, range: Range) => void
}

export interface SlashCommandOptions {
  getTemplates: () => Promise<Template[]>
}

function block(label: string, keywords: string, run: SlashItem['run'], hint?: string): SlashItem {
  return { label, keywords, run, hint }
}

const BLOCKS: SlashItem[] = [
  block('Heading 1', 'h1 heading title', (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run()),
  block('Heading 2', 'h2 heading subtitle', (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run()),
  block('Heading 3', 'h3 heading', (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run()),
  block('Bullet list', 'bullet unordered list ul', (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run()),
  block('Numbered list', 'numbered ordered list ol', (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run()),
  block('Task list', 'task todo checkbox list', (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run()),
  block('Table', 'table grid', (e, r) =>
    e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  ),
  block('Code block', 'code fence snippet', (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run()),
  block('Divider', 'divider hr rule separator', (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run()),
  block('Quote', 'quote blockquote citation', (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run())
]

/** {{cursor}} is stripped: placing the selection after a markdown insert is not trivially mappable. */
function renderTemplate(contentMd: string): string {
  const now = new Date()
  return contentMd
    .replaceAll('{{date}}', now.toLocaleDateString())
    .replaceAll('{{time}}', now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replaceAll('{{cursor}}', '')
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return { getTemplates: async () => [] }
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        items: async ({ query }) => {
          const q = query.trim().toLowerCase()
          const templates = await this.options.getTemplates().catch(() => [] as Template[])
          const templateItems: SlashItem[] = templates.map((t) => ({
            label: t.name,
            hint: 'Template',
            keywords: `template ${t.name.toLowerCase()}`,
            run: (e, r) =>
              e.chain().focus().deleteRange(r).insertContent(renderTemplate(t.contentMd), { contentType: 'markdown' }).run()
          }))
          const all = [...BLOCKS, ...templateItems]
          if (!q) return all
          return all.filter((i) => i.label.toLowerCase().includes(q) || i.keywords.includes(q))
        },
        command: ({ editor, range, props }) => {
          props.run(editor, range)
        },
        render: createSuggestionRenderer((item) => ({ label: item.label, hint: item.hint }))
      })
    ]
  }
})
