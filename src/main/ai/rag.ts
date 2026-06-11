import type Database from 'better-sqlite3'
import { sanitizeFtsQuery } from '../search/searchService'
import type { EmbedderClient } from '../indexing/embedderClient'

/**
 * Turn-1 implicit retrieval: when the FIRST user turn has no context chips and
 * the workspace has ≥5 live notes, fetch the top chunks (hybrid RRF when the
 * embedder is ready, FTS-only otherwise) and inject them as ONE user-side
 * <workspace_context> message BEFORE the user message. Later turns retrieve
 * agentically via search_notes. Query embedding is ALWAYS local (Codex OAuth
 * has no embeddings endpoint).
 */
const TOP_CHUNKS = 8
const MAX_NOTES = 5
const MIN_LIVE_NOTES = 5
const RRF_K = 60
const RRF_TOP = 20
// RRF floor ≈ a best single-list rank of ~11 — anything below is noise, skip injection.
// Keyword-only hits get no score floor: an FTS match IS exact-term evidence.
const DEEP_SCORE_FLOOR = 1 / (RRF_K + 11)

type ChunkHit = { note_id: string; title: string; text: string; score: number }

// Chunk-level (NOT note-aggregated like searchService): the injected context
// wants the actual matching passages. Same MATERIALIZED-CTE discipline as
// searchService — bm25() must not be flattened out of its MATCH query.
const KEYWORD_SQL = `
  WITH hits AS MATERIALIZED (
    SELECT rowid AS chunk_id, bm25(chunks_fts, 3.0, 1.0) AS rank
    FROM chunks_fts WHERE chunks_fts MATCH @match
    ORDER BY rank LIMIT ${RRF_TOP}
  )
  SELECT c.note_id, n.title, c.text, -h.rank AS score
  FROM hits h
  JOIN chunks c ON c.id = h.chunk_id
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  ORDER BY h.rank LIMIT ${TOP_CHUNKS}`

const DEEP_SQL = `
  WITH fts_raw AS MATERIALIZED (
    SELECT rowid AS chunk_id, bm25(chunks_fts, 3.0, 1.0) AS r
    FROM chunks_fts WHERE chunks_fts MATCH @match
    ORDER BY r LIMIT ${RRF_TOP}
  ),
  fts_hits AS (SELECT chunk_id, ROW_NUMBER() OVER (ORDER BY r) AS rank FROM fts_raw),
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
  SELECT c.note_id, n.title, c.text, u.score
  FROM fused u
  JOIN chunks c ON c.id = u.chunk_id
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  ORDER BY u.score DESC LIMIT ${TOP_CHUNKS}`

export function createRag(db: Database.Database, embedder?: EmbedderClient) {
  const liveCountStmt = db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE trashed_at IS NULL`)
  const keywordStmt = db.prepare(KEYWORD_SQL)
  const deepStmt = db.prepare(DEEP_SQL)

  return {
    liveNoteCount(): number {
      return (liveCountStmt.get() as { c: number }).c
    },

    /**
     * Returns the <workspace_context> message body, or null when retrieval
     * should be skipped (few notes, no sanitizable query, low top score).
     * Eligibility for "first turn / no chips" is the agent's call.
     */
    async buildContext(query: string): Promise<string | null> {
      if (this.liveNoteCount() < MIN_LIVE_NOTES) return null
      const match = sanitizeFtsQuery(query)
      if (match === null) return null

      let hits: ChunkHit[]
      if (embedder && embedder.status().state === 'ready') {
        try {
          const qvec = (await embedder.embed([query]))[0]!
          hits = deepStmt.all({
            match,
            qvec: Buffer.from(qvec.buffer, qvec.byteOffset, qvec.byteLength)
          }) as ChunkHit[]
          if (hits.length === 0 || hits[0]!.score < DEEP_SCORE_FLOOR) return null
        } catch (err) {
          console.error('[rag] query embedding failed, falling back to keyword', err)
          hits = keywordStmt.all({ match }) as ChunkHit[]
        }
      } else {
        hits = keywordStmt.all({ match }) as ChunkHit[]
      }
      if (hits.length === 0) return null

      // Top-8 chunks deduped to ≤5 distinct notes (extra chunks from an already-
      // included note are kept — they are the strongest evidence).
      const noteIds = new Set<string>()
      const kept: ChunkHit[] = []
      for (const h of hits) {
        if (!noteIds.has(h.note_id) && noteIds.size >= MAX_NOTES) continue
        noteIds.add(h.note_id)
        kept.push(h)
      }

      const chunks = kept
        .map((h) => `<chunk note_id="${h.note_id}" note_title="${h.title.replace(/"/g, '&quot;') || 'Untitled'}">\n${h.text}\n</chunk>`)
        .join('\n')
      return [
        '<workspace_context note="automatically retrieved from the user\'s notes; may be irrelevant; cite notes you actually use as [Title](mymem://note/<id>)">',
        chunks,
        '</workspace_context>'
      ].join('\n')
    }
  }
}

export type Rag = ReturnType<typeof createRag>
