import type Database from 'better-sqlite3'
import type { RelatedCollection, RelatedNote } from '@shared/types'
import type { EmbedderClient } from '../indexing/embedderClient'
import { selectProbeIndices, similarityFromCosineDistance } from './relatedMath'

/**
 * Heads Up related notes: chunk-max multi-query KNN over the note's own stored
 * vectors (up to 8 probes, every ceil(n/8)-th embedded chunk), candidate note
 * score = MAX chunk similarity, secondary sort = distinct matching chunks.
 * Related collections are a rollup through note_collections minus the note's
 * own memberships. Reads vectors straight from chunks_vec — no worker round
 * trip, so this works even while the worker is restarting.
 */
const PROBE_MAX = 8
const KNN_K = 15
const KNN_K_BROADEN = 40
const SIM_THRESHOLD = 0.45
const SIM_THRESHOLD_BROADEN = 0.3
const TOP_NOTES = 8
const TOP_NOTES_BROADEN = 20
const TOP_COLLECTIONS = 5

export interface RelatedResult {
  notes: RelatedNote[]
  collections: RelatedCollection[]
  unavailableReason?: string
}

const knnSql = (k: number): string => `
  SELECT c.note_id AS note_id, v.rowid AS chunk_id, v.distance AS distance
  FROM (SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ${k}) v
  JOIN chunks c ON c.id = v.rowid
  JOIN notes n ON n.id = c.note_id AND n.trashed_at IS NULL
  WHERE c.note_id <> ?`

export function createRelatedService(db: Database.Database, embedder?: EmbedderClient) {
  const selectEmbeddedChunkIds = db.prepare(
    `SELECT id FROM chunks WHERE note_id = ? AND embedded = 1 ORDER BY idx`
  )
  const countChunks = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE note_id = ?`)
  const selectVector = db.prepare(`SELECT embedding FROM chunks_vec WHERE rowid = ?`)
  const knn = db.prepare(knnSql(KNN_K))
  const knnBroad = db.prepare(knnSql(KNN_K_BROADEN))

  return {
    forNote(noteId: string, broaden = false): RelatedResult {
      const embeddedIds = (selectEmbeddedChunkIds.all(noteId) as { id: number }[]).map((r) => r.id)
      if (embeddedIds.length === 0) {
        const state = embedder?.status().state ?? 'disabled'
        if (state !== 'ready') return { notes: [], collections: [], unavailableReason: `embeddings-${state}` }
        const hasChunks = (countChunks.get(noteId) as { n: number }).n > 0
        return {
          notes: [],
          collections: [],
          unavailableReason: hasChunks ? 'embedding-pending' : 'no-content'
        }
      }

      const probeIds = selectProbeIndices(embeddedIds.length, PROBE_MAX).map((i) => embeddedIds[i]!)
      const stmt = broaden ? knnBroad : knn
      const threshold = broaden ? SIM_THRESHOLD_BROADEN : SIM_THRESHOLD

      // note id → best similarity + distinct matching chunks across all probes
      const candidates = new Map<string, { score: number; chunks: Set<number> }>()
      for (const probeId of probeIds) {
        // BigInt: vec0 point queries need a true INTEGER rowid bind.
        const vec = selectVector.get(BigInt(probeId)) as { embedding: Buffer } | undefined
        if (!vec) continue // raced a reindex — probe vanished, other probes still cover
        const hits = stmt.all(vec.embedding, noteId) as {
          note_id: string
          chunk_id: number
          distance: number
        }[]
        for (const hit of hits) {
          const sim = similarityFromCosineDistance(hit.distance)
          if (sim < threshold) continue
          const entry = candidates.get(hit.note_id) ?? { score: -Infinity, chunks: new Set<number>() }
          entry.score = Math.max(entry.score, sim)
          entry.chunks.add(hit.chunk_id)
          candidates.set(hit.note_id, entry)
        }
      }

      const ranked = [...candidates.entries()]
        .sort(([, a], [, b]) => b.score - a.score || b.chunks.size - a.chunks.size)
        .slice(0, broaden ? TOP_NOTES_BROADEN : TOP_NOTES)
      if (ranked.length === 0) return { notes: [], collections: [] }

      const ids = ranked.map(([id]) => id)
      const placeholders = ids.map(() => '?').join(', ')
      const titles = new Map(
        (
          db.prepare(`SELECT id, title FROM notes WHERE id IN (${placeholders})`).all(...ids) as {
            id: string
            title: string
          }[]
        ).map((r) => [r.id, r.title])
      )
      const notes: RelatedNote[] = ranked.map(([id, entry]) => ({
        noteId: id,
        title: titles.get(id) ?? 'Untitled',
        score: entry.score
      }))

      // Collections rollup: memberships of the related notes minus this note's own.
      const memberships = db
        .prepare(
          `SELECT nc.note_id, nc.collection_id, col.name
           FROM note_collections nc
           JOIN collections col ON col.id = nc.collection_id
           WHERE nc.note_id IN (${placeholders})
             AND nc.collection_id NOT IN (SELECT collection_id FROM note_collections WHERE note_id = ?)`
        )
        .all(...ids, noteId) as { note_id: string; collection_id: string; name: string }[]
      const byCollection = new Map<string, RelatedCollection>()
      for (const m of memberships) {
        const noteScore = candidates.get(m.note_id)?.score ?? 0
        const existing = byCollection.get(m.collection_id)
        if (!existing) {
          byCollection.set(m.collection_id, { collectionId: m.collection_id, name: m.name, score: noteScore })
        } else {
          existing.score = Math.max(existing.score, noteScore)
        }
      }
      const collections = [...byCollection.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_COLLECTIONS)

      return { notes, collections }
    }
  }
}

export type RelatedService = ReturnType<typeof createRelatedService>
