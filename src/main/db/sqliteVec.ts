import type DatabaseType from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

/**
 * sqlite-vec's vec0.dylib is dlopen'd by SQLite itself, which bypasses Electron's
 * asar fs shim — in packaged builds the path must point into app.asar.unpacked
 * (the dylib is excluded from the archive via asarUnpack in electron-builder.yml).
 */
export function loadSqliteVec(db: DatabaseType.Database): void {
  const loadablePath = sqliteVec
    .getLoadablePath()
    .replace('app.asar' + (process.platform === 'win32' ? '\\' : '/'), 'app.asar.unpacked' + (process.platform === 'win32' ? '\\' : '/'))
  db.loadExtension(loadablePath)
}
