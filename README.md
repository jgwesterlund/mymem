# myMem

Local-first AI notes for Mac — your notes, your models. Sign in with the
ChatGPT or Claude subscription you already have (OAuth, no API key required);
everything is stored locally on your machine.

## Features

- Markdown editor with wikilinks and a slash command menu
- Collections, plus AI auto-organize to file notes for you
- Full-text and semantic search (embeddings computed locally, fully offline)
- Version history for every note
- Quick capture global hotkey
- AI chat over your knowledge base with citations — it can also create and
  edit notes for you
- AI Clean Up with a diff preview before anything is applied
- Dark mode

## Architecture

myMem is an Electron app. Notes live in a local SQLite database — FTS5 for
keyword search and [sqlite-vec](https://github.com/asg017/sqlite-vec) for
vector search — with embeddings computed on-device by
[transformers.js](https://github.com/huggingface/transformers.js) (MiniLM).
All AI features run through
[@earendil-works/pi-ai](https://github.com/earendil-works/pi), a
provider-agnostic LLM client that supports OpenAI Codex OAuth and Claude
Pro/Max OAuth, so chat works on your existing subscription. Nothing leaves
your machine except the model calls you explicitly make.

## Install

### Homebrew (recommended)

```sh
brew tap jgwesterlund/tap
brew install --cask mymem --no-quarantine   # the app
brew install jgwesterlund/tap/mym           # optional: the CLI for agents
```

Builds are currently **unsigned**, which is why `--no-quarantine` is suggested —
without it, right-click the app and choose "Open" on first launch instead.

### Download

Grab the `.dmg` from the [latest release](https://github.com/jgwesterlund/mymem/releases)
and drag myMem to Applications (same Gatekeeper note applies).

### Build from source

```sh
npm install
npm run dist     # packaged .app/.dmg/.zip in release/ (arm64)
```

Requirements: macOS (Apple Silicon / arm64), Node >= 22.19. Go is only needed
if you want the `mym` CLI. See the comments in `electron-builder.yml` for
enabling signing/notarization with your own Developer ID.

## Develop

```sh
npm run dev        # HMR dev server + Electron
npm run typecheck  # tsc over main/preload, renderer, and tests
npm test           # vitest unit/component suite
npm run smoke      # builds, then verifies the whole backend stack inside Electron
npm run e2e        # builds, then drives the real app UI with Playwright (_electron)
```

`MYMEM_SMOKE=1 MYMEM_SMOKE_EMBED=1 electron .` additionally exercises the real
embeddings worker (downloads the ~23 MB MiniLM model — network required). To
sanity-check a packaged build, run the same smoke against
`./release/mac-arm64/myMem.app/Contents/MacOS/myMem`.

The app icon is generated — `npm run icon` rebuilds it from
`scripts/make-icon.swift` (see `resources/README.md`). Design notes and known
issues live in `docs/`.

## CLI and agent skill

`mym` is a small Go CLI that talks to the running app over a local unix
socket, so any shell — or any coding agent — can search, read, and write your
notes. An agent skill (`skills/mymem/SKILL.md`) teaches agents the workflow:
search first, cite note titles, write markdown.

```sh
brew install jgwesterlund/tap/mym   # or: npm run build:cli (requires Go)
npm run install-skill                # installs the skill for every agent detected on your machine
```

`install-skill` symlinks `skills/mymem` into each agent's skill directory
(idempotent; `--agent claude|codex|pi|opencode|all` to target one):

| Agent | Skill location | Notes |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/skills) | `~/.claude/skills/mymem` | |
| [Codex CLI](https://developers.openai.com/codex/skills) | `~/.agents/skills/mymem` | Codex's user scope; symlinks officially supported |
| [pi](https://github.com/earendil-works/pi) | `~/.pi/agent/skills/mymem` | also reads `~/.agents/skills`, so a Codex install already covers it |
| [opencode](https://opencode.ai/docs/skills/) | `~/.config/opencode/skills/mymem` | also reads `~/.claude/skills` and `~/.agents/skills`, so a Claude/Codex install already covers it |

All four use the same `SKILL.md` convention (`name` + `description`
frontmatter), so one skill directory serves every agent. The installer skips
agents it can't find and never overwrites files it didn't create.

From the shell:

```sh
mym search "kubernetes notes" --json
printf '## Decisions\n- v2 endpoints stay REST\n' | mym create --title "API design review" --collection Work -
mym append 9f3ac2d4 -- '- follow up on X'
mym related 9f3ac2d4
```

Also: `status`, `get`, `list`, `update`, `collections`, `trash` — run
`./cli/mym help`. `cd cli && go test ./...` runs its test suite.

From an agent, just talk:

- *"Check my notes for what we decided about the API design"* — the agent runs
  `mym search` / `mym get` and answers with citations from your notes.
- *"Save a note summarizing this conversation"* — the agent writes a markdown
  note via `mym create` into a sensible collection.
- *"Add 'rotate the staging certs' to my ops checklist note"* — the agent finds
  the note and runs `mym append`.

## Security

The API is a unix socket with `0600` permissions
(`~/Library/Application Support/mymem/api.sock`; `MYMEM_SOCKET` overrides) —
local-only, current user only, no network listener. There is no telemetry.
AI provider credentials are encrypted with Electron `safeStorage`, backed by
the macOS Keychain.

## License

[MIT](LICENSE) © 2026 John Westerlund
