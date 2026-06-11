/** System prompt assembly for the chat agent. Pure string building — no Electron imports. */

export function buildSystemPrompt(opts: { chatInstructions?: string | null; now?: Date }): string {
  const now = opts.now ?? new Date()
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const stamp = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone
  })

  const parts = [
    `You are the myMem assistant: you live inside John's local, private notes app and help him search, read, organize and edit his notes. Be concise and direct; answer in the language the user writes in.`,
    `Current date and time: ${stamp} (${timeZone}). Use this for anything time-relative ("yesterday", "this week", recency).`,
    `CITATIONS — when you use information from a note, cite it inline as a markdown link: [Note Title](mymem://note/<id>). Use ids exactly as returned by tools — never invent or guess ids. Do not use footnote markers.`,
    [
      'Tool usage:',
      '- Search your tools before answering questions about the user\'s knowledge, projects or past writing — do not answer from memory alone.',
      '- Read a note (read_note) before editing it.',
      '- Prefer update_note mode "append" over "replace"; replace only when the user explicitly asks to rewrite.',
      '- After creating or editing notes, tell the user exactly what changed and cite the affected notes.',
      '- If a tool returns an error, explain it briefly instead of retrying the identical call.'
    ].join('\n')
  ]

  const instructions = opts.chatInstructions?.trim()
  if (instructions) {
    parts.push(`User's standing instructions for chat:\n${instructions}`)
  }
  return parts.join('\n\n')
}

/** Prompt for the cheap post-turn chat-title completion (utility-model selection is M8). */
export const TITLE_SYSTEM_PROMPT =
  'You name chat conversations. Reply with ONLY a title of 3-6 plain words for the conversation — no quotes, no trailing punctuation.'
