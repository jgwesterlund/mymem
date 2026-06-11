import { app, globalShortcut, nativeTheme } from 'electron'
import { createMainWindow, getMainWindow } from './windows/mainWindow'
import { toggleQuickCapture } from './windows/quickCapture'
import { registerIpcHandlers, getServices } from './ipc/handlers'
import { push } from './ipc/registry'
import { buildAppMenu } from './menu'
import { closeDb } from './db/connection'
import { startApiServer, stopApiServer } from './api/server'
import { runSmoke } from './smoke'

// Smoke mode: verify native/ESM deps load inside Electron, then exit. No windows.
if (process.env.MYMEM_SMOKE) {
  void app.whenReady().then(async () => {
    const code = await runSmoke()
    app.exit(code)
  })
} else {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', () => {
      const win = getMainWindow()
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      } else {
        createMainWindow()
      }
    })

    void app.whenReady().then(() => {
      registerIpcHandlers()
      buildAppMenu()
      createMainWindow()

      // Local agent API (M6): unix socket in userData, same services as the UI.
      // A failed start must never take the app down — log and continue.
      startApiServer(getServices()).catch((err) => {
        console.error('[api] failed to start', err)
      })

      // System appearance → renderer .dark class (initial push: did-finish-load
      // in mainWindow.ts — full dark-mode QA stays M9).
      nativeTheme.on('updated', () => {
        push('theme:changed', { dark: nativeTheme.shouldUseDarkColors })
      })

      // Quick capture spike (M0): becomes a setting with plain-text override later.
      globalShortcut.register('Control+Command+Space', () => {
        toggleQuickCapture()
      })
    })

    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })

    // mem-style: app lives until explicitly quit; quick capture works with the window closed.
    app.on('window-all-closed', () => {})

    app.on('will-quit', () => {
      globalShortcut.unregisterAll()
      stopApiServer()
      // Drain pending index jobs so a quit inside the 2 s debounce can't leave stale chunks.
      getServices().indexer.flushAll()
      getServices().embedder.stop() // no restarts after this — embedded=0 backlog drains next boot
      closeDb()
    })
  }
}
