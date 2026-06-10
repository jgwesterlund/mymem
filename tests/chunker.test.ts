import { describe, expect, it } from 'vitest'
import { chunkMarkdown } from '../src/main/indexing/chunker'

/** Same chars/4 heuristic the chunker budgets with. */
const tokensOf = (s: string): number => Math.ceil(s.length / 4)

/** A single-line paragraph of roughly `chars` characters (~chars/4 tokens). */
function para(seed: string, chars = 400): string {
  const word = `${seed}word `
  return word.repeat(Math.ceil(chars / word.length)).slice(0, chars).trim()
}

describe('chunkMarkdown', () => {
  it('returns [] for empty and whitespace-only docs', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('   \n\n\t\n')).toEqual([])
  })

  it('produces breadcrumb heading paths at h1–h3 boundaries; h4+ stays in its section', () => {
    const md = [
      '# Alpha',
      '',
      'intro text here',
      '',
      '## Beta',
      '',
      'beta body',
      '',
      '### Gamma',
      '',
      'gamma body',
      '',
      '#### Delta',
      '',
      'delta body stays in gamma',
      '',
      '# Omega',
      '',
      'omega body'
    ].join('\n')
    const chunks = chunkMarkdown(md)
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Alpha',
      'Alpha > Beta',
      'Alpha > Beta > Gamma',
      'Omega'
    ])
    expect(chunks[0]!.text).toContain('# Alpha') // raw slice keeps the heading line
    expect(chunks[2]!.text).toContain('#### Delta') // h4 is content, not a boundary
    expect(chunks[2]!.text).toContain('delta body stays in gamma')
  })

  it('keeps an oversized code fence atomic (whole, fences intact)', () => {
    const body = 'const value = 12345\n'.repeat(150) // ~3000 chars ≈ 750 tokens > cap
    const md = `intro paragraph\n\n\`\`\`js\n${body}\`\`\`\n\nafter text`
    const chunks = chunkMarkdown(md)
    const withFence = chunks.filter((c) => c.text.includes('```'))
    expect(withFence).toHaveLength(1) // never split across chunks
    expect(withFence[0]!.text.startsWith('```js')).toBe(true)
    expect(withFence[0]!.text.trimEnd().endsWith('```')).toBe(true)
    expect(tokensOf(withFence[0]!.text)).toBeGreaterThan(512)
  })

  it('keeps an oversized table atomic', () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| cell${i} | value${i} |`)
    const md = `| h1 | h2 |\n| --- | --- |\n${rows.join('\n')}`
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(tokensOf(chunks[0]!.text)).toBeGreaterThan(512)
  })

  it('merges a tiny trailing fragment into the previous chunk', () => {
    const big = para('lead', 1580) // ~395 tokens
    const tiny = para('tail', 120) // ~30 tokens: crosses target, lands under the 80 floor
    const chunks = chunkMarkdown(`${big}\n\n${tiny}`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toContain('tailword')
  })

  it('packs paragraphs toward ~400 tokens without crossing the 512 cap', () => {
    const paras = Array.from({ length: 10 }, (_, i) => para(`p${i}`, 400)) // ~100 tokens each
    const chunks = chunkMarkdown(paras.join('\n\n'))
    expect(chunks).toHaveLength(3) // 4 + 4 + 2 paragraphs
    for (const c of chunks) expect(tokensOf(c.text)).toBeLessThanOrEqual(512)
    expect(tokensOf(chunks[0]!.text)).toBeGreaterThanOrEqual(300) // actually packed, not 1/chunk
  })

  it('splits an oversized paragraph at sentence boundaries under the cap', () => {
    const sentence = 'This is a reasonably long sentence about chunking behavior in myMem. '
    const blob = sentence.repeat(45).trim() // ~3150 chars ≈ 790 tokens, one paragraph
    const chunks = chunkMarkdown(blob)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(tokensOf(c.text)).toBeLessThanOrEqual(512)
      expect(c.text.endsWith('.')).toBe(true) // cut at sentence boundaries
    }
  })

  it('assigns stable sequential idx values', () => {
    const md = ['# One', '', para('a'), '', '## Two', '', para('b'), '', '# Three', '', para('c')].join('\n')
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    expect(chunks.map((c) => c.idx)).toEqual(chunks.map((_, i) => i))
  })
})
