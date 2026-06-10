import { describe, expect, it } from 'vitest'
import { sanitizeFtsQuery } from '../src/main/search/searchService'

// The full safe-output contract: only double-quoted quote-free terms joined by
// spaces (implicit AND), with exactly one trailing * on the last term.
const SAFE_SHAPE = /^"[^"]+"(?: "[^"]+")*\*$/

const ADVERSARIAL = [
  '"',
  '""',
  '"phrase query"',
  'x"y',
  'a AND b',
  'AND',
  'NOT a',
  'a OR b OR c',
  'col:x',
  'a:b:c',
  'NEAR(',
  'NEAR(a, b)',
  '-x',
  '--',
  'x*',
  '*',
  '* * *',
  '(a OR b)',
  '()',
  '^start',
  'a + b',
  'a-b',
  '{a b}',
  'MATCH',
  'rank',
  'unicode åäö тест',
  '日本語のメモ',
  '🔥',
  '🔥 emoji 🚀',
  '.',
  '...',
  '!!!',
  '-',
  '\\',
  'a\\b',
  "'; DROP TABLE notes; --",
  'Robert"); DELETE FROM chunks;--',
  '',
  '   ',
  '\t\n',
  'a   b'
]

describe('sanitizeFtsQuery', () => {
  it('every adversarial input is null or matches the safe quoted-terms shape', () => {
    for (const input of ADVERSARIAL) {
      const out = sanitizeFtsQuery(input)
      if (out !== null) expect(out, JSON.stringify(input)).toMatch(SAFE_SHAPE)
    }
  })

  it('empty / punctuation-only / emoji-only input is null', () => {
    for (const input of ['', '   ', '\t\n', '"', '...', '!!!', '-', '()', '* * *', '🔥', '🔥 🚀']) {
      expect(sanitizeFtsQuery(input), JSON.stringify(input)).toBeNull()
    }
  })

  it('appends the prefix star to the last token only', () => {
    expect(sanitizeFtsQuery('hello wor')).toBe('"hello" "wor"*')
    expect(sanitizeFtsQuery('single')).toBe('"single"*')
  })

  it('strips operator syntax but keeps the words (quoted ⇒ inert)', () => {
    expect(sanitizeFtsQuery('(a OR b)')).toBe('"a" "OR" "b"*')
    expect(sanitizeFtsQuery('col:x')).toBe('"col" "x"*')
    expect(sanitizeFtsQuery('NEAR(term')).toBe('"NEAR" "term"*')
    expect(sanitizeFtsQuery('-x')).toBe('"x"*')
    expect(sanitizeFtsQuery('x*')).toBe('"x"*')
  })

  it('keeps unicode terms intact', () => {
    expect(sanitizeFtsQuery('åäö ünïcode')).toBe('"åäö" "ünïcode"*')
    expect(sanitizeFtsQuery('日本語のメモ')).toBe('"日本語のメモ"*')
  })
})
