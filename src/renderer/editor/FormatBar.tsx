import { BubbleMenu } from '@tiptap/react/menus'
import { useEditorState } from '@tiptap/react'
import type { Editor as TipTapEditor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

function Btn({
  active,
  onClick,
  children,
  title
}: {
  active?: boolean
  onClick: () => void
  children: React.ReactNode
  title: string
}): React.JSX.Element {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[12px] leading-5 ${active ? 'bg-accent/15 text-accent' : 'text-ink hover:bg-black/5'}`}
    >
      {children}
    </button>
  )
}

/** Minimal selection format bar (BubbleMenu): bold/italic/strike/code/h1/h2 + note-link removal. */
export function FormatBar({ editor }: { editor: TipTapEditor }): React.JSX.Element {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      noteLink: e.state.selection instanceof NodeSelection && e.state.selection.node.type.name === 'noteLink'
    })
  })

  function removeNoteLink(): void {
    const sel = editor.state.selection
    if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'noteLink') return
    const label = String(sel.node.attrs.label || 'Untitled')
    editor
      .chain()
      .focus()
      .insertContentAt({ from: sel.from, to: sel.to }, { type: 'text', text: label })
      .run()
  }

  return (
    <BubbleMenu editor={editor} className="flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-1 shadow-lg">
      {s.noteLink ? (
        <Btn title="Remove note link" onClick={removeNoteLink}>
          Unlink
        </Btn>
      ) : (
        <>
          <Btn title="Bold" active={s.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <span className="font-bold">B</span>
          </Btn>
          <Btn title="Italic" active={s.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <span className="italic">I</span>
          </Btn>
          <Btn title="Strikethrough" active={s.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
            <span className="line-through">S</span>
          </Btn>
          <Btn title="Inline code" active={s.code} onClick={() => editor.chain().focus().toggleCode().run()}>
            <span className="font-mono">{'<>'}</span>
          </Btn>
          <div className="mx-0.5 h-4 w-px bg-hairline" />
          <Btn title="Heading 1" active={s.h1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
            H1
          </Btn>
          <Btn title="Heading 2" active={s.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            H2
          </Btn>
        </>
      )}
    </BubbleMenu>
  )
}
