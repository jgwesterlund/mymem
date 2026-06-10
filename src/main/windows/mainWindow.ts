import { BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import type { IpcPushMap } from '@shared/ipc'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html`)
  } else {
    void mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}
