import { describe, expect, it } from 'vitest'
import { validateCleanup } from '../src/main/ai/cleanup'
import { buildCleanupSystemPrompt } from '../src/main/ai/prompts'

/**
 * Web-paste cleanup (v1.1 review M1): the paste-nudge path tells the model to
 * strip nav/cookie/footer debris, so the strict 0.5 length floor would
 * systematically reject legitimate cleanups. webPaste sessions get a relaxed
 * 0.15 floor on the INITIAL pass only; refines keep the existing rules, and
 * ordinary Cmd+Shift+U sessions keep the strict preserve-everything contract.
 */

const debris = [
  'Home | Products | Pricing | Blog | About | Contact',
  'We use cookies — Accept all · Manage preferences',
  '© 2026 Example Corp · Privacy · Terms · Sitemap'
].join('\n')
const body = 'The one substantive paragraph that must survive the cleanup intact.'
const base = `${debris}\n\n${body}\n\n${debris}`
const ratio = body.length / base.length

it('fixture sits between the web floor and the normal floor', () => {
  expect(ratio).toBeGreaterThan(0.15)
  expect(ratio).toBeLessThan(0.5)
})

describe('validateCleanup webPaste floor', () => {
  it('normal initial pass rejects a debris-strip shrink', () => {
    expect(validateCleanup(base, body, null)).toBe('length changed too much')
  })

  it('webPaste initial pass accepts the same shrink', () => {
    expect(validateCleanup(base, body, null, true)).toBeNull()
  })

  it('webPaste refines keep the existing 0.5 floor', () => {
    expect(validateCleanup(base, body, 'fix the headings', true)).toBe('length changed too much')
  })

  it('a length-intent refine lifts the guard as before', () => {
    expect(validateCleanup(base, body, 'shorten it drastically', true)).toBeNull()
    expect(validateCleanup(base, body, 'shorten it drastically', false)).toBeNull()
  })

  it('webPaste still rejects responses below the relaxed floor', () => {
    expect(validateCleanup(base, 'tiny', null, true)).toBe('length changed too much')
  })

  it('webPaste keeps the empty and code-block invariants', () => {
    expect(validateCleanup(base, '   ', null, true)).toBe('empty response')
    const baseWithCode = `${base}\n\n\`\`\`js\nconst x = 1\n\`\`\``
    expect(validateCleanup(baseWithCode, body, null, true)).toBe('code-block count changed')
  })
})

describe('buildCleanupSystemPrompt', () => {
  const normal = buildCleanupSystemPrompt()
  const web = buildCleanupSystemPrompt(true)

  it('normal sessions keep the strict preserve-everything contract (no debris line)', () => {
    expect(normal).not.toContain('debris')
    expect(normal).not.toContain('except web-paste')
    expect(normal).toContain('NEVER summarize, shorten or drop content unless the user explicitly asks for it in a refinement.')
  })

  it('webPaste sessions get the debris line AND the never-drop carve-out', () => {
    expect(web).toContain('remove that debris')
    expect(web).toContain('— except web-paste debris as described above')
  })

  it('both variants keep the shared invariants', () => {
    for (const p of [normal, web]) {
      expect(p).toContain('PRESERVE the meaning')
      expect(p).toContain('Keep code blocks VERBATIM')
      expect(p).toContain('Output ONLY the full revised markdown')
    }
  })
})
