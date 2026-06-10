import type Database from 'better-sqlite3'
import type { SearchResult } from '@shared/types'

/**
 * Sanitize user input into FTS5 MATCH syntax. PURE — adversarial unit tests
 * run it under plain Node.
 *
 * Every operator/syntax character becomes a separator, every surviving token
 * is double-quoted (internal quotes doubled as defense-in-depth — the strip
 * already removes them) and the LAST token gets a trailing * for
 * prefix-as-you-type. Tokens join with FTS5's implicit AND. Input that
 * yields no tokens (empty, punctuation-only, emoji-only) returns null and
 * callers answer with no results.
 */
export function sanitizeFtsQuery(q: string): string | null {
  const tokens = q
    .replace(/["()*:^{}~+-]/g, ' ') // FTS5 operator/syntax chars → separators
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t)) // a token must carry a letter or digit
  if (tokens.length === 0) return null
  const phrases = tokens.map((t) => `"${t.replace(/"/g, '""')}"`)
  return `${phrases.join(' ')}*`
}

/** LIKE patterns treat % _ (and our escape char \) literally. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&')

// LIMIT 40 (not 10): the substring pass dedups against prefix hits, so a
// tight limit could be eaten entirely by prefix dupes and drop real matches.
// TODO: LIKE case-insensitivity is ASCII-only in SQLite — 'åland' won't match
// 'Åland'; revisit with a JS-normalized title column if it bites.
const TYPEAHEAD_SQL = `
  SELECT id, title FROM notes
  WHERE trashed_at IS NULL AND title LIKE ? ESCAPE '\\'
  ORDER BY updated_at DESC LIMIT 40`

// Title column weighted 3× over text; bm25 rank is "lower = better" (negative).
// GROUP BY note_id keeps the best chunk per note — SQLite's MIN() bare-column
// guarantee makes snip come from that same best-ranked row. The CTE touches
// ONLY chunks_fts and is MATERIALIZED: joins flattened into the MATCH query
// can reorder it so bm25()/snippet() lose their FTS context and error out.
const keywordSql = (withCollection: boolean): string => `
  WITH hits AS MATERIALIZED (
    SELECT rowid AS chunk_id,
           bm25(chunks_fts, 3.0, 1.0) AS rank,
           snippet(chunks_fts, 1, '<mark>', '</mark>', '…', 12) AS snip
    FROM chunks_fts
    WHERE chunks_fts MATCH @match
  )
  SELECT n.id AS note_id, n.title AS title, h.snip AS snip, MIN(h.rank) AS rank
  FROM hits h
  JOIN chunks c ON c.id = h.chunk_id
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  ${withCollection ? 'JOIN note_collections nc ON nc.note_id = n.id AND nc.collection_id = @collectionId' : ''}
  GROUP BY n.id
  ORDER BY rank
  LIMIT @limit`

export function createSearchService(db: Database.Database) {
  const titleLike = db.prepare(TYPEAHEAD_SQL)
  const keywordAll = db.prepare(keywordSql(false))
  const keywordInCollection = db.prepare(keywordSql(true))

  return {
    /** Title-only typeahead: prefix matches first, then substring; live notes, ≤10. */
    typeahead(q: string): { noteId: string; title: string }[] {
      const needle = escapeLike(q.trim())
      const rows = titleLike.all(`${needle}%`) as { id: string; title: string }[]
      const out = rows.slice(0, 10).map((r) => ({ noteId: r.id, title: r.title }))
      if (needle !== '' && out.length < 10) {
        const more = titleLike.all(`%${needle}%`) as { id: string; title: string }[]
        for (const r of more) {
          if (out.length >= 10) break
          if (!out.some((o) => o.noteId === r.id)) out.push({ noteId: r.id, title: r.title })
        }
      }
      return out
    },

    /** FTS5 keyword search: best chunk per live note, optional collection filter. */
    keyword(q: string, collectionId?: string, limit = 30): SearchResult[] {
      const match = sanitizeFtsQuery(q)
      if (match === null) return []
      const params: Record<string, unknown> = { match, limit: Math.min(limit, 100) }
      let stmt = keywordAll
      if (collectionId) {
        params.collectionId = collectionId
        stmt = keywordInCollection
      }
      const rows = stmt.all(params) as { note_id: string; title: string; snip: string; rank: number }[]
      return rows.map((r) => ({
        noteId: r.note_id,
        title: r.title,
        snippetHtml: r.snip,
        score: -r.rank // flip bm25 so higher = better for consumers
      }))
    },

    /** Semantic RRF lands with the embedding worker (M5); keyword serves both until then. */
    deep(q: string, collectionId?: string, limit?: number): { results: SearchResult[]; usedMode: 'keyword' } {
      return { results: this.keyword(q, collectionId, limit), usedMode: 'keyword' }
    }
  }
}

export type SearchService = ReturnType<typeof createSearchService>
