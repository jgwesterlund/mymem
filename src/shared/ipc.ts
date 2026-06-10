/**
 * THE single IPC contract between main and renderer.
 * M0 ships a minimal slice; M1 expands this to the full channel map
 * (notes/collections/search/versions/settings + reserved ai.* shapes).
 *
 * Conventions:
 * - Invoke channels: `domain:action`, request/response typed in IpcInvokeMap.
 * - Push channels (main -> renderer): typed in IpcPushMap, sent via WebContents.send.
 */

export interface IpcInvokeMap {
  'app:ping': {
    args: []
    result: { ok: true; version: string; electron: string; node: string }
  }
  // Quick capture (stub in M0 — wired to the notes repo in M1)
  'capture:save': {
    args: [{ text: string }]
    result: { noteId: string | null }
  }
  'capture:hide': { args: []; result: void }
}

export type DataChangedEvent = {
  entity: 'note' | 'collection' | 'pin' | 'template'
  ids: string[]
  op: 'create' | 'update' | 'trash' | 'restore' | 'delete'
  origin: 'user' | 'ai' | 'import' | 'capture' | 'api'
}

export interface IpcPushMap {
  'data:changed': DataChangedEvent
  // Sent to the quick-capture panel when it is shown, so it can focus its input.
  'capture:focus': undefined
}

export type InvokeChannel = keyof IpcInvokeMap
export type PushChannel = keyof IpcPushMap

// Runtime allowlists used by the preload bridge — keep in sync with the maps above.
export const INVOKE_CHANNELS: InvokeChannel[] = ['app:ping', 'capture:save', 'capture:hide']
export const PUSH_CHANNELS: PushChannel[] = ['data:changed', 'capture:focus']
