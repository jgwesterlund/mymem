import { describe, expect, it } from 'vitest'
import { PASTE_NUDGE_MIN_CHARS, shouldNudgeForPaste } from '../src/renderer/editor/pasteNudge'

/**
 * Paste-nudge threshold (v1.1): big pastes get ONE "clean it up?" toast per
 * note per session. The Set bookkeeping lives in Editor.tsx; the decision is
 * this pure function.
 */
describe('shouldNudgeForPaste', () => {
  it('nudges for pastes longer than the threshold', () => {
    expect(shouldNudgeForPaste('x'.repeat(PASTE_NUDGE_MIN_CHARS + 1), false)).toBe(true)
  })

  it('ignores pastes at or below the threshold', () => {
    expect(shouldNudgeForPaste('x'.repeat(PASTE_NUDGE_MIN_CHARS), false)).toBe(false)
    expect(shouldNudgeForPaste('short snippet', false)).toBe(false)
    expect(shouldNudgeForPaste('', false)).toBe(false)
  })

  it('surrounding whitespace does not count toward the threshold', () => {
    expect(shouldNudgeForPaste(' '.repeat(PASTE_NUDGE_MIN_CHARS * 2), false)).toBe(false)
    expect(shouldNudgeForPaste(`\n\n${'x'.repeat(PASTE_NUDGE_MIN_CHARS + 1)}\n\n`, false)).toBe(true)
  })

  it('never nudges twice for the same note (alreadyNudged wins)', () => {
    expect(shouldNudgeForPaste('x'.repeat(10_000), true)).toBe(false)
  })
})
