/**
 * Local API server (M6): HTTP over a unix socket in userData — loopback by
 * construction (no TCP port, no token needed in v1). chmod 0600 after listen
 * so only this user can connect. MYMEM_SOCKET overrides the path for
 * tests/smoke. Started in app-ready (never implicitly in smoke mode), closed
 * in will-quit.
 */
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { chmodSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createApiHandler, type ApiServices } from './routes'

let server: Server | null = null
let activeSocketPath: string | null = null

export function apiSocketPath(): string {
  return process.env.MYMEM_SOCKET ?? join(app.getPath('userData'), 'api.sock')
}

/** Probe an existing socket file: true = a live server accepted the connect. */
function isSocketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

function listenOnce(srv: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    srv.once('error', onError)
    srv.listen(path, () => {
      srv.removeListener('error', onError)
      resolve()
    })
  })
}

/**
 * Returns true when listening. EADDRINUSE → probe the socket: a refused
 * connect means a stale file from a crashed run → unlink and retry ONCE; a
 * live answer means another instance owns the API (rare — the single-instance
 * lock normally prevents this) → log and skip.
 */
export async function startApiServer(services: ApiServices): Promise<boolean> {
  const socketPath = apiSocketPath()
  const srv = createServer(createApiHandler(services))
  // umask 0177 → the socket is born 0600; without it there is a window between
  // listen() and chmod() where other local users could connect.
  const prevUmask = process.umask(0o177)
  try {
    await listenOnce(srv, socketPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    if (await isSocketAlive(socketPath)) {
      console.warn(`[api] another instance owns the API at ${socketPath} — not starting`)
      return false
    }
    // Only ever delete an actual socket — EADDRINUSE also fires when the path
    // is a regular file (e.g. a mispointed MYMEM_SOCKET), which we must keep.
    if (!statSync(socketPath).isSocket()) {
      throw new Error(`refusing to remove ${socketPath}: exists but is not a socket`)
    }
    unlinkSync(socketPath) // stale socket left by a crashed run
    await listenOnce(srv, socketPath)
  } finally {
    process.umask(prevUmask)
  }
  chmodSync(socketPath, 0o600) // belt-and-braces on top of the umask
  server = srv
  activeSocketPath = socketPath
  console.log(`[api] listening on ${socketPath}`)
  return true
}

export function stopApiServer(): void {
  if (!server) return
  server.close()
  server = null
  if (activeSocketPath) {
    try {
      unlinkSync(activeSocketPath) // Node does not unlink unix sockets on close
    } catch {
      // already gone — fine
    }
    activeSocketPath = null
  }
}
