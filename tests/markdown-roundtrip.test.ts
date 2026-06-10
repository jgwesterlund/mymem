// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/renderer/editor/extensions'

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')

/**
 * Golden-file suite: every fixture is the serializer's own canonical output
 * (authored once through the serializer, then eyeballed). markdown → editor
 * doc → markdown must reproduce it EXACTLY, normalizing the trailing newline
 * only. This is the contract that makes content_md the single source of truth.
 */
function roundtrip(md: string): string {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: buildExtensions(), // same schema/markdown specs as the app, no UI glue
    content: md,
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

const normalize = (s: string): string => `${s.replace(/\n+$/, '')}\n`

describe('markdown round-trip goldens', () => {
  const fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.md'))

  it('has the expected fixture coverage', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(8)
  })

  for (const file of fixtures) {
    it(`round-trips ${file}`, () => {
      const golden = readFileSync(join(FIXTURES_DIR, file), 'utf8')
      expect(normalize(roundtrip(golden))).toBe(normalize(golden))
    })
  }

  it('parses mymem:// links into NoteLink nodes (citation contract)', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions(),
      content: 'See [My note](mymem://note/0190abcd-1234-7000-8000-abcdef012345).',
      contentType: 'markdown'
    })
    try {
      let found: { id: string; label: string } | null = null
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'noteLink') {
          found = { id: String(node.attrs.id), label: String(node.attrs.label) }
        }
      })
      expect(found).toEqual({ id: '0190abcd-1234-7000-8000-abcdef012345', label: 'My note' })
    } finally {
      editor.destroy()
    }
  })

  it('escapes backslashes in NoteLink labels (wire-format round-trip)', () => {
    // A label ending in `\` must serialize as `\\` — a bare trailing backslash
    // would escape the closing bracket and break the mymem:// wire format.
    const wire = 'See [weird\\\\](mymem://note/0190abcd-1234-7000-8000-abcdef012345).'
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions(),
      content: wire,
      contentType: 'markdown'
    })
    try {
      let label: string | null = null
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'noteLink') label = String(node.attrs.label)
      })
      expect(label).toBe('weird\\')
      expect(editor.getMarkdown()).toContain(
        '[weird\\\\](mymem://note/0190abcd-1234-7000-8000-abcdef012345)'
      )
    } finally {
      editor.destroy()
    }
  })

  it('leaves external links as link marks, not NoteLink nodes', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildExtensions(),
      content: 'An [external link](https://example.com).',
      contentType: 'markdown'
    })
    try {
      let noteLinks = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'noteLink') noteLinks++
      })
      expect(noteLinks).toBe(0)
      expect(editor.getMarkdown()).toContain('[external link](https://example.com)')
    } finally {
      editor.destroy()
    }
  })
})
