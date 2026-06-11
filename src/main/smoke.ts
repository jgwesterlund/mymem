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
    const { createVersionsRepo } = await import('./db/repos/miscRepos')
    const { createIndexer } = await import('./indexing/indexer')
    const { createSearchService } = await import('./search/searchService')
    const { createRelatedService } = await import('./search/relatedService')
    const { createVersionsService } = await import('./services/versionsService')
    const { startApiServer } = await import('./api/server')

    const dbi = getDb()
    const notes = createNotesRepo(dbi)
    const collections = createCollectionsRepo(dbi)
    const versions = createVersionsRepo(dbi)
    const indexer = createIndexer(dbi)
    drainIndexer = () => indexer.flushAll() // pending 2 s debounce timers must not outlive closeDb
    const search = createSearchService(dbi) // no embedder → deep must fall back to keyword
    const related = createRelatedService(dbi)
    const versionsService = createVersionsService(dbi, { notes, versions })

    const started = await startApiServer({ notes, collections, search, related, indexer, versionsService })
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

    // error semantics
    const miss = await req('GET', '/notes/no-such-id')
    if (miss.status !== 404 || !miss.json.error) throw new Error('missing note must 404 with { error }')
    const badSearch = await req('GET', '/search')
    if (badSearch.status !== 400) throw new Error('search without q must 400')
    const badScope = await req('GET', '/notes?scope=collection')
    if (badScope.status !== 400) throw new Error('scope=collection without collectionId must 400')

    console.log('[smoke] M6 API OK — 0600 socket, status, create/get/append by name, session snapshot, search + deep fallback, trash 409/404, collections + membership by name')

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

    console.log('[smoke] M6 CLI OK — built mym, real binary ran status/create/get/search over the live socket')
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
