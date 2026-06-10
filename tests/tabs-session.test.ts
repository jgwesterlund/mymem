// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; args: unknown[] }[]
}))

vi.mock('../src/renderer/api', () => ({
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
    h.calls.push({ channel, args })
    if (channel === 'settings:get') return null
    return { ok: true }
  },
  on: () => () => {}
}))

import { initTabsPersistence, useTabsStore } from '../src/renderer/stores/tabs'

describe('tabs session persistence', () => {
  it('flushes the debounced session write on beforeunload (last ≤500 ms must not be lost)', async () => {
    await initTabsPersistence()
    useTabsStore.getState().openTab({ kind: 'trash' })
    expect(h.calls.filter((c) => c.channel === 'settings:set')).toHaveLength(0) // still debounced

    window.dispatchEvent(new Event('beforeunload'))
    const sets = h.calls.filter((c) => c.channel === 'settings:set')
    expect(sets).toHaveLength(1)
    const { key, value } = sets[0]!.args[0] as {
      key: string
      value: { v: number; tabs: unknown[]; activeTabIndex: number }
    }
    expect(key).toBe('session.tabs')
    expect(value.v).toBe(1)
    expect(value.tabs).toHaveLength(2) // home + the trash tab opened above
    expect(value.activeTabIndex).toBe(1)
  })
})
