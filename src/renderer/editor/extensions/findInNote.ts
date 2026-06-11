import { Extension } from '@tiptap/core'
import type { Editor as TipTapEditor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Find-in-note (Cmd+F): a decoration-only ProseMirror plugin — all matches get
 * a highlight, the current one a distinct style. Case-insensitive, no replace
 * (v1). The FindBar UI in NoteView drives it through the meta helpers below.
 */
export interface FindMatch {
  from: number
  to: number
}

export interface FindState {
  query: string
  matches: FindMatch[]
  index: number
}

type FindMeta =
  | { type: 'set'; query: string }
  | { type: 'move'; dir: 1 | -1 }
  | { type: 'clear' }

const EMPTY: FindState = { query: '', matches: [], index: 0 }

export const findPluginKey = new PluginKey<FindState>('findInNote')

/** Per-text-node scan (matches never span block boundaries — fine for v1). */
function computeMatches(doc: PMNode, query: string): FindMatch[] {
  const q = query.toLowerCase()
  if (!q) return []
  const matches: FindMatch[] = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const text = node.text.toLowerCase()
    let i = text.indexOf(q)
    while (i !== -1) {
      matches.push({ from: pos + i, to: pos + i + q.length })
      i = text.indexOf(q, i + q.length)
    }
    return true
  })
  return matches
}

export const FindInNote = Extension.create({
  name: 'findInNote',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findPluginKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            const meta = tr.getMeta(findPluginKey) as FindMeta | undefined
            if (meta?.type === 'clear') return EMPTY
            if (meta?.type === 'set') {
              const matches = computeMatches(tr.doc, meta.query)
              return { query: meta.query, matches, index: 0 }
            }
            if (meta?.type === 'move' && prev.matches.length > 0) {
              const n = prev.matches.length
              return { ...prev, index: (prev.index + meta.dir + n) % n }
            }
            if (tr.docChanged && prev.query) {
              // Recompute against the new doc; clamp the cursor into range.
              const matches = computeMatches(tr.doc, prev.query)
              return { ...prev, matches, index: Math.min(prev.index, Math.max(0, matches.length - 1)) }
            }
            return prev
          }
        },
        props: {
          decorations(state) {
            const s = findPluginKey.getState(state)
            if (!s || s.matches.length === 0) return null
            return DecorationSet.create(
              state.doc,
              s.matches.map((m, i) =>
                Decoration.inline(m.from, m.to, {
                  class: i === s.index ? 'find-match find-match-current' : 'find-match'
                })
              )
            )
          }
        }
      })
    ]
  }
})

export function getFindState(editor: TipTapEditor): FindState {
  return findPluginKey.getState(editor.state) ?? EMPTY
}

function dispatchMeta(editor: TipTapEditor, meta: FindMeta): void {
  editor.view.dispatch(editor.state.tr.setMeta(findPluginKey, meta))
}

function scrollCurrentIntoView(editor: TipTapEditor): void {
  const s = getFindState(editor)
  const match = s.matches[s.index]
  if (!match) return
  try {
    const dom = editor.view.domAtPos(match.from)
    const el = dom.node instanceof Element ? dom.node : dom.node.parentElement
    el?.scrollIntoView({ block: 'center' })
  } catch {
    // Position raced a doc change — the next set/move rescrolls.
  }
}

export function setFindQuery(editor: TipTapEditor, query: string): void {
  dispatchMeta(editor, { type: 'set', query })
  scrollCurrentIntoView(editor)
}

export function moveFind(editor: TipTapEditor, dir: 1 | -1): void {
  dispatchMeta(editor, { type: 'move', dir })
  scrollCurrentIntoView(editor)
}

export function clearFind(editor: TipTapEditor): void {
  dispatchMeta(editor, { type: 'clear' })
}
