/**
 * CI smoke: proves the two fragile dependency classes work inside this exact Electron:
 *  1. @earendil-works/pi-ai (ESM-only, engines node>=22.19) imports and resolves models.
 *  2. better-sqlite3 (native, ABI-pinned) opens a DB and loads the sqlite-vec extension.
 * Run with: MYMEM_SMOKE=1 electron .  (exits 0 on success, 1 on failure)
 */
export async function runSmoke(): Promise<number> {
  try {
    console.log(`[smoke] electron=${process.versions.electron} node=${process.versions.node}`)

    const { getModel, getProviders } = await import('@earendil-works/pi-ai')
    const providers = getProviders()
    if (!providers.includes('openai-codex')) {
      throw new Error(`pi-ai catalog missing openai-codex provider (got ${providers.length} providers)`)
    }
    const model = getModel('openai-codex', 'gpt-5.5')
    console.log(`[smoke] pi-ai OK — ${providers.length} providers, codex model: ${model.id}`)

    const oauth = await import('@earendil-works/pi-ai/oauth')
    if (typeof oauth.loginOpenAICodex !== 'function') {
      throw new Error('pi-ai/oauth missing loginOpenAICodex export')
    }
    console.log('[smoke] pi-ai/oauth OK — loginOpenAICodex present')

    const Database = (await import('better-sqlite3')).default
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (x TEXT); INSERT INTO t VALUES (\'hi\')')
    const row = db.prepare('SELECT x FROM t').get() as { x: string }
    if (row.x !== 'hi') throw new Error('better-sqlite3 roundtrip failed')

    const fts = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS v").get() as { v: number }
    if (fts.v !== 1) throw new Error('SQLite built without FTS5')

    const { loadSqliteVec } = await import('./db/sqliteVec')
    loadSqliteVec(db)
    const vv = db.prepare('SELECT vec_version() AS v').get() as { v: string }
    const sv = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    console.log(`[smoke] better-sqlite3 OK — sqlite ${sv.v}, FTS5 on, sqlite-vec ${vv.v}`)

    db.close()

    await smokeDataSpine()
    await smokeApiAndCli()
    await smokeChatAgent()
    await smokeAiFeatures()

    // Real end-to-end embeddings (network, ~23 MB model download) — opt-in only.
    if (process.env.MYMEM_SMOKE_EMBED) await smokeRealEmbeddings()

    console.log('[smoke] ALL OK')
    return 0
  } catch (err) {
    console.error('[smoke] FAILED:', err)
    return 1
  }
}

function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (cond()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${what}`))
      setTimeout(tick, 200)
    }
    tick()
  })
}

/**
 * MYMEM_SMOKE_EMBED=1: spawn the real utilityProcess worker, download/load the
 * model (cached in userData/models), drain the embed queue, run deep search +
 * related over real vectors, then SIGKILL the worker and assert the supervisor
 * recovers. Too heavy for the default CI smoke, which uses synthetic vectors.
 */
async function smokeRealEmbeddings(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'mymem-smoke-embed-'))
  process.env.MYMEM_DB_PATH = join(dir, 'smoke.db')
  const { createEmbedderClient } = await import('./indexing/embedderClient')
  const embedder = createEmbedderClient()
  try {
    const { getDb } = await import('./db/connection')
    const { createNotesRepo } = await import('./db/repos/notesRepo')
    const { createIndexer } = await import('./indexing/indexer')
    const { createEmbedQueue } = await import('./indexing/embedQueue')
    const { createSearchService } = await import('./search/searchService')
    const { createRelatedService } = await import('./search/relatedService')

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const queue = createEmbedQueue(dbi, embedder)
    const indexer = createIndexer(dbi, () => queue.kick())
    const search = createSearchService(dbi, embedder)
    const related = createRelatedService(dbi, embedder)

    const grocery = notes.create({
      title: 'Grocery list',
      contentMd: 'Buy milk, eggs, bread and cheese for cooking dinner this week.'
    })
    const meals = notes.create({
      title: 'Meal planning',
      contentMd: 'Weekly dinner recipes: pasta with tomatoes, vegetable curry, roasted potatoes.'
    })
    const revenue = notes.create({
      title: 'Quarterly revenue',
      contentMd: 'Q3 revenue forecast spreadsheet, budget assumptions and headcount plan.'
    })
    for (const n of [grocery, meals, revenue]) indexer.flushNote(n.id)

    let lastLogged = -1
    embedder.onStatusChange((st) => {
      if (st.state === 'downloading' && st.progress !== undefined) {
        const pct = Math.floor(st.progress * 10) * 10
        if (pct > lastLogged) {
          lastLogged = pct
          console.log(`[smoke-embed] model download ${pct}%`)
        }
      }
      if (st.state === 'ready') queue.kick()
    })
    console.log('[smoke-embed] starting worker (first run downloads ~23 MB)…')
    embedder.start()
    await waitFor(() => embedder.status().state === 'ready', 5 * 60_000, 'worker ready')
    queue.kick()
    await waitFor(() => queue.pendingCount() === 0, 120_000, 'embed backlog drained')
    console.log('[smoke-embed] worker ready, backlog embedded')

    const deep = await search.deep('food and cooking')
    if (deep.usedMode !== 'deep') throw new Error(`deep search used mode ${deep.usedMode}`)
    if (deep.results.length === 0) throw new Error('deep search returned nothing')
    console.log(
      '[smoke-embed] deep("food and cooking") →',
      deep.results.map((r) => `${r.title} (${r.score.toFixed(4)})`).join(' · ')
    )
    if (deep.results[0]!.noteId === revenue.id) {
      throw new Error('deep search ranked the revenue note first for a food query')
    }

    const rel = related.forNote(grocery.id, true) // broaden — real MiniLM sims are fuzzy
    console.log(
      '[smoke-embed] related(grocery, broaden) →',
      rel.notes.map((n) => `${n.title} (${n.score.toFixed(3)})`).join(' · ') || '(none)'
    )
    if (!rel.notes.some((n) => n.noteId === meals.id)) throw new Error('related missed the meal-planning note')
    if (rel.notes.some((n) => n.noteId === grocery.id)) throw new Error('related included the note itself')

    // kill -9 → supervisor restarts with backoff and embeds again (M5 done-criterion)
    const pid = embedder.pid()
    if (!pid) throw new Error('embedder exposed no worker pid')
    console.log(`[smoke-embed] SIGKILL worker pid ${pid}`)
    process.kill(pid, 'SIGKILL')
    await waitFor(() => embedder.status().state !== 'ready', 10_000, 'worker reported down')
    await waitFor(() => embedder.status().state === 'ready', 120_000, 'worker recovered')
    const vecs = await embedder.embed(['recovery probe'])
    if (vecs[0]!.length !== 384) throw new Error('post-recovery embed has wrong dimension')
    console.log('[smoke-embed] kill -9 recovery OK — worker restarted and embeds again')
  } finally {
    embedder.stop()
    const { closeDb } = await import('./db/connection')
    closeDb()
    delete process.env.MYMEM_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * M6: the REAL api server on a temp unix socket (MYMEM_SOCKET) over a temp DB
 * and real services, exercised in-process with Node http; then — when `go` is
 * on PATH — the real `mym` binary is built and run against the same socket.
 */
async function smokeApiAndCli(): Promise<void> {
  const { mkdtempSync, rmSync, statSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const http = await import('node:http')
  const { execFile, execFileSync } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { app } = await import('electron')
  const execFileAsync = promisify(execFile)

  const dir = mkdtempSync(join(tmpdir(), 'mymem-smoke-api-'))
  process.env.MYMEM_DB_PATH = join(dir, 'smoke.db')
  const sock = join(dir, 'api.sock')
  process.env.MYMEM_SOCKET = sock
  let drainIndexer: (() => void) | null = null
  try {
    const { getDb } = await import('./db/connection')
    const { createNotesRepo } = await import('./db/repos/notesRepo')
    const { createCollectionsRepo } = await import('./db/repos/collectionsRepo')
    const { createPinsRepo, createVersionsRepo } = await import('./db/repos/miscRepos')
    const { createIndexer } = await import('./indexing/indexer')
    const { createSearchService } = await import('./search/searchService')
    const { createRelatedService } = await import('./search/relatedService')
    const { createVersionsService } = await import('./services/versionsService')
    const { startApiServer } = await import('./api/server')

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const collections = createCollectionsRepo(dbi)
    const pins = createPinsRepo(dbi)
    const versions = createVersionsRepo(dbi)
    const indexer = createIndexer(dbi)
    drainIndexer = () => indexer.flushAll() // pending 2 s debounce timers must not outlive closeDb
    const search = createSearchService(dbi) // no embedder → deep must fall back to keyword
    const related = createRelatedService(dbi)
    const versionsService = createVersionsService(dbi, { notes, versions })

    const started = await startApiServer({ notes, collections, pins, search, related, indexer, versionsService })
    if (!started) throw new Error('api server did not start on the smoke socket')
    if ((statSync(sock).mode & 0o777) !== 0o600) throw new Error('api socket is not chmod 0600')

    type Res = { status: number; json: any }
    const req = (method: string, path: string, body?: unknown): Promise<Res> =>
      new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const r = http.request(
          {
            socketPath: sock,
            path,
            method,
            headers: payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}
          },
          (res) => {
            let data = ''
            res.setEncoding('utf8')
            res.on('data', (c) => (data += c))
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null })
              } catch (err) {
                reject(err)
              }
            })
          }
        )
        r.on('error', reject)
        if (payload) r.write(payload)
        r.end()
      })

    // status
    const st = await req('GET', '/status')
    if (st.status !== 200 || st.json.ok !== true) throw new Error('GET /status failed')
    if (st.json.embeddings !== 'disabled') throw new Error(`status embeddings should be disabled, got ${st.json.embeddings}`)
    if (st.json.notes !== 0) throw new Error('fresh DB should report 0 notes')

    // create with collection names (resolve-or-create)
    const created = await req('POST', '/notes', {
      title: 'API smoke note',
      contentMd: 'unix socket payload apifindme',
      collectionNames: ['API Col']
    })
    if (created.status !== 201) throw new Error(`POST /notes returned ${created.status}`)
    const id: string = created.json.id
    if (!created.json.collectionNames.includes('API Col')) throw new Error('collectionNames missing on create response')

    // get
    const got = await req('GET', `/notes/${id}`)
    if (got.status !== 200 || got.json.title !== 'API smoke note') throw new Error('GET /notes/:id roundtrip failed')

    // append — session snapshot of the PRE-edit state must land first
    const appended = await req('PATCH', `/notes/${id}`, { mode: 'append', contentMd: 'tail apitail' })
    if (appended.status !== 200) throw new Error(`PATCH append returned ${appended.status}`)
    if (appended.json.contentMd !== 'unix socket payload apifindme\n\ntail apitail') {
      throw new Error('append did not join with a blank line')
    }
    const vlist = versions.list(id)
    if (vlist.length !== 1 || vlist[0]!.kind !== 'session') throw new Error('PATCH did not session-snapshot')
    if (versions.get(vlist[0]!.id)!.contentMd !== 'unix socket payload apifindme') {
      throw new Error('snapshot is not the PRE-edit state')
    }

    // searchable after indexing (flush instead of waiting out the 2 s debounce)
    indexer.flushNote(id)
    const found = await req('GET', '/search?q=apitail')
    if (found.json.usedMode !== 'keyword' || found.json.results[0]?.noteId !== id) {
      throw new Error('keyword search missed the API note after flush')
    }
    const deepFallback = await req('GET', '/search?q=apitail&mode=deep')
    if (deepFallback.json.usedMode !== 'keyword') throw new Error('deep without embedder must report usedMode keyword')
    if (deepFallback.json.results[0]?.noteId !== id) throw new Error('deep fallback returned no results')

    // collections endpoints + duplicate 409
    const cols = await req('GET', '/collections')
    if (!cols.json.some((c: any) => c.name === 'API Col' && c.noteCount === 1)) {
      throw new Error('GET /collections missing API Col with count')
    }
    const dup = await req('POST', '/collections', { name: 'api col' }) // NOCASE duplicate
    if (dup.status !== 409) throw new Error(`duplicate collection should 409, got ${dup.status}`)
    const newCol = await req('POST', '/collections', { name: 'Second Col' })
    if (newCol.status !== 201) throw new Error('POST /collections failed')

    // membership by NAME (create-on-add, unknown remove is a no-op)
    const note2 = await req('POST', '/notes', { title: 'Second note', contentMd: 'second body' })
    const addRes = await req('POST', `/notes/${note2.json.id}/collections`, { add: ['Second Col', 'Third Col'] })
    if (addRes.status !== 200) throw new Error(`membership add returned ${addRes.status}`)
    if (!addRes.json.collectionNames.includes('Second Col') || !addRes.json.collectionNames.includes('Third Col')) {
      throw new Error('membership add by name failed')
    }
    const rmRes = await req('POST', `/notes/${note2.json.id}/collections`, { remove: ['Second Col', 'Never Existed'] })
    if (rmRes.json.collectionNames.length !== 1 || rmRes.json.collectionNames[0] !== 'Third Col') {
      throw new Error('membership remove by name failed')
    }

    // related (no vectors → unavailableReason, but the route itself must work)
    const rel = await req('GET', `/notes/${id}/related?broaden=true`)
    if (rel.status !== 200 || rel.json.unavailableReason !== 'embeddings-disabled') {
      throw new Error('related route did not report embeddings-disabled')
    }

    // pins (v1.3): PUT pin → GET /pins resolves the title → 400/404 paths → unpin
    const pinOn = await req('PUT', `/notes/${id}/pin`, { pinned: true })
    if (pinOn.status !== 200 || pinOn.json.pinned !== true) throw new Error('PUT pin did not pin the note')
    const pinsOut = await req('GET', '/pins')
    if (pinsOut.status !== 200 || pinsOut.json.length !== 1) throw new Error('GET /pins missing the pinned note')
    if (pinsOut.json[0].itemType !== 'note' || pinsOut.json[0].itemId !== id || pinsOut.json[0].title !== 'API smoke note') {
      throw new Error('GET /pins did not resolve the note title')
    }
    const pinMiss = await req('PUT', '/notes/no-such-id/pin', { pinned: true })
    if (pinMiss.status !== 404 || !pinMiss.json.error) throw new Error('PUT pin on a missing note must 404')
    const pinBad = await req('PUT', `/notes/${id}/pin`, { pinned: 'yes' })
    if (pinBad.status !== 400) throw new Error('PUT pin with a non-boolean must 400')
    const pinOff = await req('PUT', `/notes/${id}/pin`, { pinned: false })
    if (pinOff.status !== 200 || pinOff.json.pinned !== false) throw new Error('PUT pin did not unpin')
    if ((await req('GET', '/pins')).json.length !== 0) throw new Error('unpin left a pin behind')
    await req('PUT', `/notes/${id}/pin`, { pinned: true }) // the DELETE below must clear it

    // trash → instantly gone from search, visible in trash scope, PATCH → 409
    const del = await req('DELETE', `/notes/${id}`)
    if (del.status !== 200 || del.json.ok !== true) throw new Error('DELETE /notes/:id failed')
    const goneSearch = await req('GET', '/search?q=apitail')
    if (goneSearch.json.results.length !== 0) throw new Error('trashed note still in search results')
    const trashList = await req('GET', '/notes?scope=trash')
    if (!trashList.json.items.some((n: any) => n.id === id)) throw new Error('trashed note missing from trash scope')
    const patchTrashed = await req('PATCH', `/notes/${id}`, { mode: 'replace', contentMd: 'x' })
    if (patchTrashed.status !== 409 || !patchTrashed.json.error.includes('trash')) {
      throw new Error('PATCH on a trashed note must 409 with a clear message')
    }
    if ((await req('GET', '/pins')).json.length !== 0) throw new Error('DELETE did not clear the pin')
    const pinTrashed = await req('PUT', `/notes/${id}/pin`, { pinned: true })
    if (pinTrashed.status !== 409) throw new Error('pinning a trashed note must 409')

    // error semantics
    const miss = await req('GET', '/notes/no-such-id')
    if (miss.status !== 404 || !miss.json.error) throw new Error('missing note must 404 with { error }')
    const badSearch = await req('GET', '/search')
    if (badSearch.status !== 400) throw new Error('search without q must 400')
    const badScope = await req('GET', '/notes?scope=collection')
    if (badScope.status !== 400) throw new Error('scope=collection without collectionId must 400')

    console.log('[smoke] M6 API OK — 0600 socket, status, create/get/append by name, session snapshot, search + deep fallback, trash 409/404, collections + membership by name, pins PUT/GET + trash clears')

    // ── Real Go binary over the same live socket ──
    let goAvailable = true
    try {
      execFileSync('go', ['version'], { stdio: 'ignore' })
    } catch {
      goAvailable = false
    }
    const cliDir = join(app.getAppPath(), 'cli')
    if (!goAvailable || !existsSync(cliDir)) {
      console.log('[smoke] M6 CLI SKIPPED — go not on PATH (or cli/ missing); install Go to exercise the mym binary')
      return
    }
    const bin = join(dir, 'mym')
    execFileSync('go', ['build', '-o', bin, '.'], { cwd: cliDir, stdio: 'inherit' })
    // MUST be async: a sync exec would block the event loop and deadlock the
    // in-process HTTP server the binary is talking to.
    const mym = async (...args: string[]): Promise<string> => {
      const { stdout } = await execFileAsync(bin, args, {
        env: { ...process.env, MYMEM_SOCKET: sock },
        encoding: 'utf8'
      })
      return stdout
    }

    const statusOut = await mym('status')
    if (!statusOut.includes('myMem v') || !statusOut.includes('embeddings: disabled')) {
      throw new Error(`mym status output unexpected: ${statusOut}`)
    }
    const cliCreated = JSON.parse(await mym('create', '--title', 'CLI smoke note', '--json', 'cli body climarker'))
    const cliId: string = cliCreated.id
    if (typeof cliId !== 'string' || cliId.length !== 36) throw new Error('mym create --json did not return a full id')
    const getOut = await mym('get', cliId)
    if (!getOut.includes('CLI smoke note') || !getOut.includes('climarker')) {
      throw new Error(`mym get output unexpected: ${getOut}`)
    }
    indexer.flushNote(cliId)
    const searchOut = await mym('search', 'climarker')
    // human listings show the LAST 8 id chars (the UUIDv7 random tail)
    if (!searchOut.includes('CLI smoke note') || !searchOut.includes(cliId.slice(-8))) {
      throw new Error(`mym search missed the CLI note: ${searchOut}`)
    }

    // pin/unpin + the 📌 marker in list (v1.3)
    const pinOut = await mym('pin', cliId.slice(-8)) // short-id resolution included
    if (!pinOut.includes('pinned') || !pinOut.includes(cliId.slice(-8))) {
      throw new Error(`mym pin output unexpected: ${pinOut}`)
    }
    if (!(await mym('list')).includes('📌 CLI smoke note')) {
      throw new Error('mym list missing the 📌 marker on the pinned note')
    }
    await mym('unpin', cliId)
    if ((await mym('list')).includes('📌')) throw new Error('📌 marker survived mym unpin')

    console.log('[smoke] M6 CLI OK — built mym, real binary ran status/create/get/search/pin/unpin over the live socket')
  } finally {
    const { stopApiServer } = await import('./api/server')
    stopApiServer()
    drainIndexer?.()
    const { closeDb } = await import('./db/connection')
    closeDb()
    delete process.env.MYMEM_DB_PATH
    delete process.env.MYMEM_SOCKET
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * M7: the chat agent with a SCRIPTED stream (zero network) over a real temp DB.
 * Proves: tool execution through the real services (ai_edit snapshot, indexer,
 * data:changed origin 'ai'), message persistence with idx ordering, citations,
 * per-turn undo, the trashed guard, the 12-iteration cap, the 80% context
 * pre-check, and the safeStorage credential roundtrip.
 */
async function smokeChatAgent(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'mymem-smoke-ai-'))
  process.env.MYMEM_DB_PATH = join(dir, 'smoke.db')
  try {
    const { getDb, closeDb } = await import('./db/connection')
    const { createNotesRepo } = await import('./db/repos/notesRepo')
    const { createCollectionsRepo } = await import('./db/repos/collectionsRepo')
    const { createSettingsRepo, createVersionsRepo } = await import('./db/repos/miscRepos')
    const { createChatsRepo } = await import('./db/repos/chatsRepo')
    const { createIndexer } = await import('./indexing/indexer')
    const { createSearchService } = await import('./search/searchService')
    const { createRag } = await import('./ai/rag')
    const { createAgent } = await import('./ai/agent')
    const { createCredentialsStore } = await import('./ai/credentials')
    const { createProviderManager } = await import('./ai/providers')
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
    type Pi = typeof import('@earendil-works/pi-ai')
    type AssistantMessage = ReturnType<Pi['createAssistantMessageEventStream']>['result'] extends () => Promise<infer M> ? M : never
    type ChatEventT = import('@shared/types').ChatEvent

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const collections = createCollectionsRepo(dbi)
    const versions = createVersionsRepo(dbi)
    const settings = createSettingsRepo(dbi)
    const chats = createChatsRepo(dbi)
    const indexer = createIndexer(dbi)
    const search = createSearchService(dbi)
    const rag = createRag(dbi)

    const dataEvents: import('@shared/ipc').DataChangedEvent[] = []
    const services = {
      notes,
      collections,
      versions,
      indexer,
      search,
      emitDataChanged: (ev: import('@shared/ipc').DataChangedEvent) => dataEvents.push(ev)
    }

    const fakeModel = (contextWindow: number) =>
      ({
        id: 'fake-model',
        name: 'Fake',
        api: 'openai-responses',
        provider: 'fake',
        baseUrl: 'https://invalid.local',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 4096
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any

    const usage = {
      input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 }
    }
    const mkAssistant = (content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage =>
      ({
        role: 'assistant', content, api: 'openai-responses', provider: 'fake', model: 'fake-model',
        usage, stopReason, timestamp: Date.now()
      }) as AssistantMessage

    // ── Scenario A: search → read → update (append) → create, then a cited answer ──
    const seed = notes.create({ title: 'Flux research', contentMd: 'original flux body' })
    indexer.flushNote(seed.id)
    const TITLE_MARKER = 'name chat conversations'

    let aCalls = 0
    const scriptedA = (_model: unknown, context: { systemPrompt?: string; messages: { role: string; toolName?: string; content: unknown }[] }) => {
      aCalls++
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Flux housekeeping' }], 'stop') })
          return
        }
        const toolResults = context.messages.filter((m) => m.role === 'toolResult')
        if (toolResults.length === 0) {
          s.push({
            type: 'done', reason: 'toolUse',
            message: mkAssistant(
              [
                { type: 'toolCall', id: 'c1', name: 'search_notes', arguments: { query: 'flux', mode: 'keyword' } },
                { type: 'toolCall', id: 'c2', name: 'read_note', arguments: { id: seed.id } },
                { type: 'toolCall', id: 'c3', name: 'update_note', arguments: { id: seed.id, mode: 'append', contentMd: 'AI appended line' } },
                { type: 'toolCall', id: 'c4', name: 'create_note', arguments: { title: 'AI created', contentMd: 'created by the agent' } }
              ],
              'toolUse'
            )
          })
          return
        }
        // Final iteration: cite the seeded note + the id the create_note toolResult returned.
        const createRes = toolResults.find((m) => m.toolName === 'create_note') as { content: { text: string }[] } | undefined
        const createdId = createRes ? (JSON.parse(createRes.content[0]!.text) as { id: string }).id : 'MISSING'
        const text = `Done — appended to [Flux research](mymem://note/${seed.id}) and created [AI created](mymem://note/${createdId}).`
        s.push({ type: 'text_delta', contentIndex: 0, delta: text.slice(0, 10), partial: mkAssistant([], 'stop') })
        s.push({ type: 'text_delta', contentIndex: 0, delta: text.slice(10), partial: mkAssistant([], 'stop') })
        s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text }], 'stop') })
      })
      return s
    }

    const eventsA: ChatEventT[] = []
    const agentA = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(16000),
      emit: (_chatId, _requestId, ev) => eventsA.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedA as any
    })

    const chatA = chats.create()
    chats.setModel(chatA.id, 'fake', 'fake-model')
    await agentA.runTurn({ chatId: chatA.id, requestId: 'r1', content: 'Append to my flux note', chips: [] })

    if (eventsA.some((e) => e.type === 'error')) {
      throw new Error(`scenario A emitted an error: ${JSON.stringify(eventsA.find((e) => e.type === 'error'))}`)
    }
    if (eventsA[0]?.type !== 'turn_start') throw new Error('missing turn_start')
    const toolStarts = eventsA.filter((e) => e.type === 'tool_start')
    const toolEnds = eventsA.filter((e) => e.type === 'tool_end')
    if (toolStarts.length !== 4 || toolEnds.length !== 4) throw new Error(`expected 4 tool start/end pairs, got ${toolStarts.length}/${toolEnds.length}`)
    if (!toolEnds.every((e) => e.type === 'tool_end' && e.ok)) throw new Error('a tool reported failure in scenario A')
    if (!eventsA.some((e) => e.type === 'text_delta')) throw new Error('no text_delta relayed')
    const turnEnd = eventsA.find((e) => e.type === 'turn_end')
    if (turnEnd?.type !== 'turn_end') throw new Error('missing turn_end')
    if (!turnEnd.undoToken) throw new Error('turn_end carries no undoToken despite mutations')
    if (turnEnd.usage?.input !== 10 || turnEnd.usage.output !== 14) throw new Error('turn_end usage not accumulated across iterations')

    // Tool effects went through the REAL services
    if (notes.get(seed.id)!.contentMd !== 'original flux body\n\nAI appended line') throw new Error('update_note append did not land')
    const aiEdit = versions.list(seed.id).find((v) => v.kind === 'ai_edit')
    if (!aiEdit) throw new Error('update_note did not snapshot kind ai_edit')
    if (versions.get(aiEdit.id)!.contentMd !== 'original flux body') throw new Error('ai_edit snapshot is not the PRE-edit state')
    const created = notes.list({ scope: 'all' }).items.find((n) => n.title === 'AI created')
    if (!created) throw new Error('create_note did not create the note')
    if (created.titleSource !== 'ai') throw new Error('AI-created note must have title_source ai')
    if (!dataEvents.some((e) => e.origin === 'ai' && e.op === 'update' && e.ids.includes(seed.id))) throw new Error('no data:changed origin ai for the update')
    if (!dataEvents.some((e) => e.origin === 'ai' && e.op === 'create' && e.ids.includes(created.id))) throw new Error('no data:changed origin ai for the create')

    // Persistence: idx-ordered pi-ai messages (user, assistant(tools), 4 toolResults, assistant)
    const msgs = chats.messages(chatA.id)
    if (msgs.map((m) => m.idx).join(',') !== '0,1,2,3,4,5,6') throw new Error(`message idx not contiguous: ${msgs.map((m) => m.idx).join(',')}`)
    if (msgs.map((m) => m.role).join(',') !== 'user,assistant,toolResult,toolResult,toolResult,toolResult,assistant') {
      throw new Error(`unexpected role sequence: ${msgs.map((m) => m.role).join(',')}`)
    }
    const finalText = (msgs[6]!.content as { content: { type: string; text?: string }[] }).content[0]!.text!
    if (!finalText.includes(`mymem://note/${seed.id}`) || !finalText.includes(`mymem://note/${created.id}`)) {
      throw new Error('final answer is missing mymem:// citations')
    }
    // <5 live notes → turn-1 RAG must have been skipped
    if (msgs.some((m) => m.role === 'user' && typeof (m.content as { content?: unknown }).content === 'string' && ((m.content as { content: string }).content).startsWith('<workspace_context'))) {
      throw new Error('RAG injected below the 5-note floor')
    }

    // Title generation (async, same scripted model) — fires after turn_end
    await waitFor(() => chats.get(chatA.id)!.title === 'Flux housekeeping', 5000, 'generated chat title')

    // Undo: snapshot restored, created note trashed. A post-turn user edit is
    // clobbered by the restore — it must survive as a pre_restore version.
    notes.update(seed.id, { contentMd: 'user edit after the turn' })
    agentA.undo(turnEnd.undoToken)
    if (notes.get(seed.id)!.contentMd !== 'original flux body') throw new Error('undo did not restore the updated note')
    if (notes.get(created.id)!.trashedAt === null) throw new Error('undo did not trash the created note')
    const preRestore = versions.list(seed.id).find((v) => v.kind === 'pre_restore')
    if (!preRestore) throw new Error('undo did not snapshot the clobbered state as pre_restore')
    if (versions.get(preRestore.id)!.contentMd !== 'user edit after the turn') {
      throw new Error('pre_restore snapshot is not the pre-undo state')
    }
    let unknownTokenThrew = false
    try {
      agentA.undo(turnEnd.undoToken) // consumed → must throw
    } catch {
      unknownTokenThrew = true
    }
    if (!unknownTokenThrew) throw new Error('ai:undo accepted a consumed token')

    // ── Scenario B: trashed guard — update_note on the now-trashed note is an isError toolResult ──
    let bPhase = 0
    const scriptedB = (_m: unknown, context: { systemPrompt?: string }) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Trash test' }], 'stop') })
          return
        }
        if (bPhase++ === 0) {
          s.push({
            type: 'done', reason: 'toolUse',
            message: mkAssistant([{ type: 'toolCall', id: 'b1', name: 'update_note', arguments: { id: created.id, mode: 'append', contentMd: 'x' } }], 'toolUse')
          })
        } else {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'That note is trashed.' }], 'stop') })
        }
      })
      return s
    }
    const eventsB: ChatEventT[] = []
    const agentB = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(16000),
      emit: (_c, _r, ev) => eventsB.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedB as any
    })
    const chatB = chats.create()
    chats.setModel(chatB.id, 'fake', 'fake-model')
    await agentB.runTurn({ chatId: chatB.id, requestId: 'r2', content: 'Edit the trashed note', chips: [] })
    const bToolEnd = eventsB.find((e) => e.type === 'tool_end')
    if (bToolEnd?.type !== 'tool_end' || bToolEnd.ok) throw new Error('trashed update_note must produce an isError tool_end (not a throw)')
    if (notes.get(created.id)!.contentMd.includes('x')) throw new Error('trashed note was written despite the guard')
    const bTurnEnd = eventsB.find((e) => e.type === 'turn_end')
    if (bTurnEnd?.type !== 'turn_end') throw new Error('trashed-guard turn did not finish')
    if (bTurnEnd.undoToken) throw new Error('failed mutation must not mint an undoToken')

    // ── Scenario C: infinite toolcall stream stops at the 12-iteration cap ──
    const scriptedC = (_m: unknown, _ctx: unknown) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        s.push({
          type: 'done', reason: 'toolUse',
          message: mkAssistant([{ type: 'toolCall', id: `loop-${Math.random()}`, name: 'list_collections', arguments: {} }], 'toolUse')
        })
      })
      return s
    }
    const eventsC: ChatEventT[] = []
    const agentC = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(1_000_000),
      emit: (_c, _r, ev) => eventsC.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedC as any
    })
    const chatC = chats.create()
    chats.setModel(chatC.id, 'fake', 'fake-model')
    await agentC.runTurn({ chatId: chatC.id, requestId: 'r3', content: 'loop forever', chips: [] })
    const cErr = eventsC.find((e) => e.type === 'error')
    if (cErr?.type !== 'error' || cErr.code !== 'unknown' || !cErr.message.includes('12')) {
      throw new Error(`iteration cap did not produce the expected error: ${JSON.stringify(cErr)}`)
    }
    if (eventsC.filter((e) => e.type === 'tool_start').length !== 12) throw new Error('iteration cap ran the wrong number of tool rounds')

    // ── Scenario D: hard 80% context pre-check fires BEFORE any model call ──
    let dCalls = 0
    const eventsD: ChatEventT[] = []
    const agentD = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(300), // ~240-token budget; the system prompt alone exceeds it
      emit: (_c, _r, ev) => eventsD.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: ((..._args: unknown[]) => {
        dCalls++
        return scriptedC(null, null)
      }) as any
    })
    const chatD = chats.create()
    chats.setModel(chatD.id, 'fake', 'fake-model')
    await agentD.runTurn({ chatId: chatD.id, requestId: 'r4', content: 'x'.repeat(2000), chips: [] })
    const dErr = eventsD.find((e) => e.type === 'error')
    if (dErr?.type !== 'error' || dErr.code !== 'context_too_long') throw new Error('context pre-check did not fire')
    if (dCalls !== 0) throw new Error('context pre-check must reject BEFORE calling the model')

    // ── Scenario E: cancel mid-tool-loop — unexecuted calls get synthetic toolResults ──
    const scriptedE = (_m: unknown, context: { systemPrompt?: string; messages: { role: string }[] }) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Cancel test' }], 'stop') })
          return
        }
        if (context.messages.filter((m) => m.role === 'toolResult').length === 0) {
          s.push({
            type: 'done', reason: 'toolUse',
            message: mkAssistant(
              [
                { type: 'toolCall', id: 'e1', name: 'list_collections', arguments: {} },
                { type: 'toolCall', id: 'e2', name: 'get_recent_notes', arguments: {} }
              ],
              'toolUse'
            )
          })
        } else {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Picked up after the cancel.' }], 'stop') })
        }
      })
      return s
    }
    const eventsE: ChatEventT[] = []
    const chatE = chats.create()
    chats.setModel(chatE.id, 'fake', 'fake-model')
    const agentE = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(64000),
      emit: (_c, _r, ev) => {
        eventsE.push(ev)
        // Abort the moment the FIRST tool finishes: the second call must not run,
        // but it must still get a synthetic toolResult (no dangling toolCall).
        if (ev.type === 'tool_end' && ev.callId === 'e1') agentE.cancel(chatE.id)
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedE as any
    })
    await agentE.runTurn({ chatId: chatE.id, requestId: 'r5', content: 'cancel me mid-tools', chips: [] })
    const eErr = eventsE.find((e) => e.type === 'error')
    if (eErr?.type !== 'error' || eErr.code !== 'cancelled') throw new Error('cancelled turn did not emit the cancelled error')
    if (eventsE.filter((e) => e.type === 'tool_start').length !== 1) throw new Error('the second tool ran despite the cancel')
    const eMsgs = chats.messages(chatE.id)
    if (eMsgs.map((m) => m.role).join(',') !== 'user,assistant,toolResult,toolResult') {
      throw new Error(`cancelled turn persisted wrong roles: ${eMsgs.map((m) => m.role).join(',')}`)
    }
    type SmokeToolResult = { toolCallId: string; isError?: boolean; content: { text: string }[] }
    const eResults = eMsgs.filter((m) => m.role === 'toolResult').map((m) => m.content as SmokeToolResult)
    const eReal = eResults.find((t) => t.toolCallId === 'e1')
    const eSynthetic = eResults.find((t) => t.toolCallId === 'e2')
    if (!eReal || eReal.isError) throw new Error('executed tool call lost its real toolResult')
    if (!eSynthetic || eSynthetic.isError !== true || eSynthetic.content[0]!.text !== 'cancelled by user') {
      throw new Error('unexecuted tool call did not get the synthetic cancelled toolResult')
    }

    // Follow-up turn on the SAME chat must replay cleanly — a dangling toolCall
    // would 400 every later send.
    const eBefore = eventsE.length
    await agentE.runTurn({ chatId: chatE.id, requestId: 'r6', content: 'and continue', chips: [] })
    const eAfter = eventsE.slice(eBefore)
    if (eAfter.some((e) => e.type === 'error')) {
      throw new Error(`follow-up after cancel errored: ${JSON.stringify(eAfter.find((e) => e.type === 'error'))}`)
    }
    if (!eAfter.some((e) => e.type === 'turn_end')) throw new Error('follow-up after cancel did not finish')
    const eAll = chats.messages(chatE.id)
    const eCallIds = eAll
      .filter((m) => m.role === 'assistant')
      .flatMap((m) =>
        ((m.content as { content: { type: string; id?: string }[] }).content)
          .filter((c) => c.type === 'toolCall')
          .map((c) => c.id!)
      )
    const eResultIds = new Set(
      eAll.filter((m) => m.role === 'toolResult').map((m) => (m.content as { toolCallId: string }).toolCallId)
    )
    if (eCallIds.some((id) => !eResultIds.has(id))) throw new Error('dangling toolCall without toolResult after cancel')

    // ── Scenario F (v1.1): active-note chip → "currently viewing" system-prompt line ──
    const seenPrompts: string[] = []
    const scriptedF = (_m: unknown, context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Viewing test' }], 'stop') })
          return
        }
        seenPrompts.push(context.systemPrompt ?? '')
        s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Looking at it.' }], 'stop') })
      })
      return s
    }
    const eventsF: ChatEventT[] = []
    const agentF = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(64000),
      emit: (_c, _r, ev) => eventsF.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedF as any
    })
    const chatF = chats.create()
    chats.setModel(chatF.id, 'fake', 'fake-model')
    await agentF.runTurn({
      chatId: chatF.id,
      requestId: 'r7',
      content: 'Fix the headings in this note',
      chips: [{ type: 'note', id: seed.id, active: true }]
    })
    if (eventsF.some((e) => e.type === 'error')) {
      throw new Error(`scenario F errored: ${JSON.stringify(eventsF.find((e) => e.type === 'error'))}`)
    }
    const fPrompt = seenPrompts[0] ?? ''
    if (!fPrompt.includes('currently viewing') || !fPrompt.includes(`mymem://note/${seed.id}`)) {
      throw new Error('active-note chip did not add the "currently viewing" line to the system prompt')
    }
    if (!fPrompt.includes('NEVER claim you cannot create or edit notes')) {
      throw new Error('capability block missing from the system prompt')
    }
    // Chip CONTENT still rides the unchanged M7 path: an <attached_context> user message.
    const fMsgs = chats.messages(chatF.id)
    if (!fMsgs.some((m) => m.role === 'user' && String((m.content as { content?: unknown }).content).startsWith('<attached_context'))) {
      throw new Error('active chip content was not injected as attached_context')
    }
    // A chip WITHOUT the active flag must not claim "currently viewing".
    await agentF.runTurn({ chatId: chatF.id, requestId: 'r8', content: 'And in general?', chips: [{ type: 'note', id: seed.id }] })
    if ((seenPrompts[1] ?? '').includes('currently viewing')) {
      throw new Error('non-active chip must not add the currently-viewing line')
    }
    await waitFor(() => chats.get(chatF.id)!.title === 'Viewing test', 5000, 'scenario F chat title')
    console.log('[smoke] v1.1 active-note chip OK — currently-viewing line + capability block in the system prompt, attached_context unchanged, non-active chip adds no line')

    // ── Scenario G (v1.1): light active chip — note content attached ONCE per conversation ──
    const seenPromptsG: string[] = []
    const scriptedG = (_m: unknown, context: { systemPrompt?: string }) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Light test' }], 'stop') })
          return
        }
        seenPromptsG.push(context.systemPrompt ?? '')
        s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'noted' }], 'stop') })
      })
      return s
    }
    const eventsG: ChatEventT[] = []
    const agentG = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(64000),
      emit: (_c, _r, ev) => eventsG.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedG as any
    })
    const chatG = chats.create()
    chats.setModel(chatG.id, 'fake', 'fake-model')
    const userMessagesOf = (chatId: string): string[] =>
      chats
        .messages(chatId)
        .filter((m) => m.role === 'user')
        .map((m) => String((m.content as { content?: unknown }).content))
    const attachedCount = (chatId: string): number =>
      userMessagesOf(chatId).filter((t) => t.startsWith('<attached_context')).length

    // Turn 1: full chip → content injected once.
    await agentG.runTurn({
      chatId: chatG.id, requestId: 'g1', content: 'Summarize this note',
      chips: [{ type: 'note', id: seed.id, active: true }]
    })
    if (attachedCount(chatG.id) !== 1) throw new Error('turn 1 must attach the note content exactly once')
    // Turn 2: note unchanged → the renderer sends the chip LIGHT; main must NOT
    // re-inject content, but the currently-viewing line still applies.
    await agentG.runTurn({
      chatId: chatG.id, requestId: 'g2', content: 'Now as bullet points',
      chips: [{ type: 'note', id: seed.id, active: true, light: true }]
    })
    if (eventsG.some((e) => e.type === 'error')) {
      throw new Error(`scenario G errored: ${JSON.stringify(eventsG.find((e) => e.type === 'error'))}`)
    }
    if (attachedCount(chatG.id) !== 1) {
      throw new Error('light chip re-injected the note content (expected exactly ONE attached_context across the transcript)')
    }
    if (!(seenPromptsG[1] ?? '').includes('currently viewing')) {
      throw new Error('light chip lost the currently-viewing system-prompt line')
    }
    // Note edited → the renderer re-sends a FULL chip → content re-attached once.
    notes.update(seed.id, { contentMd: 'original flux body\n\nedited between turns' })
    await agentG.runTurn({
      chatId: chatG.id, requestId: 'g3', content: 'And after my edit?',
      chips: [{ type: 'note', id: seed.id, active: true }]
    })
    if (attachedCount(chatG.id) !== 2) throw new Error('edited note must be re-attached on the next turn')
    if (!userMessagesOf(chatG.id).some((t) => t.startsWith('<attached_context') && t.includes('edited between turns'))) {
      throw new Error('the re-attached content is not the edited note')
    }
    await waitFor(() => chats.get(chatG.id)!.title === 'Light test', 5000, 'scenario G chat title')
    console.log('[smoke] v1.1 light chip OK — content attached once per conversation, currently-viewing line kept, note edit re-attaches')

    // ── Scenario H (v1.1): turn-1 implicit RAG runs ALONGSIDE the auto chip ──
    // ≥5 live notes (RAG floor) with an FTS hit for the query; no embedder wired
    // → keyword path, which has no score floor.
    const ragSeeds = Array.from({ length: 5 }, (_, i) =>
      notes.create({ title: `Fluxsmoke ${i}`, contentMd: `fluxsmoke finding number ${i} from the bench` })
    )
    for (const n of ragSeeds) indexer.flushNote(n.id)
    const scriptedH = (_m: unknown, context: { systemPrompt?: string }) => {
      const s = createAssistantMessageEventStream()
      queueMicrotask(() => {
        if (context.systemPrompt?.includes(TITLE_MARKER)) {
          s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'Rag test' }], 'stop') })
          return
        }
        s.push({ type: 'done', reason: 'stop', message: mkAssistant([{ type: 'text', text: 'found it' }], 'stop') })
      })
      return s
    }
    const eventsH: ChatEventT[] = []
    const agentH = createAgent({
      chats, settings, services, rag,
      getApiKey: async () => 'fake-key',
      resolveModel: () => fakeModel(64000),
      emit: (_c, _r, ev) => eventsH.push(ev),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamFn: scriptedH as any
    })
    const chatH = chats.create()
    chats.setModel(chatH.id, 'fake', 'fake-model')
    await agentH.runTurn({
      chatId: chatH.id, requestId: 'h1', content: 'fluxsmoke',
      chips: [{ type: 'note', id: ragSeeds[0]!.id, active: true }] // ONLY the auto chip
    })
    if (eventsH.some((e) => e.type === 'error')) {
      throw new Error(`scenario H errored: ${JSON.stringify(eventsH.find((e) => e.type === 'error'))}`)
    }
    const hUser = userMessagesOf(chatH.id)
    if (!hUser.some((t) => t.startsWith('<workspace_context'))) {
      throw new Error('the auto chip suppressed turn-1 implicit RAG (workspace_context missing)')
    }
    if (!hUser.some((t) => t.startsWith('<attached_context'))) {
      throw new Error('auto-chip content missing alongside RAG (attached_context)')
    }
    // A MANUALLY attached chip still suppresses turn-1 RAG.
    const chatH2 = chats.create()
    chats.setModel(chatH2.id, 'fake', 'fake-model')
    await agentH.runTurn({
      chatId: chatH2.id, requestId: 'h2', content: 'fluxsmoke',
      chips: [
        { type: 'note', id: ragSeeds[0]!.id, active: true },
        { type: 'note', id: ragSeeds[1]!.id } // user-added → skip RAG
      ]
    })
    const h2User = userMessagesOf(chatH2.id)
    if (h2User.some((t) => t.startsWith('<workspace_context'))) {
      throw new Error('a manually attached chip must still suppress turn-1 RAG')
    }
    if (!h2User.some((t) => t.startsWith('<attached_context'))) {
      throw new Error('manual + auto chips lost their attached_context')
    }
    await waitFor(() => chats.get(chatH.id)!.title === 'Rag test', 5000, 'scenario H chat title')
    await waitFor(() => chats.get(chatH2.id)!.title === 'Rag test', 5000, 'scenario H2 chat title')
    console.log('[smoke] v1.1 turn-1 RAG OK — auto chip injects workspace_context AND attached_context; manual chips still skip RAG')

    // ── Credentials: safeStorage roundtrip (or the disabled path when unavailable) ──
    const creds = createCredentialsStore(settings)
    const providers = createProviderManager({ credentials: creds, settings, onDeviceCode: () => {} })
    if (creds.available()) {
      creds.set('openai-codex', { access: 'acc-token', refresh: 'ref-token', expires: 42 })
      const raw = JSON.stringify(settings.get('ai.creds.openai-codex'))
      if (raw.includes('acc-token') || raw.includes('ref-token')) throw new Error('credentials stored in PLAINTEXT')
      const back = creds.get<{ access: string; refresh: string; expires: number }>('openai-codex')
      if (back?.access !== 'acc-token' || back.refresh !== 'ref-token' || back.expires !== 42) throw new Error('credential decrypt roundtrip failed')
      const st = providers.status()
      if (!st.encryptionAvailable) throw new Error('status must report encryption available')
      if (!st.providers.find((p) => p.id === 'openai-codex')?.connected) throw new Error('status missed the stored credentials')
      creds.delete('openai-codex')
      if (creds.get('openai-codex') !== null) throw new Error('credential delete failed')
      console.log('[smoke] M7 credentials OK — encrypted blob, decrypt roundtrip, delete')

      // ── v1.2 OpenRouter: fake-connect with a dummy key (no network) ──
      const orKey = 'sk-or-v1-smoke-dummy-key-0000'
      const orSet = providers.setApiKey('openrouter', orKey)
      if (!orSet.ok) throw new Error(`setApiKey rejected an sk-or- key: ${orSet.error}`)
      if (!providers.status().providers.find((p) => p.id === 'openrouter')?.connected) {
        throw new Error('openrouter not connected after key store')
      }
      const orModels = providers.models().filter((m) => m.providerId === 'openrouter')
      if (orModels.length < 100) throw new Error(`ai:models has only ${orModels.length} openrouter entries`)
      if (orModels.some((m) => /-\d{8}$/.test(m.modelId))) throw new Error('date-pinned openrouter alias leaked into the picker')
      if (!orModels[0]!.label.startsWith('OpenRouter · ')) throw new Error(`openrouter label prefix wrong: ${orModels[0]!.label}`)
      if (await providers.getApiKeyFor('openrouter') !== orKey) throw new Error('getApiKeyFor(openrouter) did not return the stored key')
      // Cheap-model heuristic over the 250+-model list must not crash — vendor/model
      // ids like anthropic/claude-3.5-haiku matching /mini|haiku|spark/i is desired.
      const orUtility = providers.utilityModel()
      if (!orUtility) throw new Error('utilityModel returned null with openrouter connected')
      providers.logout('openrouter')
      if (providers.status().providers.find((p) => p.id === 'openrouter')?.connected) {
        throw new Error('openrouter still connected after logout')
      }
      console.log(`[smoke] v1.2 openrouter OK — key roundtrip, ${orModels.length} models in the picker, utility pick ${orUtility.providerId}/${orUtility.modelId}, remove key`)
    } else {
      const st = providers.status()
      if (st.encryptionAvailable || st.providers.some((p) => p.connected)) {
        throw new Error('without safeStorage the AI layer must report disabled/disconnected')
      }
      console.log('[smoke] M7 credentials: safeStorage unavailable here — disabled path verified instead')
    }

    indexer.flushAll()
    closeDb()
    console.log('[smoke] M7 chat agent OK — scripted turn (search/read/update/create + citations), idx-ordered persistence, ai_edit snapshot + undo with pre_restore, trashed guard, 12-round cap, 80% context pre-check, mid-tool cancel persists synthetic toolResults, title generation')
  } finally {
    delete process.env.MYMEM_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * M8: Clean Up sessions, auto-organize and note titles with SCRIPTED model
 * functions (zero network) over a real temp DB. Proves: cleanup validation +
 * retry + refine transcript + cap + accept (pre_cleanup) + hard length cap +
 * mid-generation cancel; organize thresholds (0.55/0.7) + toolcall validation
 * retry + shared-registry undo; title queue with re-check and once-per-note.
 */
async function smokeAiFeatures(): Promise<void> {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'mymem-smoke-m8-'))
  process.env.MYMEM_DB_PATH = join(dir, 'smoke.db')
  try {
    const { getDb, closeDb } = await import('./db/connection')
    const { createNotesRepo } = await import('./db/repos/notesRepo')
    const { createCollectionsRepo } = await import('./db/repos/collectionsRepo')
    const { createVersionsRepo } = await import('./db/repos/miscRepos')
    const { createIndexer } = await import('./indexing/indexer')
    const { createSearchService } = await import('./search/searchService')
    const { createUndoRegistry } = await import('./ai/undoRegistry')
    const { createCleanupService } = await import('./ai/cleanup')
    const { createOrganizeService } = await import('./ai/organize')
    const { createTitlesService } = await import('./ai/titles')
    const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
    type Pi = typeof import('@earendil-works/pi-ai')
    type AssistantMessage = ReturnType<Pi['createAssistantMessageEventStream']>['result'] extends () => Promise<infer M> ? M : never
    type CleanupPush = import('@shared/ipc').IpcPushMap['ai:cleanup:result']

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const collections = createCollectionsRepo(dbi)
    const versions = createVersionsRepo(dbi)
    const indexer = createIndexer(dbi)
    const search = createSearchService(dbi)
    const dataEvents: import('@shared/ipc').DataChangedEvent[] = []
    const emitDataChanged = (ev: import('@shared/ipc').DataChangedEvent): void => {
      dataEvents.push(ev)
    }
    const undoRegistry = createUndoRegistry({ notes, collections, versions, indexer, search, emitDataChanged })

    const fakeModel = (api: string, contextWindow = 1_000_000) =>
      ({
        id: 'fake-utility',
        name: 'Fake',
        api,
        provider: 'fake',
        baseUrl: 'https://invalid.local',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 4096
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    const usage = {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
    const mk = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage =>
      ({
        role: 'assistant', content, api: 'openai-responses', provider: 'fake', model: 'fake-utility',
        usage, stopReason, timestamp: Date.now()
      }) as AssistantMessage
    const textMsg = (text: string): AssistantMessage => mk([{ type: 'text', text }], 'stop')

    // ── Clean Up ──────────────────────────────────────────────────────────────
    const pushes: CleanupPush[] = []
    const mkCleanup = (
      script: (call: number, context: { systemPrompt?: string; messages: { role: string; content: unknown }[] }, options: { signal?: AbortSignal }) => AssistantMessage | 'hold'
    ) => {
      let calls = 0
      const svc = createCleanupService({
        notes, versions, indexer, emitDataChanged,
        pushResult: (p) => pushes.push(p),
        getApiKey: async () => 'fake-key',
        defaultModel: () => ({ providerId: 'fake', modelId: 'fake-utility' }),
        resolveModel: () => fakeModel('openai-responses'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        streamFn: ((_m: unknown, context: any, options: any) => {
          const s = createAssistantMessageEventStream()
          const verdict = script(calls++, context, options ?? {})
          if (verdict === 'hold') {
            options?.signal?.addEventListener('abort', () => {
              s.push({ type: 'error', reason: 'aborted', error: mk([], 'aborted') })
            })
          } else {
            queueMicrotask(() => s.push({ type: 'done', reason: 'stop', message: verdict }))
          }
          return s
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      })
      return { svc, calls: () => calls }
    }
    const lastPush = (): CleanupPush => pushes[pushes.length - 1]!
    // since must be captured BEFORE the triggering call: some pushes (too-long
    // cap) fire synchronously inside start().
    const awaitPush = async (since: number): Promise<CleanupPush> => {
      await waitFor(() => pushes.length > since, 5000, 'ai:cleanup:result push')
      return lastPush()
    }

    const baseMd = [
      '# my note', '',
      'teh quick brown fox jumps over the lazy dog and keeps runing along the road', '',
      '```js', 'const x = 1', '```', '',
      '- [x] done item', '- [ ] open itme'
    ].join('\n')
    const cleanedMd = baseMd.replace('teh', 'the').replace('runing', 'running').replace('itme', 'item')
    const refinedMd = cleanedMd.replace('# my note', '## My note')
    const note = notes.create({ title: 'Cleanup target', contentMd: baseMd })

    // Happy path + refine transcript + cap-at-5 + accept
    const happy = mkCleanup((_call, context) => {
      const last = context.messages[context.messages.length - 1]!
      return typeof last.content === 'string' && last.content.startsWith('Refine:') ? textMsg(refinedMd) : textMsg(cleanedMd)
    })
    let since = pushes.length
    let { sessionId } = happy.svc.start({ noteId: note.id })
    let result = await awaitPush(since)
    if (result.sessionId !== sessionId || result.cleanedMd !== cleanedMd) throw new Error('cleanup happy path push wrong')

    since = pushes.length
    happy.svc.refine({ sessionId, instruction: 'use an h2 heading' })
    result = await awaitPush(since)
    if (result.cleanedMd !== refinedMd) throw new Error('refine did not produce the refined markdown')
    // transcript grew: the refine stream saw user, assistant(prev), user('Refine: …')
    for (let i = 0; i < 4; i++) {
      since = pushes.length
      happy.svc.refine({ sessionId, instruction: `tweak ${i}` })
      await awaitPush(since)
    }
    let capThrew = false
    try {
      happy.svc.refine({ sessionId, instruction: 'one too many' })
    } catch {
      capThrew = true
    }
    if (!capThrew) throw new Error('6th refine must throw (cap 5)')
    if (happy.calls() !== 6) throw new Error(`expected 6 generations (1 start + 5 refines), got ${happy.calls()}`)

    const accepted = happy.svc.accept({ sessionId })
    if (typeof accepted.updatedAt !== 'number') throw new Error('accept returned no updatedAt')
    if (notes.get(note.id)!.contentMd !== refinedMd) throw new Error('accept did not write the refined markdown')
    const preCleanup = versions.list(note.id).find((v) => v.kind === 'pre_cleanup')
    if (!preCleanup) throw new Error('accept did not snapshot pre_cleanup')
    if (versions.get(preCleanup.id)!.contentMd !== baseMd) throw new Error('pre_cleanup snapshot is not the PRE-accept state')
    if (indexer.pendingCount() !== 1) throw new Error('accept did not enqueue the note for reindexing')
    if (!dataEvents.some((e) => e.origin === 'ai' && e.op === 'update' && e.ids.includes(note.id))) {
      throw new Error('accept did not emit data:changed origin ai')
    }
    if (happy.svc.sessionCount() !== 0) throw new Error('accept did not free the session')

    // Refine transcript content check via a dedicated script
    const transcriptSeen: number[] = []
    const tcheck = mkCleanup((_call, context) => {
      transcriptSeen.push(context.messages.length)
      return textMsg(cleanedMd)
    })
    since = pushes.length
    const t1 = tcheck.svc.start({ noteId: note.id })
    await awaitPush(since)
    since = pushes.length
    tcheck.svc.refine({ sessionId: t1.sessionId, instruction: 'tighter lists' })
    await awaitPush(since)
    if (transcriptSeen.join(',') !== '1,3') throw new Error(`refine transcript did not grow 1→3: ${transcriptSeen.join(',')}`)
    tcheck.svc.cancel({ sessionId: t1.sessionId })

    // Validation retry: first response empty → ONE silent retry → ok
    const retry = mkCleanup((call) => (call === 0 ? textMsg('   ') : textMsg(cleanedMd)))
    since = pushes.length
    const r1 = retry.svc.start({ noteId: note.id })
    result = await awaitPush(since)
    if (result.cleanedMd !== cleanedMd) throw new Error('validation retry did not recover')
    if (retry.calls() !== 2) throw new Error(`empty first response should retry once, got ${retry.calls()} calls`)
    retry.svc.cancel({ sessionId: r1.sessionId })

    // Length-ratio violation twice → error (and code fences must also be preserved)
    const shrink = mkCleanup(() => textMsg('tiny'))
    since = pushes.length
    const r2 = shrink.svc.start({ noteId: note.id })
    result = await awaitPush(since)
    if (result.sessionId !== r2.sessionId || !result.error) throw new Error('double ratio violation must push an error')
    if (shrink.calls() !== 2) throw new Error('ratio violation must retry exactly once before erroring')

    // v1.1 web-paste sessions: the prompt licenses stripping nav/cookie/footer
    // debris, so the initial pass gets the relaxed 0.15 floor — a ~70%-shrunk
    // response passes; the SAME response in a NORMAL session must still error.
    const webDebris = [
      'Home | Products | Pricing | Blog | About | Contact | Careers | Support',
      'We use cookies to improve your experience. Accept all  ·  Manage preferences  ·  Reject non-essential',
      'Share on X  ·  Share on LinkedIn  ·  Copy link  ·  Subscribe to our newsletter',
      '© 2026 Example Corp · Privacy Policy · Terms of Service · Sitemap · Do Not Sell My Info'
    ].join('\n\n')
    const webClean =
      '# The actual article\n\nOne tight paragraph of real substance that must survive the cleanup, including every fact, name and number the page actually carried in its body text.'
    const webBase = `${webDebris}\n\n${webClean}\n\n${webDebris}`
    const webRatio = webClean.length / webBase.length
    if (webRatio < 0.13 || webRatio > 0.45) throw new Error(`web-paste fixture drifted out of band (ratio ${webRatio.toFixed(2)})`)
    const webNote = notes.create({ title: 'Pasted article', contentMd: webBase })
    const webPrompts: string[] = []
    const webSvc = mkCleanup((_call, context) => {
      webPrompts.push(context.systemPrompt ?? '')
      return textMsg(webClean)
    })
    since = pushes.length
    const w1 = webSvc.svc.start({ noteId: webNote.id, webPaste: true })
    result = await awaitPush(since)
    if (result.sessionId !== w1.sessionId || result.cleanedMd !== webClean) {
      throw new Error(`webPaste cleanup rejected a legitimate debris strip: ${JSON.stringify(result)}`)
    }
    if (webSvc.calls() !== 1) throw new Error('webPaste debris strip must pass on the first attempt (no retry)')
    if (!webPrompts[0]!.includes('remove that debris')) throw new Error('webPaste prompt is missing the debris-removal line')
    if (!webPrompts[0]!.includes('except web-paste debris')) throw new Error('webPaste prompt is missing the never-drop carve-out')
    webSvc.svc.cancel({ sessionId: w1.sessionId })

    const normPrompts: string[] = []
    const normSvc = mkCleanup((_call, context) => {
      normPrompts.push(context.systemPrompt ?? '')
      return textMsg(webClean)
    })
    since = pushes.length
    const w2 = normSvc.svc.start({ noteId: webNote.id }) // NO webPaste — strict contract
    result = await awaitPush(since)
    if (result.sessionId !== w2.sessionId || !result.error || !result.error.includes('length')) {
      throw new Error(`normal session must keep rejecting the 70% shrink: ${JSON.stringify(result)}`)
    }
    if (normSvc.calls() !== 2) throw new Error('normal-session shrink must retry once before erroring')
    if (normPrompts[0]!.includes('debris')) throw new Error('normal cleanup prompt must not mention web debris')
    if (normPrompts[0]!.includes('except web-paste')) throw new Error('normal cleanup prompt must not carry the carve-out')

    // Too-long note → immediate error, zero model calls
    const longNote = notes.create({ title: 'Long', contentMd: 'x'.repeat(49_000) })
    const toolong = mkCleanup(() => textMsg(cleanedMd))
    since = pushes.length
    const r3 = toolong.svc.start({ noteId: longNote.id })
    result = await awaitPush(since)
    if (result.sessionId !== r3.sessionId || result.error !== 'note too long to clean') {
      throw new Error(`too-long note pushed ${JSON.stringify(result)}`)
    }
    if (toolong.calls() !== 0) throw new Error('too-long note must not call the model')
    if (toolong.svc.sessionCount() !== 0) throw new Error('too-long start must not leave a session')

    // Cancel mid-generation: AbortController kills the stream, no push, session gone
    const held = mkCleanup(() => 'hold')
    const r4 = held.svc.start({ noteId: note.id })
    const pushesBefore = pushes.length
    await new Promise((r) => setTimeout(r, 20)) // let generate() reach the stream await
    held.svc.cancel({ sessionId: r4.sessionId })
    await new Promise((r) => setTimeout(r, 50))
    if (pushes.length !== pushesBefore) throw new Error('cancelled generation must not push a result')
    if (held.svc.sessionCount() !== 0) throw new Error('cancel did not free the session')
    let cancelledRefineThrew = false
    try {
      held.svc.refine({ sessionId: r4.sessionId, instruction: 'x' })
    } catch {
      cancelledRefineThrew = true
    }
    if (!cancelledRefineThrew) throw new Error('refine on a cancelled session must throw')

    // Staleness guard: a write landing between start and accept (chat agent,
    // CLI/API patch, leaked keystroke) must veto accept — newer content wins.
    const staleNote = notes.create({ title: 'Stale target', contentMd: baseMd })
    const stale = mkCleanup(() => textMsg(cleanedMd))
    since = pushes.length
    const r5 = stale.svc.start({ noteId: staleNote.id })
    await awaitPush(since)
    await new Promise((r) => setTimeout(r, 5)) // updatedAt is ms-resolution — let it tick past the base
    const newerMd = baseMd + '\n\nline written mid-session'
    notes.update(staleNote.id, { contentMd: newerMd })
    let staleThrew = false
    try {
      stale.svc.accept({ sessionId: r5.sessionId })
    } catch (err) {
      staleThrew = true
      if (!(err instanceof Error) || !err.message.includes('changed while cleaning up')) {
        throw new Error(`stale accept threw the wrong error: ${String(err)}`)
      }
    }
    if (!staleThrew) throw new Error('accept on a stale base must throw')
    if (notes.get(staleNote.id)!.contentMd !== newerMd) throw new Error('stale accept clobbered the newer content')
    if (stale.svc.sessionCount() !== 0) throw new Error('stale accept did not free the session')
    if (versions.list(staleNote.id).some((v) => v.kind === 'pre_cleanup')) {
      throw new Error('stale accept must not commit a pre_cleanup snapshot')
    }

    console.log('[smoke] M8 cleanup OK — happy path, refine transcript + cap 5, accept (pre_cleanup + reindex + data:changed ai), empty→retry, ratio error, webPaste relaxed floor + debris prompt (normal stays strict), hard length cap, mid-generation cancel, stale-base accept veto')

    // ── Auto-organize ─────────────────────────────────────────────────────────
    collections.create({ name: 'Work' })
    collections.create({ name: 'Recipes' })
    const orgNote = notes.create({ title: 'Trip planning', contentMd: 'Flights, hotels and a packing list for the autumn trip.' })

    const fileNoteCall = (assignments: unknown[]) =>
      mk([{ type: 'toolCall', id: 'fn1', name: 'file_note', arguments: { assignments } }], 'toolUse')
    const mkOrganize = (script: (call: number, options: Record<string, unknown>) => AssistantMessage, api = 'openai-responses') => {
      let calls = 0
      const optionsSeen: Record<string, unknown>[] = []
      const svc = createOrganizeService({
        notes, collections, emitDataChanged, undoRegistry,
        getApiKey: async () => 'fake-key',
        utilityModel: () => ({ providerId: 'fake', modelId: 'fake-utility' }),
        resolveModel: () => fakeModel(api),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        streamFn: ((_m: unknown, _ctx: unknown, options: any) => {
          optionsSeen.push(options ?? {})
          const s = createAssistantMessageEventStream()
          const msg = script(calls++, options ?? {})
          queueMicrotask(() => s.push({ type: 'done', reason: msg.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: msg }))
          return s
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      })
      return { svc, calls: () => calls, optionsSeen }
    }

    // Mixed confidences: only ≥0.55 existing applied, only ≥0.7 new created
    const mixed = mkOrganize(() =>
      fileNoteCall([
        { collection: 'Work', confidence: 0.6, isNew: false, reason: 'work trip' },
        { collection: 'Recipes', confidence: 0.4, isNew: false, reason: 'weak' },
        { collection: 'Travel Plans', confidence: 0.8, isNew: true, reason: 'clearly travel' },
        { collection: 'Low New', confidence: 0.6, isNew: true, reason: 'below the 0.7 bar' }
      ])
    )
    const orgRes = await mixed.svc.run(orgNote.id)
    if (orgRes.applied.length !== 1 || orgRes.applied[0]!.name !== 'Work') throw new Error('organize did not apply exactly Work')
    if (orgRes.created.length !== 1 || orgRes.created[0]!.name !== 'Travel Plans') throw new Error('organize did not create exactly Travel Plans')
    if (!orgRes.undoToken) throw new Error('organize with effects must mint an undoToken')
    if (collections.getByName('Low New')) throw new Error('below-0.7 new collection was created')
    const orgRefs = notes.getWithRefs(orgNote.id)!
    if (orgRefs.collectionIds.length !== 2) throw new Error('organize memberships wrong')
    if (!dataEvents.some((e) => e.entity === 'collection' && e.op === 'create' && e.origin === 'ai')) {
      throw new Error('organize did not emit collection create origin ai')
    }

    // Undo via the SHARED registry: memberships removed, created collection deleted
    undoRegistry.undo(orgRes.undoToken)
    if (notes.getWithRefs(orgNote.id)!.collectionIds.length !== 0) throw new Error('undo did not remove organize memberships')
    if (collections.getByName('Travel Plans')) throw new Error('undo did not delete the created collection')
    if (!collections.getByName('Work')) throw new Error('undo must not delete the pre-existing collection')

    // Invalid first response (text, no toolcall) → ONE retry → valid
    const flaky = mkOrganize((call) =>
      call === 0 ? textMsg('I would file this under Work.') : fileNoteCall([{ collection: 'Work', confidence: 0.9, isNew: false, reason: 'retry' }])
    )
    const flakyRes = await flaky.svc.run(orgNote.id)
    if (flaky.calls() !== 2) throw new Error('invalid toolcall response must retry exactly once')
    if (flakyRes.applied.length !== 1) throw new Error('retry path did not apply the assignment')
    undoRegistry.undo(flakyRes.undoToken)

    // Below-threshold everything → empty result, no undo token, nothing written
    const meek = mkOrganize(() =>
      fileNoteCall([
        { collection: 'Work', confidence: 0.5, isNew: false, reason: 'meh' },
        { collection: 'Maybe New', confidence: 0.69, isNew: true, reason: 'meh' }
      ])
    )
    const meekRes = await meek.svc.run(orgNote.id)
    if (meekRes.applied.length !== 0 || meekRes.created.length !== 0 || meekRes.undoToken !== '') {
      throw new Error('below-threshold organize must return empty + no token')
    }
    if (notes.getWithRefs(orgNote.id)!.collectionIds.length !== 0) throw new Error('below-threshold organize wrote memberships')

    // Capture's fire-and-forget path: registerUndo:false applies normally but
    // mints no token (and must not evict records from the shared registry).
    const capNote = notes.create({ title: 'Captured', contentMd: 'Quarterly budget meeting notes and action items.' })
    const capOrg = mkOrganize(() => fileNoteCall([{ collection: 'Work', confidence: 0.9, isNew: false, reason: 'work' }]))
    const capRes = await capOrg.svc.run(capNote.id, { registerUndo: false })
    if (capRes.applied.length !== 1 || capRes.applied[0]!.name !== 'Work') throw new Error('registerUndo:false did not apply')
    if (capRes.undoToken !== '') throw new Error('registerUndo:false must return an empty undo token')

    // Anthropic models get toolChoice forcing passed through stream options
    const claude = mkOrganize(() => fileNoteCall([]), 'anthropic-messages')
    await claude.svc.run(orgNote.id)
    const tc = claude.optionsSeen[0]?.toolChoice as { type?: string; name?: string } | undefined
    if (tc?.type !== 'tool' || tc.name !== 'file_note') throw new Error('anthropic api must receive toolChoice {tool, file_note}')
    const codexOpts = mixed.optionsSeen[0]
    if (codexOpts && 'toolChoice' in codexOpts) throw new Error('non-anthropic api must NOT receive toolChoice')

    console.log('[smoke] M8 organize OK — thresholds 0.55/0.7, shared-registry undo (memberships + created collection), toolcall validation retry, toolChoice only for anthropic, empty below threshold, registerUndo:false tokenless capture path')

    // ── Titles ────────────────────────────────────────────────────────────────
    const longBody = 'This paragraph is comfortably longer than eighty characters so the titler will pick it up for processing.'
    const tA = notes.create({ title: '', contentMd: longBody })
    let titleReply = ' "Smoke Title." '
    let midFlight: (() => void) | null = null
    const titles = createTitlesService({
      notes, emitDataChanged,
      getApiKey: async () => 'fake-key',
      utilityModel: () => ({ providerId: 'fake', modelId: 'fake-utility' }),
      resolveModel: () => fakeModel('openai-responses'),
      isChatStreaming: () => false,
      debounceMs: 10,
      pausePollMs: 10,
      completeFn: async () => {
        midFlight?.()
        return textMsg(titleReply)
      }
    })

    titles.noteContentEdited(tA.id)
    await waitFor(() => notes.get(tA.id)!.title === 'Smoke Title', 5000, 'AI note title')
    if (notes.get(tA.id)!.titleSource !== 'ai') throw new Error('AI title must set titleSource ai')
    if (!dataEvents.some((e) => e.origin === 'ai' && e.ids.includes(tA.id))) throw new Error('title write did not emit data:changed origin ai')

    // Second run for the same note is skipped (once per note + titleSource ai)
    notes.update(tA.id, { title: '' }) // clear it — titleSource stays 'ai'
    titles.noteContentEdited(tA.id)
    await new Promise((r) => setTimeout(r, 80))
    if (titles.completionCount() !== 1) throw new Error('a titled note must never be re-titled')

    // User types a title while the completion is in flight → NOT overwritten
    const tB = notes.create({ title: '', contentMd: longBody })
    titleReply = 'Should Never Land'
    midFlight = () => notes.update(tB.id, { title: 'User typed', titleSource: 'user' })
    titles.noteContentEdited(tB.id)
    await waitFor(() => titles.completionCount() === 2, 5000, 'second title completion')
    await new Promise((r) => setTimeout(r, 50))
    const tBNote = notes.get(tB.id)!
    if (tBNote.title !== 'User typed' || tBNote.titleSource !== 'user') {
      throw new Error('mid-flight user title was overwritten by the AI title')
    }

    // A user title edit (handler path) cancels the pending debounce permanently
    const tC = notes.create({ title: '', contentMd: longBody })
    titles.noteContentEdited(tC.id)
    titles.noteTitleEdited(tC.id) // user typed before the 10 s debounce fired
    await new Promise((r) => setTimeout(r, 80))
    if (titles.completionCount() !== 2) throw new Error('user title edit must cancel the queued generation')

    titles.dispose()
    console.log('[smoke] M8 titles OK — empty-title note titled (sanitized, titleSource ai), once-per-note skip, mid-flight user title wins, user edit cancels queue')

    indexer.flushAll()
    closeDb()
  } finally {
    delete process.env.MYMEM_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  }
}

/** M1: exercise migrations + repos end-to-end against a throwaway DB file. */
async function smokeDataSpine(): Promise<void> {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'mymem-smoke-'))
  process.env.MYMEM_DB_PATH = join(dir, 'smoke.db')
  try {
    const { getDb, closeDb } = await import('./db/connection')
    const { createNotesRepo } = await import('./db/repos/notesRepo')
    const { createCollectionsRepo } = await import('./db/repos/collectionsRepo')
    const { createVersionsRepo } = await import('./db/repos/miscRepos')

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const collections = createCollectionsRepo(dbi)
    const versions = createVersionsRepo(dbi)

    const note = notes.create({ title: 'Smoke note', contentMd: '# Hello\n\nworld' })
    const col = collections.create({ name: 'Smoke collection' })
    collections.setForNote(note.id, [col.id])
    notes.update(note.id, { contentMd: '# Hello\n\nupdated' })
    versions.snapshot(notes.get(note.id)!, 'session')

    const withRefs = notes.getWithRefs(note.id)
    if (withRefs?.collectionIds[0] !== col.id) throw new Error('collection membership roundtrip failed')
    if (notes.get(note.id)!.contentMd !== '# Hello\n\nupdated') throw new Error('update roundtrip failed')
    if (versions.list(note.id).length !== 1) throw new Error('version snapshot failed')

    const stale = notes.update(note.id, { title: 'x' }, 12345)
    if (!stale.conflict) throw new Error('CAS guard did not detect stale baseUpdatedAt')

    notes.trash(note.id)
    if (notes.list({ scope: 'all' }).total !== 0) throw new Error('trash did not hide note')
    notes.restore(note.id)
    if (notes.list({ scope: 'all' }).total !== 1) throw new Error('restore failed')

    // ── v1.3: pins — pin → order → reorder → unpin → trash clears the pin ──
    const { createPinsRepo } = await import('./db/repos/miscRepos')
    const pinsRepo = createPinsRepo(dbi)
    const pinNote = notes.create({ title: 'Pinned smoke note' })
    pinsRepo.set('note', pinNote.id, true)
    pinsRepo.set('collection', col.id, true)
    let pinList = pinsRepo.list()
    if (pinList.length !== 2) throw new Error('pins.set did not insert two pins')
    if (pinList[0]!.itemId !== pinNote.id || pinList[1]!.itemId !== col.id) {
      throw new Error('pins.list is not in pin order')
    }
    if (notes.getWithRefs(pinNote.id)!.pinned !== true) throw new Error('getWithRefs missed the pin')
    pinList = pinsRepo.reorder([
      { itemType: 'collection', itemId: col.id },
      { itemType: 'note', itemId: pinNote.id }
    ])
    if (pinList[0]!.itemId !== col.id || pinList[1]!.itemId !== pinNote.id) {
      throw new Error('pins.reorder did not persist the new order')
    }
    pinsRepo.set('collection', col.id, false)
    pinList = pinsRepo.list()
    if (pinList.length !== 1 || pinList[0]!.itemId !== pinNote.id) {
      throw new Error('unpin did not remove the collection pin')
    }
    notes.trash(pinNote.id)
    if (pinsRepo.list().length !== 0) throw new Error('trash did not clear the note pin')
    notes.deleteForever(pinNote.id) // leave no residue for the later list/search counts
    console.log('[smoke] pins OK — both item types, pin order, reorder, unpin, trash clears pin')

    // ── M3: indexer + keyword search (FTS5 needs the Electron-ABI sqlite) ──
    const { createIndexer } = await import('./indexing/indexer')
    const { createSearchService } = await import('./search/searchService')
    const indexer = createIndexer(dbi)
    const search = createSearchService(dbi)

    indexer.flushNote(note.id)
    const hits = search.keyword('updated')
    if (hits.length !== 1 || hits[0]!.noteId !== note.id) throw new Error('keyword search missed the note')
    if (!hits[0]!.snippetHtml.includes('<mark>')) throw new Error('snippet missing <mark> highlight')

    if (search.keyword('updated', col.id).length !== 1) throw new Error('collection filter dropped a member note')
    const otherCol = collections.create({ name: 'Other smoke collection' })
    if (search.keyword('updated', otherCol.id).length !== 0) throw new Error('collection filter leaked a non-member note')

    // Edit → searchable within the 2 s debounce window (the M3 done-criterion)
    notes.update(note.id, { contentMd: '# Hello\n\nzanzibar drums' })
    indexer.enqueue(note.id)
    if (indexer.pendingCount() !== 1) throw new Error('enqueue did not register a pending job')
    await new Promise((resolve) => setTimeout(resolve, 2400))
    if (indexer.pendingCount() !== 0) throw new Error('debounced index job did not drain')
    if (search.keyword('zanzibar').length !== 1) throw new Error('edit not searchable after debounce window')
    if (search.keyword('updated').length !== 0) throw new Error('stale chunk survived the reindex')

    // Trash → gone from results instantly (repo drops chunks synchronously)
    notes.trash(note.id)
    if (search.keyword('zanzibar').length !== 0) throw new Error('trashed note still in search results')
    notes.restore(note.id)
    indexer.flushNote(note.id)
    if (search.keyword('zanzibar').length !== 1) throw new Error('restore + flush did not reindex')

    // Typeahead: prefix match outranks the newer substring match
    const prefixNote = notes.create({ title: 'Zanzibar travel log' })
    notes.create({ title: 'Trip to Zanzibar' })
    const ahead = search.typeahead('zanz')
    if (ahead[0]?.noteId !== prefixNote.id) throw new Error('typeahead prefix did not beat substring')
    if (ahead.length < 2) throw new Error('typeahead substring match missing')

    console.log('[smoke] search spine OK — chunker, hash-diff indexer, FTS keyword + <mark>, instant trash, collection filter, typeahead')

    // ── M4: session-snapshot policy (injectable clock) + restore roundtrip ──
    const { createVersionsService } = await import('./services/versionsService')
    let clock = Date.now()
    const versionsService = createVersionsService(dbi, { notes, versions }, () => clock)
    const vn = notes.create({ title: 'Versioned', contentMd: 'alpha bravo' })

    versionsService.onContentEdit(vn.id) // first content edit since launch
    notes.update(vn.id, { contentMd: 'alpha charlie' })
    let vlist = versions.list(vn.id)
    if (vlist.length !== 1) throw new Error('first content edit did not snapshot')
    if (vlist[0]!.kind !== 'session') throw new Error('snapshot kind is not session')
    if (versions.get(vlist[0]!.id)!.contentMd !== 'alpha bravo') throw new Error('snapshot is not the PRE-edit state')

    clock += 1000 // autosave cadence — still the same editing session
    versionsService.onContentEdit(vn.id)
    notes.update(vn.id, { contentMd: 'alpha delta' })
    if (versions.list(vn.id).length !== 1) throw new Error('same-session edit must not snapshot')

    clock += 16 * 60 * 1000 // > 15 min idle → new session
    versionsService.onContentEdit(vn.id)
    notes.update(vn.id, { contentMd: 'alpha echo' })
    vlist = versions.list(vn.id)
    if (vlist.length !== 2) throw new Error('post-idle edit did not snapshot')
    if (versions.get(vlist[0]!.id)!.contentMd !== 'alpha delta') throw new Error('second snapshot has wrong pre-edit state')

    notes.update(vn.id, { title: 'Versioned note' }) // title-only: the handler never calls onContentEdit
    if (versions.list(vn.id).length !== 2) throw new Error('title-only edit must not snapshot')

    clock += 1000 // hand-revert to the snapshotted text within the session…
    versionsService.onContentEdit(vn.id)
    notes.update(vn.id, { contentMd: 'alpha delta' })
    clock += 16 * 60 * 1000 // …then a new session whose pre-edit state equals the latest version
    versionsService.onContentEdit(vn.id)
    notes.update(vn.id, { contentMd: 'alpha foxtrot' })
    if (versions.list(vn.id).length !== 2) throw new Error('dedup did not skip an identical snapshot')

    // versions:restore semantics (handler logic): non-destructive, pre_restore first
    const target = versions.list(vn.id).find((v) => versions.get(v.id)!.contentMd === 'alpha bravo')!
    versions.snapshot(notes.get(vn.id)!, 'pre_restore')
    const restored = versions.get(target.id)!
    notes.update(vn.id, { title: restored.title, contentMd: restored.contentMd })
    indexer.flushNote(vn.id)
    const afterRestore = versions.list(vn.id)
    if (afterRestore.length !== 3 || afterRestore[0]!.kind !== 'pre_restore') throw new Error('restore did not add a pre_restore version')
    if (notes.get(vn.id)!.contentMd !== 'alpha bravo') throw new Error('restore did not roundtrip content')
    if (search.keyword('bravo').length !== 1) throw new Error('restored content not searchable after flushNote')

    console.log('[smoke] versions OK — once-per-session snapshots, 15 min gap, title-only/dedup skips, pre_restore roundtrip')

    // ── M4: import end-to-end ──
    const { createImportService } = await import('./services/importService')
    const importDir = join(dir, 'import-src')
    const folderDir = join(importDir, 'Project Alpha')
    mkdirSync(folderDir, { recursive: true })
    for (let i = 0; i < 46; i++) {
      writeFileSync(join(importDir, `plain-${String(i).padStart(2, '0')}.md`), `Import marker number${i}\n`)
    }
    writeFileSync(join(importDir, 'h1-note.md'), '# Imported H1 Title\n\nh1body content here\n')
    writeFileSync(join(importDir, 'crlf-note.txt'), 'crlf line one\r\nimportcrlf body\r\n')
    writeFileSync(join(importDir, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 1)) // > 2 MB cap → skipped
    writeFileSync(join(folderDir, 'one.md'), 'folder member one\n')
    writeFileSync(join(folderDir, 'two.md'), 'folder member two\n')

    const preExisting = collections.create({ name: 'Project Alpha' }) // import must REUSE it
    const progress: { done: number; total: number }[] = []
    const importer = createImportService({
      notes,
      collections,
      versions,
      indexer,
      onProgress: (done, total) => progress.push({ done, total })
    })
    const importPaths = [
      ...Array.from({ length: 46 }, (_, i) => join(importDir, `plain-${String(i).padStart(2, '0')}.md`)),
      join(importDir, 'h1-note.md'),
      join(importDir, 'crlf-note.txt'),
      join(importDir, 'big.md'),
      join(importDir, 'ghost.md'), // never written — must skip, not abort
      folderDir // directory → 2 files, collection 'Project Alpha'
    ]
    const { createdIds, skipped } = await importer.importPaths(importPaths)
    const expectedTotal = 52 // 46 + h1 + crlf + big + ghost + 2 folder files
    if (createdIds.length !== 50) throw new Error(`import created ${createdIds.length} notes, expected 50`)
    if (skipped.length !== 2) throw new Error(`import skipped ${skipped.length} files, expected 2 (oversize + missing)`)
    if (progress.length !== expectedTotal) throw new Error('import progress did not fire once per file')
    const last = progress[progress.length - 1]!
    if (last.done !== expectedTotal || last.total !== expectedTotal) throw new Error('import progress counts wrong')

    const imported = createdIds.map((id) => notes.get(id)!)
    const h1Note = imported.find((n) => n.title === 'Imported H1 Title')
    if (!h1Note) throw new Error('H1 title was not derived')
    if (h1Note.contentMd.includes('# Imported H1 Title')) throw new Error('H1 was not stripped from content')
    if (versions.list(h1Note.id)[0]?.kind !== 'import') throw new Error('import snapshot missing')
    const crlfNote = imported.find((n) => n.title === 'crlf-note')
    if (!crlfNote) throw new Error('filename title was not derived for the CRLF file')
    if (crlfNote.contentMd.includes('\r')) throw new Error('CRLF was not normalized to LF')
    if (!imported.some((n) => n.title === 'plain-17')) throw new Error('plain filename title missing')

    if (collections.getByName('Project Alpha')?.id !== preExisting.id) throw new Error('folder collection was not reused by name')
    const members = imported.filter((n) => notes.getWithRefs(n.id)!.collectionIds.includes(preExisting.id))
    if (members.length !== 2) throw new Error('folder files did not join the folder collection')

    for (const id of createdIds) indexer.flushNote(id) // searchable without waiting out the debounce
    if (search.keyword('number17').length !== 1) throw new Error('imported note not searchable after flush')
    if (search.keyword('h1body').length !== 1) throw new Error('imported H1 note not searchable after flush')

    console.log('[smoke] import OK — 50 notes (titles, CRLF, folder collection), 2 skipped, per-file progress, searchable')

    // ── M5: deep search RRF + related notes over SYNTHETIC vectors ──
    // No model download in CI: plant unit vectors directly in chunks_vec and
    // exercise the exact SQL paths the embedding worker feeds in production.
    const { createRelatedService } = await import('./search/relatedService')
    const DIM = 384
    const axis = (i: number, j = -1, mix = 0): Float32Array => {
      const v = new Float32Array(DIM)
      v[i] = Math.sqrt(1 - mix * mix)
      if (j >= 0 && mix > 0) v[j] = mix
      return v
    }
    const blob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
    const chunkIdsOf = (noteId: string): number[] =>
      (dbi.prepare(`SELECT id FROM chunks WHERE note_id = ? ORDER BY idx`).all(noteId) as { id: number }[]).map(
        (r) => r.id
      )
    const plantVec = (chunkId: number, v: Float32Array): void => {
      // BigInt rowid — vec0 rejects better-sqlite3's default double binding.
      dbi.prepare(`INSERT INTO chunks_vec (rowid, embedding) VALUES (?, vec_f32(?))`).run(BigInt(chunkId), blob(v))
      dbi.prepare(`UPDATE chunks SET embedded = 1 WHERE id = ?`).run(chunkId)
    }

    const mkNote = (title: string, contentMd: string): string => {
      const n = notes.create({ title, contentMd })
      indexer.flushNote(n.id)
      return n.id
    }

    // Verify the declared metric really is cosine: orthogonal unit vectors → distance 1.
    const metricProbe = mkNote('Metric probe', 'metric probe body')
    plantVec(chunkIdsOf(metricProbe)[0]!, axis(100))
    const probeDist = (
      dbi
        .prepare(`SELECT distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1`)
        .get(blob(axis(101))) as { distance: number }
    ).distance
    if (Math.abs(probeDist - 1) > 1e-5) throw new Error(`vec0 metric is not cosine (orthogonal distance ${probeDist})`)

    const noteBoth = mkNote('Capacitor research', 'quantum flux capacitor research findings')
    const noteVecOnly = mkNote('Displacement engine', 'temporal displacement engine prototype')
    const noteFtsOnly = mkNote('Flux logbook', 'flux measurements from the field bench') // no vector planted
    // Query vector = e0. noteVecOnly is the closest vector (KNN rank 1) but has no FTS
    // hit; noteBoth is vec rank 2 AND an FTS hit for 'flux' — fusion must win:
    // noteBoth ≥ 1/62+1/62 > any single-list score (≤ 1/61).
    plantVec(chunkIdsOf(noteBoth)[0]!, axis(0, 1, 0.4)) // cos sim ≈ 0.917
    plantVec(chunkIdsOf(noteVecOnly)[0]!, axis(0, 1, 0.2)) // cos sim ≈ 0.980

    const deepHits = search.deepWithVector('flux', axis(0))
    if (deepHits[0]?.noteId !== noteBoth) throw new Error('RRF did not rank the FTS+vector note first')
    const deepIds = deepHits.map((r) => r.noteId)
    if (!deepIds.includes(noteVecOnly)) throw new Error('vector-only note missing from deep results')
    if (!deepIds.includes(noteFtsOnly)) throw new Error('FTS-only note missing from deep results')
    if (!deepHits[0]!.snippetHtml.includes('<mark>')) throw new Error('deep snippet missing <mark> for FTS winner')
    const vecOnlyHit = deepHits.find((r) => r.noteId === noteVecOnly)!
    if (vecOnlyHit.snippetHtml.includes('<mark>')) throw new Error('vector-only hit should have a plain excerpt')
    if (vecOnlyHit.snippetHtml.length === 0) throw new Error('vector-only hit has an empty snippet')

    // (c) keyword fallback: no embedder wired → usedMode 'keyword'
    const fallback = await search.deep('flux')
    if (fallback.usedMode !== 'keyword') throw new Error('deep without a ready worker must fall back to keyword')
    if (fallback.results.length === 0) throw new Error('keyword fallback returned no results')

    // (b) related: planted-similar note above threshold, self + orthogonal excluded
    const related = createRelatedService(dbi)
    const noteX = mkNote('Multi chunk origin', '# Alpha\n\norigin chunk one\n\n# Beta\n\norigin chunk two')
    const noteY = mkNote('Planted similar', 'planted similar content body')
    const noteZ = mkNote('Unrelated note', 'completely unrelated content body')
    const xChunks = chunkIdsOf(noteX)
    if (xChunks.length < 2) throw new Error('expected multiple chunks for the multi-heading note')
    xChunks.forEach((id, i) => plantVec(id, axis(200 + i)))
    plantVec(chunkIdsOf(noteY)[0]!, axis(200, 201, 0.3)) // sim ≈ 0.954 to noteX chunk 0
    plantVec(chunkIdsOf(noteZ)[0]!, axis(250)) // orthogonal to every probe
    const relCol = collections.create({ name: 'Related rollup' })
    const sharedCol = collections.create({ name: 'Shared membership' })
    collections.setForNote(noteY, [relCol.id, sharedCol.id])
    collections.setForNote(noteX, [sharedCol.id])

    const rel = related.forNote(noteX)
    if (rel.unavailableReason) throw new Error(`related unavailable: ${rel.unavailableReason}`)
    if (rel.notes[0]?.noteId !== noteY) throw new Error('related missed the planted-similar note')
    if (rel.notes[0]!.score < 0.45) throw new Error(`related score ${rel.notes[0]!.score} below threshold`)
    if (rel.notes.some((n) => n.noteId === noteX)) throw new Error('related included the note itself')
    if (rel.notes.some((n) => n.noteId === noteZ)) throw new Error('related included an orthogonal note')
    if (!rel.collections.some((c) => c.collectionId === relCol.id)) throw new Error('related collections rollup missing')
    if (rel.collections.some((c) => c.collectionId === sharedCol.id)) {
      throw new Error("related collections must exclude the note's own collections")
    }
    const relUnembedded = related.forNote(mkNote('Fresh unembedded', 'fresh body text'))
    if (relUnembedded.unavailableReason !== 'embeddings-disabled') {
      throw new Error('unembedded note must report the worker state as unavailableReason')
    }

    console.log('[smoke] M5 synthetic OK — cosine vec0, RRF fusion + snippets, keyword fallback, related notes/collections')

    // Reopen (restart persistence)
    closeDb()
    const db2 = getDb()
    const notes2 = createNotesRepo(db2)
    if (notes2.get(note.id)?.title !== 'Smoke note') throw new Error('persistence across reopen failed')
    closeDb()

    console.log('[smoke] data spine OK — migrations, CRUD, CAS, trash/restore, persistence')
  } finally {
    delete process.env.MYMEM_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  }
}
