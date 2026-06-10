import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, utilityProcess } from 'electron'
import type { EmbeddingsStatus } from '@shared/types'
import type { WorkerMessage, WorkerRequest, WorkerResponse } from '../workers/embeddingsProtocol'

/**
 * Supervisor for the embeddings utilityProcess: id-correlated request/response
 * over postMessage, per-request timeouts, and crash recovery with exponential
 * backoff (1s/5s/30s, max 5 attempts → state 'error'). The worker is only
 * spawned once the user has consented to the model download
 * (settings 'embeddings.consent' — handlers gates start()).
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const DIM = 384
const EMBED_TIMEOUT_MS = 60_000
const WARMUP_TIMEOUT_MS = 10 * 60_000 // first run downloads ~23 MB
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000]
const MAX_RESTARTS = 5

type Pending = {
  resolve: (res: WorkerResponse & { ok: true }) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createEmbedderClient(opts?: { workerPath?: string; modelsDir?: string }) {
  // Both the main bundle and the worker land in out/main — sibling resolution
  // works identically in dev and packaged builds.
  const workerPath = opts?.workerPath ?? join(import.meta.dirname, 'embeddings.worker.js')
  const modelsDir = opts?.modelsDir ?? join(app.getPath('userData'), 'models')

  let proc: Electron.UtilityProcess | null = null
  let status: EmbeddingsStatus = { state: 'disabled', model: MODEL_ID, dim: DIM }
  let nextId = 1
  const pending = new Map<number, Pending>()
  let restarts = 0
  let restartTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let disabled = false // consent toggled off — deliberate exit, no restart
  const statusListeners = new Set<(s: EmbeddingsStatus) => void>()

  function setStatus(next: EmbeddingsStatus): void {
    status = next
    for (const cb of statusListeners) cb(status)
  }

  function send(req: WorkerRequest, timeoutMs: number): Promise<WorkerResponse & { ok: true }> {
    return new Promise((resolve, reject) => {
      if (!proc) {
        reject(new Error('embeddings worker is not running'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(req.id)
        reject(new Error(`embeddings request timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(req.id, { resolve, reject, timer })
      proc.postMessage(req)
    })
  }

  function onMessage(msg: WorkerMessage): void {
    if ('op' in msg) {
      if (status.state === 'downloading') setStatus({ ...status, progress: msg.progress })
      return
    }
    const p = pending.get(msg.id)
    if (!p) return // late reply after timeout — drop
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg)
    else p.reject(new Error(msg.error))
  }

  function rejectInFlight(reason: string): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    pending.clear()
  }

  function onExit(code: number): void {
    proc = null
    rejectInFlight(`embeddings worker exited (code ${code})`)
    if (stopped || disabled) return
    if (restarts >= MAX_RESTARTS) {
      setStatus({
        state: 'error',
        model: MODEL_ID,
        dim: DIM,
        error: `embeddings worker keeps crashing (last exit code ${code})`
      })
      return
    }
    const delay = RESTART_BACKOFF_MS[Math.min(restarts, RESTART_BACKOFF_MS.length - 1)]!
    restarts++
    setStatus({ state: 'downloading', model: MODEL_ID, dim: DIM }) // restarting; embed() rejects meanwhile
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (!stopped && !proc) spawn()
    }, delay)
  }

  // Warmup drives the lazy model load so the download starts now, not on first query.
  // The worker resets its pipeline promise on failure, so re-issuing warmup retries
  // the download — this is the Retry path for a live-but-errored worker (offline run).
  function warmup(child: NonNullable<typeof proc>): void {
    setStatus({ state: 'downloading', model: MODEL_ID, dim: DIM, progress: 0 })
    void send({ id: nextId++, op: 'warmup' }, WARMUP_TIMEOUT_MS)
      .then(() => {
        if (proc !== child) return // superseded by a restart
        restarts = 0
        setStatus({ state: 'ready', model: MODEL_ID, dim: DIM })
      })
      .catch((err: unknown) => {
        // Worker alive but the model failed to load (offline first run, disk full…).
        // A crash lands in onExit instead, which owns the restart/backoff path.
        if (proc !== child) return
        setStatus({
          state: 'error',
          model: MODEL_ID,
          dim: DIM,
          error: err instanceof Error ? err.message : String(err)
        })
      })
  }

  function spawn(): void {
    mkdirSync(modelsDir, { recursive: true })
    const child = utilityProcess.fork(workerPath, [modelsDir], { serviceName: 'myMem embeddings' })
    proc = child
    child.on('message', onMessage)
    child.on('exit', onExit)
    warmup(child)
  }

  return {
    /** Spawn the worker — or, on a live-but-errored worker, retry the model load. */
    start(): void {
      if (stopped || restartTimer) return
      disabled = false
      if (proc) {
        if (status.state === 'error') {
          restarts = 0
          warmup(proc)
        }
        return
      }
      restarts = 0 // an explicit (re)start resets the backoff budget
      spawn()
    },

    /** Disable without finality (consent toggled off): kill the worker, stay restartable. */
    disable(): void {
      disabled = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      rejectInFlight('embeddings disabled')
      const child = proc
      proc = null // cleared BEFORE kill so onExit doesn't schedule a restart
      child?.kill()
      setStatus({ state: 'disabled', model: MODEL_ID, dim: DIM })
    },

    /** Final shutdown on app quit — no restarts after this. */
    stop(): void {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      rejectInFlight('app quitting')
      proc?.kill()
      proc = null
      // 'disabled' makes any post-quit drain kick a no-op (the DB is about to close).
      setStatus({ state: 'disabled', model: MODEL_ID, dim: DIM })
    },

    status(): EmbeddingsStatus {
      return status
    },

    onStatusChange(cb: (s: EmbeddingsStatus) => void): () => void {
      statusListeners.add(cb)
      return () => statusListeners.delete(cb)
    },

    /** One normalized Float32Array(384) per text. Throws unless state is 'ready'. */
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (status.state !== 'ready') {
        throw new Error(`embeddings worker not ready (state: ${status.state})`)
      }
      const res = await send({ id: nextId++, op: 'embed', texts }, EMBED_TIMEOUT_MS)
      const dims = res.dims ?? DIM
      if (dims !== DIM) throw new Error(`embedding dim mismatch: worker returned ${dims}, expected ${DIM}`)
      const all = new Float32Array(res.buffer!)
      if (all.length !== texts.length * dims) {
        throw new Error(`embedding result has unexpected length ${all.length}`)
      }
      return texts.map((_, i) => all.subarray(i * dims, (i + 1) * dims))
    },

    /** Worker pid — exists so the smoke test can SIGKILL it and assert recovery. */
    pid(): number | undefined {
      return proc?.pid
    }
  }
}

export type EmbedderClient = ReturnType<typeof createEmbedderClient>
