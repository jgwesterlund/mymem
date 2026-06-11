import { describe, expect, it } from 'vitest'
import { buildDiffDoc, splitBlocks } from '@renderer/editor/diff/buildDiffDoc'
import type { DiffBlock } from '@renderer/editor/diff/buildDiffDoc'

const joined = (b: DiffBlock): string => b.segments.map((s) => s.text).join('')
const typesOf = (b: DiffBlock): string[] => [...new Set(b.segments.map((s) => s.type))]

describe('splitBlocks', () => {
  it('splits on blank lines', () => {
    const blocks = splitBlocks('# Title\n\npara one\nstill para one\n\npara two')
    expect(blocks.map((b) => b.text)).toEqual(['# Title', 'para one\nstill para one', 'para two'])
    expect(blocks.every((b) => !b.code)).toBe(true)
  })

  it('keeps a fence with internal blank lines as ONE code block', () => {
    const md = 'before\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\nafter'
    const blocks = splitBlocks(md)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toEqual({ text: '```js\nconst a = 1\n\nconst b = 2\n```', code: true })
    expect(blocks[0]!.code).toBe(false)
    expect(blocks[2]!.code).toBe(false)
  })

  it('treats ``` inside a ~~~ fence as content and survives an unterminated fence', () => {
    const blocks = splitBlocks('~~~\n```\nnot a fence\n~~~\n\ntail\n\n```\ndangling')
    expect(blocks[0]).toEqual({ text: '~~~\n```\nnot a fence\n~~~', code: true })
    expect(blocks[1]).toEqual({ text: 'tail', code: false })
    expect(blocks[2]).toEqual({ text: '```\ndangling', code: true })
  })
})

describe('buildDiffDoc', () => {
  it('marks identical documents as all-same', () => {
    const md = '# A\n\nhello world\n\n- one\n- two'
    const blocks = buildDiffDoc(md, md)
    expect(blocks).toHaveLength(3)
    for (const b of blocks) expect(typesOf(b)).toEqual(['same'])
    expect(blocks.map(joined)).toEqual(['# A', 'hello world', '- one\n- two'])
  })

  it('emits del for removed and ins for added blocks', () => {
    const base = 'keep me\n\ndrop me'
    const cleaned = 'keep me\n\nbrand new paragraph here'
    const blocks = buildDiffDoc(base, cleaned)
    expect(typesOf(blocks[0]!)).toEqual(['same'])
    // 'drop me' vs the new paragraph is a changed PAIR → word-level inside
    const changed = blocks[1]!
    expect(changed.segments.some((s) => s.type === 'del')).toBe(true)
    expect(changed.segments.some((s) => s.type === 'ins')).toBe(true)
  })

  it('pure insertion and pure deletion stay whole-block', () => {
    const ins = buildDiffDoc('a\n\nc', 'a\n\nb\n\nc')
    expect(ins.map((b) => typesOf(b).join(''))).toEqual(['same', 'ins', 'same'])
    expect(joined(ins[1]!)).toBe('b')

    const del = buildDiffDoc('a\n\nb\n\nc', 'a\n\nc')
    expect(del.map((b) => typesOf(b).join(''))).toEqual(['same', 'del', 'same'])
    expect(joined(del[1]!)).toBe('b')
  })

  it('word-diffs inside a changed pair and keeps unchanged words same', () => {
    const blocks = buildDiffDoc('the quick brown fox', 'the quick red fox')
    expect(blocks).toHaveLength(1)
    const segs = blocks[0]!.segments
    expect(segs.find((s) => s.type === 'del')?.text).toBe('brown')
    expect(segs.find((s) => s.type === 'ins')?.text).toBe('red')
    // reassembled new text = ins + same segments
    expect(segs.filter((s) => s.type !== 'del').map((s) => s.text).join('')).toBe('the quick red fox')
    // reassembled old text = del + same segments
    expect(segs.filter((s) => s.type !== 'ins').map((s) => s.text).join('')).toBe('the quick brown fox')
  })

  it('never word-diffs code blocks — a changed fence is del+ins wholesale', () => {
    const base = 'intro\n\n```js\nconst a = 1\n```'
    const cleaned = 'intro\n\n```js\nconst a = 2\n```'
    const blocks = buildDiffDoc(base, cleaned)
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'code', 'code'])
    expect(typesOf(blocks[1]!)).toEqual(['del'])
    expect(typesOf(blocks[2]!)).toEqual(['ins'])
    expect(joined(blocks[1]!)).toContain('const a = 1')
    expect(joined(blocks[2]!)).toContain('const a = 2')
  })

  it('anchors around an unchanged code block (fence-aware split)', () => {
    const base = 'before old\n\n```\nfixed code\n```\n\nafter old'
    const cleaned = 'before new\n\n```\nfixed code\n```\n\nafter new'
    const blocks = buildDiffDoc(base, cleaned)
    expect(blocks).toHaveLength(3)
    expect(blocks[1]!.kind).toBe('code')
    expect(typesOf(blocks[1]!)).toEqual(['same'])
    expect(typesOf(blocks[0]!).sort()).toEqual(['del', 'ins', 'same'])
    expect(typesOf(blocks[2]!).sort()).toEqual(['del', 'ins', 'same'])
  })

  it('falls back to wholesale del+ins for oversized changed pairs (no word diff)', () => {
    // Either side > 2000 chars → the word diff is skipped, never attempted.
    const oldBig = 'alpha beta gamma '.repeat(150).trim() // ~2550 chars
    const newBig = 'delta beta omega '.repeat(150).trim()
    const blocks = buildDiffDoc(`anchor\n\n${oldBig}`, `anchor\n\n${newBig}`)
    expect(blocks.map((b) => typesOf(b).join(''))).toEqual(['same', 'del', 'ins'])
    // Block-level only: each changed block is a single un-mixed segment…
    expect(blocks[1]!.segments).toEqual([{ type: 'del', text: oldBig }])
    expect(blocks[2]!.segments).toEqual([{ type: 'ins', text: newBig }])
    // …and the reassembly property still holds across blocks.
    const olds = blocks.filter((b) => typesOf(b).join('') !== 'ins').map(joined)
    const news = blocks.filter((b) => typesOf(b).join('') !== 'del').map(joined)
    expect(olds.join('\n\n')).toBe(`anchor\n\n${oldBig}`)
    expect(news.join('\n\n')).toBe(`anchor\n\n${newBig}`)
  })

  it('skips the block LCS above the cell cap and emits naive del-all + ins-all', () => {
    const doc = (word: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${word} paragraph ${i}`).join('\n\n')
    const base = doc('old', 600)
    const cleaned = doc('new', 600) // 600×600 = 360k cells > 250k cap
    const blocks = buildDiffDoc(base, cleaned)
    expect(blocks).toHaveLength(1200)
    expect(blocks.slice(0, 600).every((b) => typesOf(b).join('') === 'del')).toBe(true)
    expect(blocks.slice(600).every((b) => typesOf(b).join('') === 'ins')).toBe(true)
    // Reassembly: the del blocks rebuild the old doc, the ins blocks the new one.
    expect(blocks.slice(0, 600).map(joined).join('\n\n')).toBe(base)
    expect(blocks.slice(600).map(joined).join('\n\n')).toBe(cleaned)
  })

  it('pairs multi-block changed runs index-wise', () => {
    const base = 'anchor\n\nfirst old para\n\nsecond old para\n\nend'
    const cleaned = 'anchor\n\nfirst new para\n\nsecond new para\n\nend'
    const blocks = buildDiffDoc(base, cleaned)
    expect(blocks).toHaveLength(4)
    expect(joined(blocks[1]!)).toContain('first')
    expect(joined(blocks[2]!)).toContain('second')
    expect(blocks[1]!.segments.some((s) => s.type === 'ins' && s.text.includes('new'))).toBe(true)
    expect(blocks[2]!.segments.some((s) => s.type === 'ins' && s.text.includes('new'))).toBe(true)
  })
})
