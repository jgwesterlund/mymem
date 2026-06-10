/**
 * Message protocol between main (embedderClient supervisor) and the embeddings
 * utilityProcess. Types only — the worker must not import anything that drags
 * 'electron' into its bundle, and main must not import the worker.
 */

export type WorkerState = 'idle' | 'loading' | 'ready' | 'error'

export type WorkerRequest =
  | { id: number; op: 'embed'; texts: string[] }
  | { id: number; op: 'warmup' }
  | { id: number; op: 'status' }

export type WorkerResponse =
  | { id: number; ok: true; dims?: number; buffer?: ArrayBuffer; state?: WorkerState }
  | { id: number; ok: false; error: string }

/** Unsolicited push while the model downloads on first run. */
export type WorkerProgress = { op: 'progress'; progress: number }

export type WorkerMessage = WorkerResponse | WorkerProgress
