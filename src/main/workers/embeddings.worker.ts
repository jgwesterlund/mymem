/**
 * Embeddings worker — Electron utilityProcess entry, built as its OWN rollup
 * input (out/main/embeddings.worker.js, never bundled into main's index.js).
 *
 * Runs transformers.js + all-MiniLM-L6-v2 q8 (384-dim) so a native onnxruntime
 * crash can never take down the app; the supervisor (embedderClient) restarts
 * us with backoff. No 'electron' imports here — plain Node + process.parentPort.
 * The model cache dir arrives via argv (a utilityProcess has no electron 'app').
 */
import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import type { WorkerMessage, WorkerRequest, WorkerState } from './embeddingsProtocol'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const modelsDir = process.argv[2] ?? process.env.MYMEM_MODELS_DIR ?? ''

const parentPort = process.parentPort
const reply = (msg: WorkerMessage): void => parentPort.postMessage(msg)

let state: WorkerState = 'idle'
let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null

/** Lazy-load (and on first run download) the pipeline; a failed load is retryable. */
function loadPipeline(): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise) return pipelinePromise
  state = 'loading'
  pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers')
    if (modelsDir) env.cacheDir = modelsDir
    const extractor = (await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      cache_dir: modelsDir || undefined,
      progress_callback: (info) => {
        // 'progress_total' aggregates 0..100 across every model file in the download.
        if (info.status === 'progress_total') {
          reply({ op: 'progress', progress: Math.min(info.progress / 100, 1) })
        }
      }
    })) as FeatureExtractionPipeline
    state = 'ready'
    return extractor
  })()
  pipelinePromise.catch(() => {
    state = 'error'
    pipelinePromise = null // next warmup/embed retries (e.g. offline on first run)
  })
  return pipelinePromise
}

/** Mean-pooled, L2-normalized vectors, concatenated into one Float32 buffer. */
async function embed(texts: string[]): Promise<{ dims: number; buffer: ArrayBuffer }> {
  const extractor = await loadPipeline()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  const dims = output.dims[output.dims.length - 1]!
  const data = output.data as Float32Array
  // Copy out exactly [n, dims] floats — ort can hand back a view into a larger pool.
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + texts.length * dims * 4)
  return { dims, buffer: buffer as ArrayBuffer }
}

parentPort.on('message', (event: Electron.MessageEvent) => {
  const req = event.data as WorkerRequest
  void (async () => {
    try {
      switch (req.op) {
        case 'embed': {
          const { dims, buffer } = await embed(req.texts)
          reply({ id: req.id, ok: true, dims, buffer })
          break
        }
        case 'warmup':
          await loadPipeline()
          reply({ id: req.id, ok: true })
          break
        case 'status':
          reply({ id: req.id, ok: true, state })
          break
      }
    } catch (err) {
      reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
})
