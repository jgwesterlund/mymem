import type { Services } from './ipc/handlers'

/**
 * First-run onboarding (M9): seed a 'Welcome' collection with three short tour
 * notes and index them so search/chat can find them immediately.
 *
 * The 'onboarding.done' flag is set even when creation partially fails (logged):
 * a half-seeded welcome set is annoying once, but re-seeding on every boot —
 * or a crash loop retrying it — would be far worse.
 */
const WELCOME_NOTES: { title: string; contentMd: string }[] = [
  {
    title: 'Welcome to myMem',
    contentMd: `Welcome! myMem is a local-first notes app: everything lives in a SQLite database on this Mac.

## The editor

Notes are markdown-first — type \`#\`, \`-\`, \`[]\` or paste markdown and it just works. Use the format bar, or link another note inline by typing \`@\`.

## Shortcuts worth learning

- **⌘N** new note · **⌘K** search anything · **⌘J** new chat
- **⌘F** find in the open note · **⌘.** split the tab into two panes
- **⌘[** / **⌘]** navigate back / forward · **Ctrl+Tab** cycle tabs
- **⌃⌘Space** quick capture from anywhere (works with the window closed)

In lists and search results: **↩** opens, **⌘↩** opens in a new tab, **⌥↩** opens in the other pane.

Try it now: hit **⌘F** and search for "shortcuts".`
  },
  {
    title: 'Collections, pins and Clean Up',
    contentMd: `## Collections

Notes can live in any number of collections (left sidebar). **⌘O** organizes the open note by hand; **⇧⌘O** lets AI file it for you — every AI change comes with an Undo toast.

## Pins

**⇧⌘P** pins the open note to the sidebar. Drag pins to reorder them.

## Clean Up

**⇧⌘U** asks AI to tidy the open note — you review a word-level diff and accept or refine with follow-up instructions. Version History (the *History* button in a note) keeps session snapshots, so nothing is ever lost.`
  },
  {
    title: 'Chat with your notes (+ CLI)',
    contentMd: `## Chat

**⌘J** opens a chat over your knowledge base. Sign in under *Settings → AI* with your ChatGPT or Claude subscription (OAuth) or an API key. Answers cite your notes — click a citation chip to jump to the source. The chat agent can also create and edit notes for you; every edit is undoable.

## Deep search

Enable local embeddings under *Settings → Data* and **⌘K** search gains semantic results (the model downloads once, ~23 MB, and runs entirely on this Mac).

## mym CLI and Claude Code skill

The \`mym\` CLI talks to the same database over a local socket: \`mym create\`, \`mym get\`, \`mym search\`, \`mym append\`. Build it with \`npm run build:cli\`; install the Claude Code skill with \`npm run install-skill\` so coding agents can read and write your notes too.`
  }
]

export function runOnboarding(s: Services): void {
  if (s.settings.get('onboarding.done') === true) return
  try {
    const collection = s.collections.create({ name: 'Welcome' })
    for (const seed of WELCOME_NOTES) {
      const note = s.notes.create(seed)
      s.collections.setForNote(note.id, [collection.id])
      s.indexer.enqueue(note.id)
    }
    console.log('[onboarding] seeded Welcome collection with 3 notes')
  } catch (err) {
    console.error('[onboarding] seeding failed (will not retry)', err)
  } finally {
    s.settings.set('onboarding.done', true)
  }
}
