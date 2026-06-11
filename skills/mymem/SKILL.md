---
name: mymem
description: Search, read and write John's local myMem notes via the mym CLI. Use when the user references their notes/anteckningar or asks to save/recall personal knowledge.
---

# myMem notes via the `mym` CLI

myMem is John's local-first notes app. The `mym` binary talks to the running
app over a unix socket. All note content is **markdown** — both what you read
and what you write.

## When to use this skill

- The user asks something they may have written down ("what do my notes say
  about X", "vad har jag antecknat om...", "did I note the wifi password?")
  → **search first**, then read, then answer.
- The user asks to save findings, decisions, snippets or research results
  → `mym create`.
- The user asks to add to an existing note → `mym append`.

## Core workflow: search → get → cite

1. `mym search "query"` — keyword search. Add `--deep` for semantic search
   (it degrades to keyword automatically if embeddings are not ready).
2. Need full note ids? Add `--json` — human output shows 8-char short ids
   (the **tail** of the full id; the head is a timestamp and collides for
   notes created near each other), `--json` returns the exact server JSON
   with full ids. Short ids are accepted as input as long as they are unique;
   a unique prefix of the full id works too. Ambiguous ids error instead of
   guessing — fall back to the full id from `--json`.
3. `mym get <id>` — prints title + markdown body. `--json` for the object.
4. **Always cite the titles of the notes you used** when answering from them.

Search before answering questions about the user's knowledge — do not guess
what is in their notes.

## Command palette

```sh
mym status                                      # is the app up? note count, indexing state
mym search "tailscale acl" [--deep] [--collection NAME] [--limit N]
mym get 9f3ac2d4                                # title + markdown (short id from a listing, or full id)
mym get 9f3ac2d4 --json                         # full JSON object
mym list [--collection NAME] [--trash] [--limit N]
printf '## Agenda\n- item one\n- item two\n' | mym create --title "Meeting notes" --collection Work -
echo "long markdown body" | mym create --title "Research: X" -   # '-' = stdin
printf '## Update\nNew findings here\n' | mym append 9f3ac2d4 -  # adds a new section
mym append 9f3ac2d4 -- "- new checklist item"   # '--' before content that starts with '-'
echo "piped addition" | mym append 9f3ac2d4     # stdin works too
mym update 9f3ac2d4 "replacement body"          # REPLACES the whole note body
mym collections                                 # list collections with note counts
mym trash 9f3ac2d4                              # soft delete (recoverable in the app)
mym related 9f3ac2d4 [--broaden]                # semantically related notes
```

Notes:

- **Multi-line/markdown content: pipe it to stdin and pass `-`** (as in the
  `printf … | mym … -` examples). Do **not** put `\n` inside ordinary
  `"…"` shell quotes — in sh that is a literal backslash-n, not a newline
  (`$'…\n…'` works in bash/zsh, but stdin is the portable choice).
- **Content that starts with `-`** (e.g. a markdown list line) must come
  after a bare `--`, or it will be parsed as a flag:
  `mym append <id> -- "- buy milk"`. Stdin content needs no escaping at all.
- `--collection` takes a collection **name**, is repeatable on `create`, and
  missing collections are created automatically.
- Prefer `append` over `update` — `update` replaces the entire body.
- Content is markdown: headings, lists, task lists, tables and code blocks
  all render in the app. Use a `##` heading when appending a new section.
- When saving research for the user, give the note a descriptive title and
  put it in a sensible collection.

## Error handling

- Exit code 2 with `myMem is not running — open the app first (socket: …)`
  → the app is closed. Tell the user to open myMem (`open -a myMem`) and stop;
  do not retry blindly.
- Exit code 1 → API error with the reason on stderr (e.g. `note not found`,
  `note is in the trash`). Fix the input or relay the message.
- Exit code 0 → success. `--json` output is the exact server response and is
  safe to parse.
