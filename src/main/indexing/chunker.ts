/**
 * Heading-aware markdown chunker. PURE — no DB or electron imports, so vitest
 * can run it under plain Node.
 *
 * Strategy: split at h1–h3 boundaries into sections (heading texts accumulate
 * into a 'H1 > H2' breadcrumb), then pack each section's blocks (paragraphs,
 * list items; code fences and tables are ATOMIC even when oversized) toward
 * ~TARGET_TOKENS per chunk, hard-capped via sentence-boundary splitting of
 * oversized paragraphs. A trailing fragment under MIN_TAIL_TOKENS merges into
 * the previous chunk of the same section. Chunk text is the raw markdown
 * slice — clean display snippets come from FTS snippet(), never from here.
 */

export interface Chunk {
  idx: number
  headingPath: string
  text: string
}

const TARGET_TOKENS = 400
const HARD_CAP_TOKENS = 512
const MIN_TAIL_TOKENS = 80

/** chars/4 heuristic — used for budgeting only, never to truncate content. */
const tokensOf = (text: string): number => Math.ceil(text.length / 4)

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/
const TABLE_ROW = /^\s*\|/
const LIST_ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s/

interface Block {
  text: string
  atomic: boolean // code fences and tables never split, even oversized
}

export function chunkMarkdown(md: string): Chunk[] {
  if (md.trim() === '') return []
  const lines = md.split('\n')

  // ── Pass 1: split into sections at h1–h3 boundaries (fences are opaque) ─────
  interface Section {
    headingPath: string
    lines: string[]
  }
  const sections: Section[] = [{ headingPath: '', lines: [] }]
  const crumbs: (string | null)[] = [null, null, null]
  let fenceClose: RegExp | null = null

  for (const line of lines) {
    if (fenceClose) {
      sections[sections.length - 1]!.lines.push(line)
      if (fenceClose.test(line)) fenceClose = null
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1]!.length
      crumbs[level - 1] = heading[2]!
      for (let i = level; i < 3; i++) crumbs[i] = null
      const headingPath = crumbs.filter((c): c is string => c !== null).join(' > ')
      sections.push({ headingPath, lines: [line] }) // heading line stays in the raw slice
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const marker = fence[1]!
      fenceClose = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
    }
    sections[sections.length - 1]!.lines.push(line)
  }

  // ── Pass 2: pack each section's blocks into chunks ──────────────────────────
  const packed: { headingPath: string; text: string }[] = []
  for (const section of sections) {
    packSection(section.headingPath, parseBlocks(section.lines), packed)
  }
  return packed.map((c, idx) => ({ idx, headingPath: c.headingPath, text: c.text }))
}

/** Group a section's lines into blocks; only fences and tables are atomic. */
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i++
      continue
    }

    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const marker = fence[1]!
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`)
      const start = i
      i++
      while (i < lines.length && !close.test(lines[i]!)) i++
      if (i < lines.length) i++ // include the closing fence
      blocks.push({ text: lines.slice(start, i).join('\n'), atomic: true })
      continue
    }

    if (TABLE_ROW.test(line)) {
      const start = i
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) i++
      blocks.push({ text: lines.slice(start, i).join('\n'), atomic: true })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item) {
      // One block per list item, including indented continuation/child lines.
      const indent = item[1]!.length
      const start = i
      i++
      while (i < lines.length) {
        const next = lines[i]!
        if (next.trim() === '') break
        const nextItem = LIST_ITEM.exec(next)
        if (nextItem && nextItem[1]!.length <= indent) break // sibling/parent item
        i++
      }
      blocks.push({ text: lines.slice(start, i).join('\n'), atomic: false })
      continue
    }

    // Paragraph (also h4–h6, blockquotes, anything else) — runs to a blank line
    // or the start of a structurally distinct block.
    const start = i
    i++
    while (i < lines.length) {
      const next = lines[i]!
      if (next.trim() === '' || FENCE_OPEN.test(next) || TABLE_ROW.test(next) || LIST_ITEM.test(next)) break
      i++
    }
    blocks.push({ text: lines.slice(start, i).join('\n'), atomic: false })
  }
  return blocks
}

/** Accumulate blocks toward TARGET_TOKENS; flush before crossing it. */
function packSection(
  headingPath: string,
  blocks: Block[],
  out: { headingPath: string; text: string }[]
): void {
  const chunks: string[] = []
  let acc: string[] = []
  let accTokens = 0
  const flush = (): void => {
    if (acc.length === 0) return
    chunks.push(acc.join('\n\n'))
    acc = []
    accTokens = 0
  }

  for (const block of blocks) {
    const blockTokens = tokensOf(block.text)
    if (block.atomic && blockTokens > HARD_CAP_TOKENS) {
      flush()
      chunks.push(block.text) // oversized fences/tables ship whole
      continue
    }
    const pieces =
      !block.atomic && blockTokens > HARD_CAP_TOKENS ? splitAtSentences(block.text) : [block.text]
    for (const piece of pieces) {
      const pieceTokens = tokensOf(piece)
      if (accTokens > 0 && accTokens + pieceTokens > TARGET_TOKENS) flush()
      acc.push(piece)
      accTokens += pieceTokens
    }
  }
  flush()

  // A tiny trailing fragment reads (and embeds) better attached to its
  // predecessor — same section ⇒ same breadcrumb — if the cap allows it.
  const tail = chunks[chunks.length - 1]
  const prev = chunks[chunks.length - 2]
  if (
    tail !== undefined &&
    prev !== undefined &&
    tokensOf(tail) < MIN_TAIL_TOKENS &&
    tokensOf(prev) + tokensOf(tail) <= HARD_CAP_TOKENS
  ) {
    chunks.splice(chunks.length - 2, 2, `${prev}\n\n${tail}`)
  }

  for (const text of chunks) out.push({ headingPath, text })
}

/** Oversized paragraphs split at sentence boundaries; every piece stays ≤ cap. */
function splitAtSentences(text: string): string[] {
  const pieces: string[] = []
  let acc = ''
  const push = (part: string): void => {
    if (acc !== '' && tokensOf(acc) + tokensOf(part) > HARD_CAP_TOKENS) {
      pieces.push(acc)
      acc = ''
    }
    acc = acc === '' ? part : `${acc} ${part}`
  }
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (tokensOf(sentence) > HARD_CAP_TOKENS) {
      // A single sentence busts the cap → hard character split (progress guarantee).
      const maxChars = HARD_CAP_TOKENS * 4
      for (let i = 0; i < sentence.length; i += maxChars) push(sentence.slice(i, i + maxChars))
    } else {
      push(sentence)
    }
  }
  if (acc !== '') pieces.push(acc)
  return pieces
}
