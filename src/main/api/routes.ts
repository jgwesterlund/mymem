/**
 * Local agent API (M6): route table for the unix-socket HTTP server.
 *
 * Every route goes through the SAME services as the renderer IPC handlers —
 * never raw SQL — so indexing, session versions, the trashed guard and
 * data:changed (origin 'api') behave identically to UI edits. Agents address
 * collections by NAME (created on demand for writes); note ids stay UUIDv7.
 * JSON in/out, markdown in content fields, error shape { error: string }.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { app } from 'electron'
import type { Services } from '../ipc/handlers'
import { emitDataChanged } from '../ipc/registry'

/** The slice of Services the API needs. embedder is optional so the smoke leg can omit it. */
export type ApiServices = Pick<
  Services,
  'notes' | 'collections' | 'pins' | 'search' | 'related' | 'indexer' | 'versionsService'
> & { embedder?: Services['embedder'] }

const MAX_BODY_BYTES = 5 * 1024 * 1024

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

/** Buffer + parse a JSON body; over-cap bodies are drained (counted, not kept) and 413'd. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let overLimit = false
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        overLimit = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (overLimit) return reject(new HttpError(413, 'request body too large (max 5 MB)'))
      if (total === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ── Body/query validation helpers ────────────────────────────────────────────

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object')
  }
  return body as Record<string, unknown>
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`)
  return v
}

function optNameArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new HttpError(400, `${field} must be an array of strings`)
  }
  const names = (v as string[]).map((n) => n.trim())
  if (names.some((n) => n === '')) throw new HttpError(400, `${field} must not contain blank names`)
  return names
}

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative integer`)
  return n
}

export function createApiHandler(s: ApiServices) {
  /** Resolve collection names → ids, creating missing ones (agents think in names, not ids). */
  function resolveOrCreateCollections(names: string[]): { ids: string[]; createdIds: string[] } {
    const ids: string[] = []
    const createdIds: string[] = []
    for (const name of names) {
      const existing = s.collections.getByName(name)
      if (existing) {
        ids.push(existing.id)
      } else {
        const created = s.collections.create({ name })
        ids.push(created.id)
        createdIds.push(created.id)
      }
    }
    return { ids, createdIds }
  }

  /** Full note payload: note + collectionIds + collectionNames (404 when missing). */
  function fullNote(id: string): Record<string, unknown> {
    const note = s.notes.getWithRefs(id)
    if (!note) throw new HttpError(404, `note not found: ${id}`)
    const collectionNames = note.collectionIds.map((cid) => s.collections.get(cid)?.name ?? cid)
    return { ...note, collectionNames }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mymem.local')
    const method = req.method ?? 'GET'
    let seg: string[]
    try {
      seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      // decodeURIComponent throws URIError on malformed escapes (e.g. /notes/%E0)
      throw new HttpError(400, `malformed percent-encoding in path: ${url.pathname}`)
    }

    // ── GET /status ──
    if (seg.length === 1 && seg[0] === 'status' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        version: app.getVersion(),
        notes: s.notes.list({ scope: 'all', limit: 1 }).total,
        pendingIndex: s.indexer.pendingCount(),
        embeddings: s.embedder?.status().state ?? 'disabled'
      })
    }

    // ── GET /search?q=&mode=keyword|deep&collectionId=&limit= ──
    if (seg.length === 1 && seg[0] === 'search' && method === 'GET') {
      const q = url.searchParams.get('q')
      if (!q || q.trim() === '') throw new HttpError(400, 'missing query parameter: q')
      const mode = url.searchParams.get('mode') ?? 'keyword'
      if (mode !== 'keyword' && mode !== 'deep') {
        throw new HttpError(400, `mode must be 'keyword' or 'deep', got '${mode}'`)
      }
      const collectionId = url.searchParams.get('collectionId') ?? undefined
      const limit = intParam(url, 'limit')
      // Deep degrades to keyword exactly like the UI (no ready worker / embed failure).
      const out =
        mode === 'deep'
          ? await s.search.deep(q, collectionId, limit)
          : { results: s.search.keyword(q, collectionId, limit), usedMode: 'keyword' as const }
      return send(res, 200, out)
    }

    // ── GET /pins ── pin order, titles/names resolved so agents need no second lookup.
    if (seg.length === 1 && seg[0] === 'pins' && method === 'GET') {
      const pins = s.pins.list().map((p) => ({
        ...p,
        title:
          p.itemType === 'note'
            ? (s.notes.get(p.itemId)?.title ?? '')
            : (s.collections.get(p.itemId)?.name ?? '')
      }))
      return send(res, 200, pins)
    }

    // ── /collections ──
    if (seg.length === 1 && seg[0] === 'collections') {
      if (method === 'GET') return send(res, 200, s.collections.list())
      if (method === 'POST') {
        const body = asRecord(await readBody(req))
        const name = optString(body.name, 'name')?.trim()
        if (!name) throw new HttpError(400, 'name is required')
        if (s.collections.getByName(name)) throw new HttpError(409, `collection already exists: ${name}`)
        const created = s.collections.create({ name, description: optString(body.description, 'description') })
        emitDataChanged({ entity: 'collection', ids: [created.id], op: 'create', origin: 'api' })
        return send(res, 201, created)
      }
    }

    // ── /notes … ──
    if (seg[0] === 'notes') {
      // GET /notes?scope=all|collection|trash&collectionId=&limit=&offset=
      if (seg.length === 1 && method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'all'
        if (scope !== 'all' && scope !== 'collection' && scope !== 'trash') {
          throw new HttpError(400, `scope must be all|collection|trash, got '${scope}'`)
        }
        const collectionId = url.searchParams.get('collectionId') ?? undefined
        if (scope === 'collection' && !collectionId) {
          throw new HttpError(400, 'scope=collection requires collectionId')
        }
        return send(
          res,
          200,
          s.notes.list({ scope, collectionId, limit: intParam(url, 'limit'), offset: intParam(url, 'offset') })
        )
      }

      // POST /notes { title?, contentMd?, collectionNames? }
      if (seg.length === 1 && method === 'POST') {
        const body = asRecord(await readBody(req))
        const title = optString(body.title, 'title')
        const contentMd = optString(body.contentMd, 'contentMd')
        const collectionNames = optNameArray(body.collectionNames, 'collectionNames')
        const note = s.notes.create({ title, contentMd })
        if (collectionNames?.length) {
          const { ids, createdIds } = resolveOrCreateCollections(collectionNames)
          s.collections.setForNote(note.id, ids)
          if (createdIds.length > 0) {
            emitDataChanged({ entity: 'collection', ids: createdIds, op: 'create', origin: 'api' })
          }
        }
        s.indexer.enqueue(note.id)
        emitDataChanged({ entity: 'note', ids: [note.id], op: 'create', origin: 'api' })
        return send(res, 201, fullNote(note.id))
      }

      const id = seg[1]
      if (!id) throw new HttpError(404, `not found: ${method} ${url.pathname}`)

      // GET /notes/:id
      if (seg.length === 2 && method === 'GET') {
        return send(res, 200, fullNote(id))
      }

      // PATCH /notes/:id { mode: 'replace'|'append', contentMd?, title? }
      if (seg.length === 2 && method === 'PATCH') {
        const body = asRecord(await readBody(req))
        const existing = s.notes.get(id)
        if (!existing) throw new HttpError(404, `note not found: ${id}`)
        if (existing.trashedAt !== null) {
          throw new HttpError(409, `note is in the trash — restore it in the app before editing: ${id}`)
        }
        const title = optString(body.title, 'title')
        const contentMd = optString(body.contentMd, 'contentMd')
        if (title === undefined && contentMd === undefined) {
          throw new HttpError(400, 'nothing to update — provide contentMd and/or title')
        }
        const mode = optString(body.mode, 'mode')
        if (mode !== undefined && mode !== 'replace' && mode !== 'append') {
          throw new HttpError(400, `mode must be 'replace' or 'append', got '${mode}'`)
        }
        if (contentMd !== undefined && mode === undefined) {
          throw new HttpError(400, "mode is required when contentMd is set ('replace' or 'append')")
        }
        const patch: { title?: string; contentMd?: string; titleSource?: 'user' } = {}
        if (title !== undefined) {
          patch.title = title
          // Parity with the notes:update IPC handler (deliberate): any explicit
          // title edit — human or agent — pins title_source to 'user' so AI
          // titling (M8) will not overwrite it.
          patch.titleSource = 'user'
        }
        if (contentMd !== undefined) {
          patch.contentMd =
            mode === 'append'
              ? existing.contentMd === ''
                ? contentMd
                : `${existing.contentMd}\n\n${contentMd}`
              : contentMd
          // Session-snapshot of the PRE-edit state, BEFORE the write — same policy
          // as notes:update. Title-only patches never snapshot.
          s.versionsService.onContentEdit(id)
        }
        // No CAS: the API is last-writer at the HTTP level; an open dirty editor
        // gets the origin-'api' reload banner instead of silent clobbering.
        s.notes.update(id, patch)
        s.indexer.enqueue(id)
        emitDataChanged({ entity: 'note', ids: [id], op: 'update', origin: 'api' })
        return send(res, 200, fullNote(id))
      }

      // DELETE /notes/:id → soft delete (trash). Idempotent on already-trashed notes.
      if (seg.length === 2 && method === 'DELETE') {
        const note = s.notes.get(id)
        if (!note) throw new HttpError(404, `note not found: ${id}`)
        if (note.trashedAt === null) {
          s.notes.trash(id)
          emitDataChanged({ entity: 'note', ids: [id], op: 'trash', origin: 'api' })
        }
        return send(res, 200, { ok: true })
      }

      // PUT /notes/:id/pin { pinned } — notes only in v1 (collections pin via the UI).
      // Unlike the IPC path (pins:set emits inside its handler), the API route
      // emits its own data:changed with origin 'api' — same pattern as every
      // other route here, and what keeps open windows' pin state live.
      if (seg.length === 3 && seg[2] === 'pin' && method === 'PUT') {
        const body = asRecord(await readBody(req))
        if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be a boolean')
        const note = s.notes.get(id)
        if (!note) throw new HttpError(404, `note not found: ${id}`)
        // Trash already cleared any pin, so unpinning a trashed note is an
        // idempotent no-op; PINNING one is rejected like PATCH on it.
        if (body.pinned && note.trashedAt !== null) {
          throw new HttpError(409, `note is in the trash — restore it in the app before pinning: ${id}`)
        }
        s.pins.set('note', id, body.pinned)
        emitDataChanged({ entity: 'pin', ids: [id], op: 'update', origin: 'api' })
        return send(res, 200, fullNote(id))
      }

      // GET /notes/:id/related?broaden=
      if (seg.length === 3 && seg[2] === 'related' && method === 'GET') {
        if (!s.notes.get(id)) throw new HttpError(404, `note not found: ${id}`)
        const broaden = ['1', 'true'].includes(url.searchParams.get('broaden') ?? '')
        return send(res, 200, s.related.forNote(id, broaden))
      }

      // POST /notes/:id/collections { add: [names], remove: [names] } — membership by NAME.
      if (seg.length === 3 && seg[2] === 'collections' && method === 'POST') {
        const body = asRecord(await readBody(req))
        if (!s.notes.get(id)) throw new HttpError(404, `note not found: ${id}`)
        const add = optNameArray(body.add, 'add') ?? []
        const remove = optNameArray(body.remove, 'remove') ?? []
        if (add.length === 0 && remove.length === 0) {
          throw new HttpError(400, 'nothing to change — provide add and/or remove (collection names)')
        }
        const { ids: addIds, createdIds } = resolveOrCreateCollections(add)
        // Unknown names on remove are a no-op, not an error (the goal state already holds).
        const removeIds = remove
          .map((name) => s.collections.getByName(name)?.id)
          .filter((cid): cid is string => cid !== undefined)
        s.collections.bulk([id], addIds, removeIds)
        if (createdIds.length > 0) {
          emitDataChanged({ entity: 'collection', ids: createdIds, op: 'create', origin: 'api' })
        }
        emitDataChanged({ entity: 'note', ids: [id], op: 'update', origin: 'api' })
        return send(res, 200, fullNote(id))
      }
    }

    throw new HttpError(404, `not found: ${method} ${url.pathname}`)
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error('[api] unhandled error', err)
      send(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
    })
  }
}
