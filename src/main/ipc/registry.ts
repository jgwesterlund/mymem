import { BrowserWindow, ipcMain } from 'electron'
import type { DataChangedEvent, IpcInvokeMap, IpcPushMap, InvokeChannel, PushChannel } from '@shared/ipc'

/** Typed ipcMain.handle wrapper — the only way handlers are registered. */
export function typedHandle<C extends InvokeChannel>(
  channel: C,
  handler: (...args: IpcInvokeMap[C]['args']) => IpcInvokeMap[C]['result'] | Promise<IpcInvokeMap[C]['result']>
): void {
  ipcMain.handle(channel, (_event, ...args) => handler(...(args as IpcInvokeMap[C]['args'])))
}

/** Push a typed event to every open window (single-user app — broadcast is correct). */
export function push<C extends PushChannel>(channel: C, payload: IpcPushMap[C]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function emitDataChanged(event: DataChangedEvent): void {
  push('data:changed', event)
}
