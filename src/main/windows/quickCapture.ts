import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'

/**
 * Quick-capture panel — M0 SPIKE.
 *
 * Uses BrowserWindow type:'panel' (NSWindowStyleMaskNonactivatingPanel): shows on all
 * Spaces and should take key input WITHOUT activating the app. Known historical bugs
 * (electron#35483, #35815) — verdict from this spike is recorded in docs/panel-spike.md.
 * Fallback if panel misbehaves: frameless alwaysOnTop ('screen-saver') regular window.
 */

let panel: BrowserWindow | null = null

function createPanel(): BrowserWindow {
  const win = new BrowserWindow({
    width: 680,
    height: 160,
    type: 'panel',
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    vibrancy: 'hud',
    visualEffectState: 'active',
    roundedCorners: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setAlwaysOnTop(true, 'screen-saver')

  // app.isPackaged guard: a leaked ELECTRON_RENDERER_URL must never make a
  // packaged build render some other dev server's app.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/quick-capture.html`)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/quick-capture.html'))
  }

  win.on('blur', () => {
    if (win.isVisible()) win.hide()
  })

  win.on('closed', () => {
    panel = null
  })

  return win
}

function centerOnActiveDisplay(win: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  const [w, h] = win.getSize()
  win.setPosition(Math.round(x + (width - (w ?? 680)) / 2), Math.round(y + height * 0.22 - (h ?? 160) / 2))
}

export function toggleQuickCapture(): void {
  if (!panel || panel.isDestroyed()) panel = createPanel()
  if (panel.isVisible()) {
    panel.hide()
    return
  }
  centerOnActiveDisplay(panel)
  panel.show()
  panel.webContents.send('capture:focus')
}

export function hideQuickCapture(): void {
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide()
}
