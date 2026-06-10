import { app, ipcMain, globalShortcut } from 'electron'
import { createMainWindow, getMainWindow } from './windows/mainWindow'
import { toggleQuickCapture, hideQuickCapture } from './windows/quickCapture'
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
      registerIpc()
      createMainWindow()

      // Quick capture spike (M0): verify type:'panel' behavior early.
      // Default hotkey; becomes a setting with plain-text override later.
      globalShortcut.register('Control+Command+Space', () => {
        toggleQuickCapture()
      })
    })

    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })

    // mem-style: app lives until explicitly quit; closing the window keeps it in the dock.
    app.on('window-all-closed', () => {
      /* keep running — quick capture must work with the main window closed */
    })

    app.on('will-quit', () => {
      globalShortcut.unregisterAll()
    })
  }
}

function registerIpc(): void {
  ipcMain.handle('app:ping', () => ({
    ok: true as const,
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown'
  }))

  // M0 stub — M1 wires this to the notes repo + indexer and emits data:changed.
  ipcMain.handle('capture:save', (_event, payload: { text: string }) => {
    console.log('[capture:save] stub, received', payload.text.length, 'chars')
    return { noteId: null }
  })

  ipcMain.handle('capture:hide', () => {
    hideQuickCapture()
  })
}
