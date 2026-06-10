import type { IpcInvokeMap, IpcPushMap, InvokeChannel, PushChannel } from '@shared/ipc'

type RawApi = {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>
  on(channel: PushChannel, callback: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    api: RawApi
  }
}

/** Typed facade over the preload bridge — the only way the renderer talks to main. */
export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: IpcInvokeMap[C]['args']
): Promise<IpcInvokeMap[C]['result']> {
  return window.api.invoke(channel, ...args) as Promise<IpcInvokeMap[C]['result']>
}

export function on<C extends PushChannel>(
  channel: C,
  callback: (payload: IpcPushMap[C]) => void
): () => void {
  return window.api.on(channel, callback as (payload: unknown) => void)
}
