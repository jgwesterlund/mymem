import { useMemo, useState } from 'react'
import { BubbleMenu, type BubbleMenuProps } from '@tiptap/react/menus'
import { useEditorState } from '@tiptap/react'
import { isTextSelection, type Editor as TipTapEditor } from '@tiptap/core'
import { toast } from '../stores/ui'

/**
 * Show only for a non-empty TEXT selection in a focused editor (focus may sit
 * inside the bar itself — the link input). Atom selections (note links,
 * images) and table cell drags are NodeSelection/CellSelection, not
 * TextSelection, so they fall out here; code blocks get no formatting bar.
 *
 * NOTE the menu element is appended to EditorContent's wrapper div by the
 * plugin — keep that wrapper's classes scoped to `.editor-prose` (Editor.tsx)
 * or the pill inherits layout meant for the ProseMirror element.
 */
const shouldShow: BubbleMenuProps['shouldShow'] = ({ editor, view, state, from, to, element }) => {
  if (!editor.isEditable) return false
  const { selection } = state
  if (selection.empty || !isTextSelection(selection)) return false
  if (!state.doc.textBetween(from, to).length) return false
  if (editor.isActive('codeBlock')) return false
  return view.hasFocus() || element.contains(document.activeElement)
}

function Btn({
  active,
  onClick,
  children,
  title,
  disabled
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[12px] leading-5 ${
        active ? 'bg-accent/15 text-accent' : disabled ? 'text-ink-muted/40' : 'text-ink hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}

function Divider(): React.JSX.Element {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-hairline" />
}

/** href for the link button: prepend https:// when the user typed a bare domain. */
function normalizeHref(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
}

/** Selection format bar (BubbleMenu): mem-style groups — headings · marks · lists · blocks. */
export function FormatBar({ editor }: { editor: TipTapEditor }): React.JSX.Element {
  // Inline link editing swaps the pill content for a URL input.
  const [linkOpen, setLinkOpen] = useState(false)
  const [url, setUrl] = useState('')

  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      orderedList: e.isActive('orderedList'),
      bulletList: e.isActive('bulletList'),
      taskList: e.isActive('taskList'),
      blockquote: e.isActive('blockquote'),
      link: e.isActive('link'),
      inList: e.isActive('listItem') || e.isActive('taskItem')
    })
  })

  // Stable identity: a fresh object per render would re-dispatch updateOptions
  // into the plugin on every transaction. onHide resets the pill to buttons so
  // a reopened bar never resumes a stale URL input.
  const options = useMemo<BubbleMenuProps['options']>(
    () => ({ placement: 'top', offset: 8, onHide: () => setLinkOpen(false) }),
    []
  )

  function openLink(): void {
    setUrl(String(editor.getAttributes('link').href ?? ''))
    setLinkOpen(true)
  }

  function applyLink(): void {
    const raw = url.trim()
    setLinkOpen(false)
    if (raw === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    const ok = editor.chain().focus().extendMarkRange('link').setLink({ href: normalizeHref(raw) }).run()
    if (!ok) toast('Invalid link URL')
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={shouldShow}
      options={options}
      data-testid="format-bar"
      className="flex w-max items-center gap-0.5 rounded-lg border border-hairline bg-surface p-1 shadow-md"
    >
      {linkOpen ? (
        <input
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              applyLink()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setLinkOpen(false)
              editor.commands.focus()
            }
          }}
          placeholder="Link URL — Enter applies, empty removes"
          className="w-64 bg-transparent px-1.5 py-0.5 text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted/60"
        />
      ) : (
        <>
          <Btn title="Heading 1 (⌘⌥1)" active={s.h1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
            H1
          </Btn>
          <Btn title="Heading 2 (⌘⌥2)" active={s.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            H2
          </Btn>
          <Divider />
          <Btn title="Bold (⌘B)" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </Btn>
          <Btn title="Italic (⌘I)" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </Btn>
          <Btn title="Strikethrough (⌘⇧S)" active={s.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <span className="line-through">S</span>
          </Btn>
          <Btn
            title="Clear formatting"
            onClick={() =>
              // Scoped clear: marks + heading demotion only. clearNodes() would
              // flatten task lists/quotes and silently drop checkbox state.
              editor
                .chain()
                .focus()
                .unsetAllMarks()
                .command(({ commands }) =>
                  editor.isActive('heading') ? commands.setParagraph() : true
                )
                .run()
            }
          >
            ⌧
          </Btn>
          <Btn title="Inline code (⌘E)" active={s.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <span className="font-mono">{'<>'}</span>
          </Btn>
          <Divider />
          <Btn title="Numbered list (⌘⇧7)" active={s.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            1.
          </Btn>
          <Btn title="Bullet list (⌘⇧8)" active={s.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            •
          </Btn>
          <Btn title="Task list (⌘⇧9)" active={s.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()}>
            ☑
          </Btn>
          <Divider />
          <Btn title="Blockquote (⌘⇧B)" active={s.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
            ❝
          </Btn>
          <Btn title="Code block (⌘⌥C)" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
            <span className="font-mono">{'</>'}</span>
          </Btn>
          <Btn title={s.link ? 'Edit link' : 'Add link'} active={s.link} onClick={openLink}>
            🔗
          </Btn>
          <Btn
            title={s.inList || s.blockquote ? 'Tables cannot be inserted inside lists or quotes' : 'Insert table'}
            disabled={s.inList || s.blockquote}
            onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            ⊞
          </Btn>
        </>
      )}
    </BubbleMenu>
  )
}
