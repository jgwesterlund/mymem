import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { COMMANDS } from '@shared/commands'
import type { CommandId, IpcPushMap } from '@shared/ipc'
import { getMainWindow } from './windows/mainWindow'

/** Every app shortcut is a native accelerator → menu:command push to the MAIN window
 *  (always — app commands are main-window semantics; routing to the focused window
 *  would let the quick-capture panel swallow them). */
function sendCommand(commandId: CommandId): void {
  const win = getMainWindow()
  if (!win) return
  const payload: IpcPushMap['menu:command'] = { commandId }
  win.webContents.send('menu:command', payload)
}

function items(menu: 'file' | 'edit' | 'view' | 'note' | 'window'): MenuItemConstructorOptions[] {
  return (Object.entries(COMMANDS) as [CommandId, (typeof COMMANDS)[CommandId]][])
    .filter(([, spec]) => spec.menu === menu)
    .map(([id, spec]) => ({
      label: spec.label,
      accelerator: spec.accelerator,
      click: () => sendCommand(id)
    }))
}

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { label: 'File', submenu: items('file') },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        ...(items('edit').length ? [{ type: 'separator' } as const, ...items('edit')] : [])
      ]
    },
    {
      label: 'View',
      submenu: [
        ...items('view'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' } as const, { role: 'toggleDevTools' } as const])
      ]
    },
    { label: 'Note', submenu: items('note') },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        ...items('window'),
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
