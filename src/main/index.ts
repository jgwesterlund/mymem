import { app, globalShortcut, nativeTheme } from 'electron'
import { createMainWindow, getMainWindow } from './windows/mainWindow'
import { toggleQuickCapture } from './windows/quickCapture'
import { registerIpcHandlers, getServices } from './ipc/handlers'
import { push } from './ipc/registry'
import { buildAppMenu } from './menu'
import { closeDb } from './db/connection'
import { startApiServer, stopApiServer } from './api/server'
import { runOnboarding } from './onboarding'
import { runSmoke } from './smoke'

// Test isolation (e2e): a private userData also gives the Playwright-launched
// app its own single-instance lock, so tests run alongside a real myMem.
if (process.env.MYMEM_USER_DATA) {
  app.setPath('userData', process.env.MYMEM_USER_DATA)
}

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
        openMainWindow()
      }
    })

    const openMainWindow = (): void => {
      const settings = getServices().settings
      createMainWindow({
        savedBounds: settings.get('window.bounds'),
        onBoundsChange: (b) => settings.set('window.bounds', b)
      })
    }

    void app.whenReady().then(() => {
      registerIpcHandlers()
      buildAppMenu()

      app.setAboutPanelOptions({
        applicationName: 'myMem',
        applicationVersion: app.getVersion(),
        copyright: '© 2026 John Westerlund',
        credits: 'Local-first AI notes — your notes never leave this Mac unless you chat about them.'
      })

      // Persisted theme before the window exists — no light flash on dark boots.
      const savedTheme = getServices().settings.get('ui.theme')
      if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') {
        nativeTheme.themeSource = savedTheme
      }

      // First-run welcome notes (M9) — before the window so the first paint has them.
      runOnboarding(getServices())

      openMainWindow()

      // Local agent API (M6): unix socket in userData, same services as the UI.
      // A failed start must never take the app down — log and continue.
      startApiServer(getServices()).catch((err) => {
        console.error('[api] failed to start', err)
      })

      // Appearance → renderer .dark class (initial push: did-finish-load in
      // mainWindow.ts). Fires for system flips AND for theme:set writes to
      // themeSource; the renderer only toggles a class, so no write-back loop.
      nativeTheme.on('updated', () => {
        push('theme:changed', { dark: nativeTheme.shouldUseDarkColors })
      })

      // Quick capture spike (M0): becomes a setting with plain-text override later.
      globalShortcut.register('Control+Command+Space', () => {
        toggleQuickCapture()
      })
    })

    app.on('activate', () => {
      if (!getMainWindow()) openMainWindow()
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
