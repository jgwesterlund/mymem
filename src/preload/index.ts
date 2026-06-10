import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  type InvokeChannel,
  type PushChannel
} from '../shared/ipc'

const invokeAllowlist = new Set<string>(INVOKE_CHANNELS)
const pushAllowlist = new Set<string>(PUSH_CHANNELS)

const api = {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    if (!invokeAllowlist.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: PushChannel, callback: (payload: unknown) => void): () => void {
    if (!pushAllowlist.has(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`)
    }
    const listener = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  /** Drag-and-drop import: sandboxed renderers have no File.path (Electron 32+),
   *  so the absolute path comes from webUtils via the bridge — NOT an IPC channel. */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
