import type Database from 'better-sqlite3'
import type { SearchResult } from '@shared/types'
import type { EmbedderClient } from '../indexing/embedderClient'

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

// ── Deep search: RRF over FTS top-20 ⋈ KNN top-20 (plan SQL) ─────────────────
// fts_raw stays FTS-only and MATERIALIZED for the same bm25-context reason as
// keywordSql; ranks are densified with ROW_NUMBER OUTSIDE the MATCH query.
// chunks_vec KNN distance is cosine (declared distance_metric=cosine).
// score = COALESCE(1/(60+fts_rank),0) + COALESCE(1/(60+vec_rank),0), aggregated
// to notes via MAX — the bare c.id/c.text come from that same winning chunk row
// (SQLite MAX() bare-column guarantee), which feeds the snippet pass.
const RRF_K = 60
const RRF_TOP = 20

const deepSql = (withCollection: boolean): string => `
  WITH fts_raw AS MATERIALIZED (
    SELECT rowid AS chunk_id, bm25(chunks_fts, 3.0, 1.0) AS r
    FROM chunks_fts
    WHERE chunks_fts MATCH @match
    ORDER BY r
    LIMIT ${RRF_TOP}
  ),
  fts_hits AS (
    SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY r) AS rank FROM fts_raw
  ),
  vec_hits AS (
    SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank FROM (
      SELECT rowid AS chunk_id, distance FROM chunks_vec
      WHERE embedding MATCH @qvec AND k = ${RRF_TOP}
    )
  ),
  fused AS (
    SELECT COALESCE(f.chunk_id, v.chunk_id) AS chunk_id,
           COALESCE(1.0 / (${RRF_K} + f.rank), 0) + COALESCE(1.0 / (${RRF_K} + v.rank), 0) AS score
    FROM fts_hits f FULL OUTER JOIN vec_hits v ON v.chunk_id = f.chunk_id
  )
  SELECT n.id AS note_id, n.title AS title, c.id AS chunk_id, c.text AS chunk_text, MAX(u.score) AS score
  FROM fused u
  JOIN chunks c ON c.id = u.chunk_id
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  ${withCollection ? 'JOIN note_collections nc ON nc.note_id = n.id AND nc.collection_id = @collectionId' : ''}
  GROUP BY n.id
  ORDER BY score DESC
  LIMIT @limit`

// Query with no FTS-sanitizable tokens (emoji-only etc.) → pure KNN ranking.
const vecOnlySql = (withCollection: boolean): string => `
  WITH vec_hits AS (
    SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY distance) AS rank FROM (
      SELECT rowid AS chunk_id, distance FROM chunks_vec
      WHERE embedding MATCH @qvec AND k = ${RRF_TOP}
    )
  )
  SELECT n.id AS note_id, n.title AS title, c.id AS chunk_id, c.text AS chunk_text,
         MAX(1.0 / (${RRF_K} + v.rank)) AS score
  FROM vec_hits v
  JOIN chunks c ON c.id = v.chunk_id
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  ${withCollection ? 'JOIN note_collections nc ON nc.note_id = n.id AND nc.collection_id = @collectionId' : ''}
  GROUP BY n.id
  ORDER BY score DESC
  LIMIT @limit`

type DeepRow = { note_id: string; title: string; chunk_id: number; chunk_text: string; score: number }

export function createSearchService(db: Database.Database, embedder?: EmbedderClient) {
  const titleLike = db.prepare(TYPEAHEAD_SQL)
  const keywordAll = db.prepare(keywordSql(false))
  const keywordInCollection = db.prepare(keywordSql(true))
  const deepAll = db.prepare(deepSql(false))
  const deepInCollection = db.prepare(deepSql(true))
  const vecOnlyAll = db.prepare(vecOnlySql(false))
  const vecOnlyInCollection = db.prepare(vecOnlySql(true))

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

    /** Semantic RRF when the worker is ready; degrades to keyword otherwise. */
    async deep(
      q: string,
      collectionId?: string,
      limit?: number
    ): Promise<{ results: SearchResult[]; usedMode: 'keyword' | 'deep' }> {
      if (!embedder || embedder.status().state !== 'ready') {
        return { results: this.keyword(q, collectionId, limit), usedMode: 'keyword' }
      }
      let qvec: Float32Array
      try {
        qvec = (await embedder.embed([q]))[0]!
      } catch (err) {
        console.error('[search] query embedding failed, falling back to keyword', err)
        return { results: this.keyword(q, collectionId, limit), usedMode: 'keyword' }
      }
      return { results: this.deepWithVector(q, qvec, collectionId, limit), usedMode: 'deep' }
    },

    /** RRF core with an injected query vector — exported for the synthetic smoke leg. */
    deepWithVector(q: string, qvec: Float32Array, collectionId?: string, limit = 30): SearchResult[] {
      const match = sanitizeFtsQuery(q)
      const params: Record<string, unknown> = {
        qvec: Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength),
        limit: Math.min(limit, 100)
      }
      let stmt = match === null ? vecOnlyAll : deepAll
      if (match !== null) params.match = match
      if (collectionId) {
        params.collectionId = collectionId
        stmt = match === null ? vecOnlyInCollection : deepInCollection
      }
      const rows = stmt.all(params) as DeepRow[]
      if (rows.length === 0) return []

      // Snippets: second FTS pass over the winning chunks; vector-only winners get a
      // plain-text excerpt (the renderer escapes everything except <mark> anyway).
      const snippets = new Map<number, string>()
      if (match !== null) {
        const ids = rows.map((r) => r.chunk_id).join(', ')
        const snipRows = db
          .prepare(
            `SELECT rowid AS chunk_id, snippet(chunks_fts, 1, '<mark>', '</mark>', '…', 12) AS snip
             FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (${ids})`
          )
          .all(match) as { chunk_id: number; snip: string }[]
        for (const r of snipRows) snippets.set(r.chunk_id, r.snip)
      }
      return rows.map((r) => ({
        noteId: r.note_id,
        title: r.title,
        snippetHtml: snippets.get(r.chunk_id) ?? r.chunk_text.slice(0, 200),
        score: r.score
      }))
    }
  }
}

export type SearchService = ReturnType<typeof createSearchService>
