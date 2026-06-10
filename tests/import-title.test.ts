import { describe, expect, it } from 'vitest'
import { deriveImport, normalizeLooseTaskLists } from '../src/main/services/importService'

describe('deriveImport — title + content rules', () => {
  it('uses an H1 on the first line as the title and strips it from the content', () => {
    const { title, contentMd } = deriveImport('# Meeting Notes\n\nBody text.', 'meeting')
    expect(title).toBe('Meeting Notes')
    expect(contentMd).toBe('Body text.')
  })

  it('accepts an H1 on the first NON-EMPTY line (leading blank lines)', () => {
    const { title, contentMd } = deriveImport('\n\n# Title Here\nBody.', 'file')
    expect(title).toBe('Title Here')
    expect(contentMd).toBe('Body.')
  })

  it('does NOT strip an H1 that only appears on line 3 (after real text)', () => {
    const raw = 'Intro paragraph.\n\n# Not The Title\n\nMore.'
    const { title, contentMd } = deriveImport(raw, 'my-file')
    expect(title).toBe('my-file')
    expect(contentMd).toBe(raw)
  })

  it("does NOT treat '# ' inside a code fence opening on the first line as a title", () => {
    const raw = '```\n# not a title\n```\nBody.'
    const { title, contentMd } = deriveImport(raw, 'snippet')
    expect(title).toBe('snippet')
    expect(contentMd).toBe(raw)
  })

  it("does NOT treat '## ' (h2) as a title", () => {
    const raw = '## Subheading\nBody.'
    const { title, contentMd } = deriveImport(raw, 'doc')
    expect(title).toBe('doc')
    expect(contentMd).toBe(raw)
  })

  it('falls back to the filename (without extension, passed by the caller) for plain text', () => {
    const { title, contentMd } = deriveImport('just some text', 'shopping-list')
    expect(title).toBe('shopping-list')
    expect(contentMd).toBe('just some text')
  })

  it('normalizes CRLF (and bare CR) to LF, including for H1 detection', () => {
    const { title, contentMd } = deriveImport('# Windows Note\r\n\r\nline one\r\nline two\rend', 'win')
    expect(title).toBe('Windows Note')
    expect(contentMd).toBe('line one\nline two\nend')
    expect(contentMd).not.toContain('\r')
  })
})

describe('normalizeLooseTaskLists — F1 parse-time workaround', () => {
  it('collapses single blank lines between task-list items (the F1 repro)', () => {
    const loose = '- [ ] parent\n\n  - [x] child\n\n  - [ ] child two'
    expect(normalizeLooseTaskLists(loose)).toBe('- [ ] parent\n  - [x] child\n  - [ ] child two')
  })

  it('handles * bullets and unchecked/checked mixes', () => {
    expect(normalizeLooseTaskLists('* [X] a\n\n* [ ] b')).toBe('* [X] a\n* [ ] b')
  })

  it('leaves two-or-more blank lines (a real break) alone', () => {
    const md = '- [ ] a\n\n\n- [ ] b'
    expect(normalizeLooseTaskLists(md)).toBe(md)
  })

  it('does not damage legit blank-line-separated paragraph (non-task) lists', () => {
    const md = '- first paragraph item\n\n- second paragraph item'
    expect(normalizeLooseTaskLists(md)).toBe(md)
  })

  it('does not touch a task item followed by a plain paragraph', () => {
    const md = '- [ ] task\n\nA paragraph after the list.'
    expect(normalizeLooseTaskLists(md)).toBe(md)
  })
})
