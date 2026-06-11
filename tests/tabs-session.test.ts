// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; args: unknown[] }[],
  settings: null as unknown
}))

vi.mock('../src/renderer/api', () => ({
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
    h.calls.push({ channel, args })
    if (channel === 'settings:get') return h.settings
    return { ok: true }
  },
  on: () => () => {}
}))

/**
 * Each test needs a FRESH store module: initTabsPersistence guards against
 * double-init (StrictMode) at module scope, so restore scenarios cannot share
 * one import. vi.resetModules + dynamic import re-applies the api mock.
 */
async function freshStore(): Promise<typeof import('../src/renderer/stores/tabs')> {
  vi.resetModules()
  return import('../src/renderer/stores/tabs')
}

const settingsSets = (): { key: string; value: unknown }[] =>
  h.calls
    .filter((c) => c.channel === 'settings:set')
    .map((c) => c.args[0] as { key: string; value: unknown })

beforeEach(() => {
  h.calls.length = 0
  h.settings = null
})

describe('tabs session persistence (v2: panes)', () => {
  it('flushes the debounced session write on beforeunload (last ≤500 ms must not be lost)', async () => {
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    useTabsStore.getState().openTab({ kind: 'trash' })
    expect(settingsSets()).toHaveLength(0) // still debounced

    window.dispatchEvent(new Event('beforeunload'))
    const sets = settingsSets()
    expect(sets).toHaveLength(1)
    const { key, value } = sets[0]! as {
      key: string
      value: {
        v: number
        tabs: { panes: { content: unknown }[]; activePane: number }[]
        activeTabIndex: number
      }
    }
    expect(key).toBe('session.tabs')
    expect(value.v).toBe(2) // the store writes the pane-aware blob, never v1
    expect(value.tabs).toHaveLength(2) // home + the trash tab opened above
    expect(value.activeTabIndex).toBe(1)
    expect(value.tabs[1]!.panes).toHaveLength(1)
    expect(value.tabs[1]!.panes[0]!.content).toEqual({ kind: 'trash' })
    expect(value.tabs[1]!.activePane).toBe(0)
  })

  it('restores a valid v2 blob including a split tab', async () => {
    const pane = (content: unknown): unknown => ({ content, history: [content], historyIndex: 0 })
    h.settings = {
      v: 2,
      tabs: [
        {
          id: 't1',
          panes: [pane({ kind: 'note', noteId: 'n1' }), pane({ kind: 'note', noteId: 'n2' })],
          activePane: 1
        }
      ],
      activeTabIndex: 0
    }
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    const s = useTabsStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0]!.panes).toHaveLength(2)
    expect(s.tabs[0]!.activePane).toBe(1)
    expect(s.tabs[0]!.panes[1]!.content).toEqual({ kind: 'note', noteId: 'n2' })
  })

  it('upgrades a valid v1 (pre-split) blob: each tab becomes a single pane, history intact', async () => {
    h.settings = {
      v: 1,
      tabs: [
        {
          id: 't1',
          content: { kind: 'note', noteId: 'n1' },
          history: [{ kind: 'home' }, { kind: 'note', noteId: 'n1' }],
          historyIndex: 1
        },
        { id: 't2', content: { kind: 'trash' }, history: [{ kind: 'trash' }], historyIndex: 0 }
      ],
      activeTabIndex: 1
    }
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    const s = useTabsStore.getState()
    expect(s.tabs).toHaveLength(2)
    expect(s.activeTabIndex).toBe(1)
    const first = s.tabs[0]!
    expect(first.panes).toHaveLength(1)
    expect(first.activePane).toBe(0)
    expect(first.panes[0]!.content).toEqual({ kind: 'note', noteId: 'n1' })
    expect(first.panes[0]!.history).toEqual([{ kind: 'home' }, { kind: 'note', noteId: 'n1' }])
    expect(first.panes[0]!.historyIndex).toBe(1)
    expect(s.tabs[1]!.panes[0]!.content).toEqual({ kind: 'trash' })
  })

  const expectFreshHome = (s: {
    tabs: { panes: { content: unknown }[] }[]
    activeTabIndex: number
  }): void => {
    expect(s.tabs).toHaveLength(1)
    expect(s.tabs[0]!.panes).toHaveLength(1)
    expect(s.tabs[0]!.panes[0]!.content).toEqual({ kind: 'home' })
    expect(s.activeTabIndex).toBe(0)
  }

  it('corrupt v1 (null tab entry) falls back to a fresh Home tab — never throws', async () => {
    h.settings = {
      v: 1,
      tabs: [null, { id: 't', content: { kind: 'home' }, history: [{ kind: 'home' }], historyIndex: 0 }],
      activeTabIndex: 0
    }
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    expectFreshHome(useTabsStore.getState())
  })

  it('corrupt v1 (bogus kind / out-of-range historyIndex) falls back to a fresh Home tab', async () => {
    h.settings = {
      v: 1,
      tabs: [{ id: 't', content: { kind: 'nope' }, history: [{ kind: 'nope' }], historyIndex: 5 }],
      activeTabIndex: 0
    }
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    expectFreshHome(useTabsStore.getState())
  })

  it('unknown blob shapes (string, wrong version) fall back to a fresh Home tab', async () => {
    h.settings = '{"not":"a blob"}'
    const { initTabsPersistence, useTabsStore } = await freshStore()
    await initTabsPersistence()
    expectFreshHome(useTabsStore.getState())
  })
})
