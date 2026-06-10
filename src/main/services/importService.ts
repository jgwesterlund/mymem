import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { NotesRepo } from '../db/repos/notesRepo'
import type { CollectionsRepo } from '../db/repos/collectionsRepo'
import type { VersionsRepo } from '../db/repos/miscRepos'
import type { Indexer } from '../indexing/indexer'

/**
 * File import (.md/.txt): per file — title from a first-line H1 (else filename),
 * CRLF→LF, F1 task-list normalization, note + 'import' snapshot + index job.
 * Directories recurse ONE level and their files land in a collection named
 * after the folder. One file failing must never abort the batch.
 *
 * Pure helpers (deriveImport, normalizeLooseTaskLists) carry no electron/sqlite
 * imports so vitest can exercise them under plain Node.
 */
export const IMPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const MAX_FILES = 1000
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * F1 workaround (docs/known-issues.md): @tiptap/markdown drops siblings after a
 * nested sublist when a task list arrives in LOOSE form. Collapse a SINGLE blank
 * line between two task-list item lines into tight form at parse time. Two or
 * more blank lines (a real paragraph break) are left alone, as are plain bullet
 * lists — both neighbours must be checkbox items. Fence-aware: the inside of
 * ``` / ~~~ blocks is never touched.
 */
export function normalizeLooseTaskLists(md: string): string {
  const lines = md.split('\n')
  const isTask = (l: string | undefined): boolean =>
    l !== undefined && /^[ \t]*[-*+] \[[ xX]\]/.test(l)
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^[ \t]*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // single blank between two task items (outside fences) → tight form
    if (!inFence && line.trim() === '' && isTask(out[out.length - 1]) && isTask(lines[i + 1])) {
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Title rule: an H1 on the FIRST non-empty line becomes the title and is
 * stripped from the content (the title lives in the notes table, not the body);
 * anything else (H1 further down, '# ' inside a leading code fence, '## ')
 * keeps the body verbatim and falls back to the filename without extension.
 */
export function deriveImport(raw: string, fallbackTitle: string): { title: string; contentMd: string } {
  const md = normalizeLooseTaskLists(raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n'))
  const lines = md.split('\n')
  let i = 0
  while (i < lines.length && lines[i]!.trim() === '') i++
  const m = lines[i]?.match(/^#\s+(.+)$/)
  if (m) {
    return { title: m[1]!.trim(), contentMd: lines.slice(i + 1).join('\n').replace(/^\n+/, '') }
  }
  return { title: fallbackTitle, contentMd: md }
}

type ImportTarget = { filePath: string; collectionName?: string }

/** Expand directories one level (matching files only); keep file paths as-is —
 *  an unreadable path stays a target so the batch loop records it as skipped. */
function collectTargets(filePaths: string[]): ImportTarget[] {
  const targets: ImportTarget[] = []
  for (const p of filePaths) {
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      /* unreadable/missing: fall through as a file target */
    }
    if (isDir) {
      const collectionName = basename(p)
      let entries: string[] = []
      try {
        entries = readdirSync(p)
      } catch {
        continue
      }
      for (const entry of entries.sort()) {
        if (entry.startsWith('.')) continue // dotfiles + AppleDouble ._* resource forks
        if (IMPORT_EXTENSIONS.has(extname(entry).toLowerCase())) {
          targets.push({ filePath: join(p, entry), collectionName })
        }
      }
    } else if (IMPORT_EXTENSIONS.has(extname(p).toLowerCase())) {
      targets.push({ filePath: p })
    }
  }
  return targets
}

export interface ImportDeps {
  notes: NotesRepo
  collections: CollectionsRepo
  versions: VersionsRepo
  indexer: Indexer
  /** Wired to push('import:progress') by handlers; injectable for the smoke test. */
  onProgress?: (done: number, total: number) => void
}

export function createImportService(deps: ImportDeps) {
  return {
    async importPaths(filePaths: string[]): Promise<{ createdIds: string[]; skipped: string[] }> {
      const targets = collectTargets(filePaths).slice(0, MAX_FILES)
      const total = targets.length
      const createdIds: string[] = []
      const skipped: string[] = []
      const collectionIdByName = new Map<string, string>()
      let done = 0

      for (const target of targets) {
        try {
          if (statSync(target.filePath).size > MAX_FILE_BYTES) {
            skipped.push(target.filePath)
          } else {
            const raw = readFileSync(target.filePath, 'utf8')
            const ext = extname(target.filePath)
            const { title, contentMd } = deriveImport(raw, basename(target.filePath, ext))
            const note = deps.notes.create({ title, contentMd })
            if (target.collectionName) {
              const key = target.collectionName.toLowerCase()
              let collectionId = collectionIdByName.get(key)
              if (!collectionId) {
                const existing = deps.collections.getByName(target.collectionName)
                collectionId = (existing ?? deps.collections.create({ name: target.collectionName })).id
                collectionIdByName.set(key, collectionId)
              }
              deps.collections.setForNote(note.id, [collectionId])
            }
            deps.versions.snapshot(note, 'import')
            deps.indexer.enqueue(note.id)
            createdIds.push(note.id)
          }
        } catch (err) {
          console.error(`[import] failed for ${target.filePath}`, err)
          skipped.push(target.filePath)
        }
        deps.onProgress?.(++done, total)
        // Yield periodically so a large batch doesn't starve the main loop.
        if (done % 25 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      return { createdIds, skipped }
    }
  }
}

export type ImportService = ReturnType<typeof createImportService>
