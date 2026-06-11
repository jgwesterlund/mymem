import { app, BrowserWindow, nativeTheme, screen, shell } from 'electron'
import { join } from 'node:path'
import type { IpcPushMap } from '@shared/ipc'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Saved bounds are only trusted when they still meaningfully overlap a live
 *  display (monitors get unplugged/rearranged) — otherwise use the defaults. */
function sanitizeBounds(b: unknown): WindowBounds | null {
  if (typeof b !== 'object' || b === null) return null
  const { x, y, width, height } = b as Record<string, unknown>
  if (
    typeof x !== 'number' || typeof y !== 'number' ||
    typeof width !== 'number' || typeof height !== 'number' ||
    !Number.isFinite(x) || !Number.isFinite(y) || width < 200 || height < 200
  ) {
    return null
  }
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const overlapY = Math.min(y + height, a.y + a.height) - Math.max(y, a.y)
    return overlapX >= 100 && overlapY >= 100
  })
  return visible ? { x, y, width, height } : null
}

export function createMainWindow(opts?: {
  savedBounds?: unknown
  onBoundsChange?: (b: WindowBounds) => void
}): BrowserWindow {
  const restored = sanitizeBounds(opts?.savedBounds)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    ...(restored ?? {}),
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  // Bounds persistence (M9): debounced — resize/move fire continuously during a
  // drag. getNormalBounds so a fullscreen/maximized session doesn't bake the
  // screen size in as the restored window size.
  if (opts?.onBoundsChange) {
    const onBoundsChange = opts.onBoundsChange
    let boundsTimer: ReturnType<typeof setTimeout> | null = null
    const queuePersist = (): void => {
      if (boundsTimer) clearTimeout(boundsTimer)
      boundsTimer = setTimeout(() => {
        boundsTimer = null
        const win = getMainWindow()
        if (win && !win.isFullScreen()) onBoundsChange(win.getNormalBounds())
      }, 500)
    }
    mainWindow.on('resize', queuePersist)
    mainWindow.on('move', queuePersist)
  }

  // Initial theme push — the renderer subscribes to theme:changed but only main
  // knows nativeTheme; updates are broadcast from index.ts.
  mainWindow.webContents.on('did-finish-load', () => {
    const payload: IpcPushMap['theme:changed'] = { dark: nativeTheme.shouldUseDarkColors }
    mainWindow?.webContents.send('theme:changed', payload)
  })

  // External links open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // app.isPackaged guard: a leaked ELECTRON_RENDERER_URL must never make a
  // packaged build render some other dev server's app.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}
