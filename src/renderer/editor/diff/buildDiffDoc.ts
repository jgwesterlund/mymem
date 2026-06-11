import { diffWordsWithSpace } from 'diff'

/**
 * Clean Up diff model (PURE — vitest runs it under plain Node).
 *
 * Decision (v1 cut, documented): the plan's merged TipTap diff-doc with
 * diffInsert/diffDelete marks is heavy — instead the overlay renders the diff
 * as a READ-ONLY styled segment view: raw markdown text per block with
 * <ins>/<del> inline highlights, paragraphs as wrapped text blocks with the
 * editor typography and code fences in monospace <pre>. Readable, robust, and
 * exactly what accept will write (no markdown→rich→markdown roundtrip risk).
 *
 * Pipeline: split both sides into blocks on blank lines OUTSIDE code fences
 * (fences stay atomic) → block-level LCS → adjacent del/ins runs are paired
 * index-wise and word-diffed (diffWordsWithSpace) → flat list of render
 * blocks, each holding inline same/del/ins segments.
 *
 * Pathology guards (the renderer must never freeze on a hostile/huge note):
 * word diff is skipped for pairs where either side exceeds 2000 chars and is
 * time-boxed at 150 ms otherwise (both fall back to wholesale del+ins blocks);
 * the block LCS (n·m DP cells) is skipped above 250k cells in favour of a
 * naive del-all + ins-all rendering.
 */

export interface InlineSegment {
  type: 'same' | 'del' | 'ins'
  text: string
}

export interface DiffBlock {
  /** code → render monospace <pre>; text → wrapped paragraph block. */
  kind: 'code' | 'text'
  segments: InlineSegment[]
}

interface Block {
  text: string
  code: boolean
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

/** Split markdown into blocks on blank lines outside fences; a fence is ONE block. */
export function splitBlocks(md: string): Block[] {
  const blocks: Block[] = []
  const lines = md.split('\n')
  let acc: string[] = []
  let accCode = false
  let fenceClose: RegExp | null = null

  const flush = (): void => {
    if (acc.length === 0) return
    blocks.push({ text: acc.join('\n'), code: accCode })
    acc = []
    accCode = false
  }

  for (const line of lines) {
    if (fenceClose) {
      acc.push(line)
      if (fenceClose.test(line)) {
        fenceClose = null
        flush()
      }
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]!
      fenceClose = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
      acc.push(line)
      accCode = true
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    acc.push(line)
  }
  flush() // also closes an unterminated fence at EOF
  return blocks
}

type Op = { op: 'same'; a: Block } | { op: 'del'; a: Block } | { op: 'ins'; b: Block }

/** Classic LCS DP over block texts — notes are hard-capped upstream, so n·m stays small. */
function lcsOps(a: Block[], b: Block[]): Op[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i]!.text === b[j]!.text
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i]!.text === b[j]!.text) {
      ops.push({ op: 'same', a: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: 'del', a: a[i]! })
      i++
    } else {
      ops.push({ op: 'ins', b: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ op: 'del', a: a[i++]! })
  while (j < m) ops.push({ op: 'ins', b: b[j++]! })
  return ops
}

/** Word diff guards: jsdiff is worst-case quadratic-ish — cap input size and time. */
const WORD_DIFF_MAX_CHARS = 2000
const WORD_DIFF_TIMEOUT_MS = 150
/** LCS DP allocates (n+1)·(m+1) cells — above this the alignment is skipped. */
const MAX_LCS_CELLS = 250_000

/**
 * Word-level diff of a changed block pair → inline segments; null when the
 * pair is too large or the diff times out (caller falls back to wholesale
 * del+ins blocks).
 */
function wordSegments(oldText: string, newText: string): InlineSegment[] | null {
  if (oldText.length > WORD_DIFF_MAX_CHARS || newText.length > WORD_DIFF_MAX_CHARS) return null
  const parts = diffWordsWithSpace(oldText, newText, { timeout: WORD_DIFF_TIMEOUT_MS })
  if (parts === undefined) return null // timed out
  return parts.map((p) => ({
    type: p.added ? 'ins' : p.removed ? 'del' : 'same',
    text: p.value
  }))
}

export function buildDiffDoc(baseMd: string, cleanedMd: string): DiffBlock[] {
  const a = splitBlocks(baseMd)
  const b = splitBlocks(cleanedMd)
  // Pathological block counts: skip the LCS alignment (and per-pair word diffs)
  // entirely — render everything old as deleted, everything new as inserted.
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map((blk): DiffBlock => ({ kind: blk.code ? 'code' : 'text', segments: [{ type: 'del', text: blk.text }] })),
      ...b.map((blk): DiffBlock => ({ kind: blk.code ? 'code' : 'text', segments: [{ type: 'ins', text: blk.text }] }))
    ]
  }
  const ops = lcsOps(a, b)
  const out: DiffBlock[] = []

  let k = 0
  while (k < ops.length) {
    const op = ops[k]!
    if (op.op === 'same') {
      out.push({ kind: op.a.code ? 'code' : 'text', segments: [{ type: 'same', text: op.a.text }] })
      k++
      continue
    }
    // Collect the contiguous run of del then ins between two anchors.
    const dels: Block[] = []
    const inss: Block[] = []
    while (k < ops.length && ops[k]!.op !== 'same') {
      const cur = ops[k]!
      if (cur.op === 'del') dels.push(cur.a)
      else if (cur.op === 'ins') inss.push(cur.b)
      k++
    }
    // Pair i-th deletion with i-th insertion for word-level diff — but only
    // text↔text pairs (code blocks are atomic: replaced wholesale, never
    // word-diffed — cleanup must keep them verbatim anyway). Oversized or
    // timed-out text pairs degrade to the same wholesale del+ins shape.
    const pairs = Math.min(dels.length, inss.length)
    for (let p = 0; p < pairs; p++) {
      const d = dels[p]!
      const ins = inss[p]!
      const segments = d.code || ins.code ? null : wordSegments(d.text, ins.text)
      if (segments === null) {
        out.push({ kind: d.code ? 'code' : 'text', segments: [{ type: 'del', text: d.text }] })
        out.push({ kind: ins.code ? 'code' : 'text', segments: [{ type: 'ins', text: ins.text }] })
      } else {
        out.push({ kind: 'text', segments })
      }
    }
    for (let p = pairs; p < dels.length; p++) {
      out.push({ kind: dels[p]!.code ? 'code' : 'text', segments: [{ type: 'del', text: dels[p]!.text }] })
    }
    for (let p = pairs; p < inss.length; p++) {
      out.push({ kind: inss[p]!.code ? 'code' : 'text', segments: [{ type: 'ins', text: inss[p]!.text }] })
    }
  }
  return out
}
