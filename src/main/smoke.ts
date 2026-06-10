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
  const { mkdtempSync, rmSync } = await import('node:fs')
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
