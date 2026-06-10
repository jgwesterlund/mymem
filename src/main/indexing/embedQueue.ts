import type Database from 'better-sqlite3'
import { uuidv7 } from 'uuidv7'
import { push } from '../ipc/registry'
import type { EmbedderClient } from './embedderClient'

/**
 * Drains the embedded=0 backlog in batches of 16: embed '{title} > {heading_path}\n{text}'
 * per chunk, then store vector + flip the flag in ONE transaction. Kicked after every
 * indexer job, when the worker becomes ready, and on boot if a backlog exists.
 * Chunk rows are immutable (the indexer deletes + reinserts), BUT rowids get REUSED
 * by SQLite after delete+reinsert — so the store transaction re-checks chunk IDENTITY
 * (text_hash), not mere existence. A chunk re-chunked mid-embed keeps embedded=0 and
 * is picked up by the next drain; its stale vector is never attached (review C1).
 */
const BATCH_SIZE = 16
const PROGRESS_MIN_BACKLOG = 10

type PendingChunk = { id: number; title: string; heading_path: string; text: string; text_hash: string }

export function createEmbedQueue(db: Database.Database, embedder: EmbedderClient) {
  const countPending = db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE embedded = 0`)
  const selectBatch = db.prepare(
    `SELECT id, title, heading_path, text, text_hash FROM chunks WHERE embedded = 0 ORDER BY id LIMIT ${BATCH_SIZE}`
  )
  const chunkHash = db.prepare(`SELECT text_hash FROM chunks WHERE id = ?`)
  const deleteVec = db.prepare(`DELETE FROM chunks_vec WHERE rowid = ?`)
  const insertVec = db.prepare(`INSERT INTO chunks_vec (rowid, embedding) VALUES (?, vec_f32(?))`)
  const markEmbedded = db.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ?`)

  const storeBatch = db.transaction((rows: PendingChunk[], vectors: Float32Array[]): void => {
    rows.forEach((row, i) => {
      const cur = chunkHash.get(row.id) as { text_hash: string } | undefined
      // Identity check: rowids are reused after delete+reinsert, so the row at this id
      // may now be a DIFFERENT chunk (still embedded=0) — skip, next drain embeds it.
      if (cur?.text_hash !== row.text_hash) return
      const v = vectors[i]!
      // BigInt rowid: better-sqlite3 binds plain numbers as doubles and vec0
      // rejects FLOAT primary keys; Buffer binds as a raw float32 BLOB.
      deleteVec.run(BigInt(row.id))
      insertVec.run(BigInt(row.id), Buffer.from(v.buffer, v.byteOffset, v.byteLength))
      markEmbedded.run(row.id)
    })
  })

  let running = false
  let rerun = false

  async function drain(): Promise<void> {
    const total = (countPending.get() as { n: number }).n
    if (total === 0) return
    const jobId = uuidv7()
    const report = total > PROGRESS_MIN_BACKLOG
    let done = 0
    if (report) push('index:progress', { jobId, phase: 'embedding', done, total })
    while (embedder.status().state === 'ready') {
      const rows = selectBatch.all() as PendingChunk[]
      if (rows.length === 0) {
        if (report) push('index:progress', { jobId, phase: 'embedding', done: total, total })
        return
      }
      const texts = rows.map((r) => `${r.title} > ${r.heading_path}\n${r.text}`)
      let vectors: Float32Array[]
      try {
        vectors = await embedder.embed(texts)
      } catch (err) {
        // Worker died/timed out mid-drain — the ready status change re-kicks us.
        // Terminal progress push so the sidebar badge doesn't stick at a stale count.
        if (report) push('index:progress', { jobId, phase: 'embedding', done: total, total })
        console.error('[embedQueue] embed batch failed, pausing drain', err)
        return
      }
      storeBatch(rows, vectors)
      done = Math.min(done + rows.length, total)
      if (report) push('index:progress', { jobId, phase: 'embedding', done, total })
    }
    // Loop exited on a non-ready worker — close out the badge.
    if (report) push('index:progress', { jobId, phase: 'embedding', done: total, total })
  }

  return {
    /** Start (or queue a re-run of) the drain loop. No-op unless the worker is ready. */
    kick(): void {
      if (embedder.status().state !== 'ready') return
      if (running) {
        rerun = true
        return
      }
      running = true
      void (async () => {
        try {
          do {
            rerun = false
            await drain()
          } while (rerun)
        } catch (err) {
          console.error('[embedQueue] drain failed', err)
        } finally {
          running = false
        }
      })()
    },

    pendingCount(): number {
      return (countPending.get() as { n: number }).n
    }
  }
}

export type EmbedQueue = ReturnType<typeof createEmbedQueue>
