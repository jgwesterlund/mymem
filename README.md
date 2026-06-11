# myMem

Mac-native, local-first AI notes app (a mem.ai-style clone). Notes live in a local SQLite
database with full-text + semantic search; an agentic chat over your knowledge base runs on
[@earendil-works/pi-ai](https://github.com/earendil-works/pi), so you can sign in with your
ChatGPT subscription (OpenAI Codex OAuth) or Claude Pro/Max — no API key required.

## Stack

- Electron 41 (pinned — bundled Node satisfies pi-ai's `node >= 22.19`), ESM throughout
- React 19 + Zustand + Tailwind v4, TipTap v3 editor (markdown-first)
- better-sqlite3 (pinned 12.10.0) + FTS5 + sqlite-vec; local embeddings via transformers.js
- `mym` — Go CLI over a local unix-socket API, with a Claude Code skill in `skills/mymem/`

## Status

All planned milestones are done (M0–M9): data spine and editor, tabs + split panes,
keyword + semantic deep search, version history / import / export / quick capture, local
embeddings worker, unix-socket API + CLI + Claude Code skill, agentic chat with citations,
AI clean-up / auto-organize / titles, and the M9 polish pass (find-in-note, dark mode,
onboarding, templates, window persistence, keymap + Playwright e2e tests, packaging).

## Develop

```sh
npm install        # also fetches Electron-ABI prebuilds for native deps
npm run dev        # HMR dev server + Electron
npm run typecheck  # tsc over main/preload, renderer, and tests
npm test           # vitest unit/component suite
npm run smoke      # builds, then verifies the whole backend stack inside Electron
npm run e2e        # builds, then drives the real app UI with Playwright (_electron)
```

`MYMEM_SMOKE=1 MYMEM_SMOKE_EMBED=1 electron .` additionally exercises the real
embeddings worker (downloads the ~23 MB MiniLM model — network required).

## Release

```sh
npm run dist       # packaged .app/.dmg/.zip in release/ (arm64)
```

Builds are currently **unsigned** (`identity: null` in `electron-builder.yml`).
Once a Developer ID Application certificate is in the keychain, remove that line
and flip `notarize: true` with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` /
`APPLE_TEAM_ID` exported in the environment — see the comments in
`electron-builder.yml`. The app icon goes in `resources/` (see `resources/README.md`).

Sanity-check a packaged build by running the full smoke inside it:

```sh
MYMEM_SMOKE=1 ./release/mac-arm64/myMem.app/Contents/MacOS/myMem
MYMEM_SMOKE=1 MYMEM_SMOKE_EMBED=1 ./release/mac-arm64/myMem.app/Contents/MacOS/myMem
```

## CLI — `mym`

A Go CLI that talks to the running app over a `0600` unix socket
(`~/Library/Application Support/mymem/api.sock`; `MYMEM_SOCKET` overrides):

```sh
npm run build:cli                 # builds cli/mym (requires Go)
./cli/mym status                  # app + index health
./cli/mym create --title "Idea" "body markdown…"
./cli/mym get <id-or-title>
./cli/mym append <id-or-title> "more text"
./cli/mym search "query"
```

Also: `list`, `update`, `collections`, `trash`, `related` — run `./cli/mym help`.
`cd cli && go test ./...` runs its test suite.

## Claude Code skill

`skills/mymem/` packages the CLI workflow for coding agents. `npm run install-skill`
symlinks it into `~/.claude/skills/` (idempotent) so Claude Code can read, search,
and write your notes through the same socket API.
