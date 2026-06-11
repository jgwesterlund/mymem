/**
 * Paste-nudge threshold (v1.1): pastes longer than this look like web content
 * worth running through Clean Up — short snippets never nudge.
 */
export const PASTE_NUDGE_MIN_CHARS = 400

/**
 * True when a paste should show the "Pasted content — clean it up?" toast:
 * longer than the threshold (ignoring surrounding whitespace) and not already
 * nudged for this note this session. Pure — vitest-covered.
 */
export function shouldNudgeForPaste(pastedText: string, alreadyNudged: boolean): boolean {
  return !alreadyNudged && pastedText.trim().length > PASTE_NUDGE_MIN_CHARS
}
