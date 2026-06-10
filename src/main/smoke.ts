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

    console.log('[smoke] ALL OK')
    return 0
  } catch (err) {
    console.error('[smoke] FAILED:', err)
    return 1
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
