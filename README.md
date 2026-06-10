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

## Develop

```sh
npm install        # also fetches Electron-ABI prebuilds for native deps
npm run dev        # HMR dev server + Electron
npm run smoke      # builds, then verifies pi-ai + sqlite stack inside Electron
npm run dist       # packaged .app/.dmg (unsigned during development)
```

Plan and milestones: see the approved plan (M0–M9). Current status: M0.
