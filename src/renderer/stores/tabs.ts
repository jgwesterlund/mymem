import { create } from 'zustand'
import { invoke } from '../api'

/**
 * The tabs store IS the router (no react-router). One pane per tab in M2; the
 * M9 split is additive (Tab grows a second content+history pair, actions keep
 * their signatures and operate on the focused pane).
 */
export type PaneContent =
  | { kind: 'home' }
  | { kind: 'note'; noteId: string }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'search'; query: string } // rendered as a stub until M3
  | { kind: 'trash' }

export interface Tab {
  id: string
  content: PaneContent // always === history[historyIndex]
  history: PaneContent[]
  historyIndex: number
}

const HISTORY_CAP = 50

let nextTabId = 1
function makeTab(content: PaneContent): Tab {
  return { id: `tab-${nextTabId++}-${Date.now().toString(36)}`, content, history: [content], historyIndex: 0 }
}

interface TabsState {
  tabs: Tab[]
  activeTabIndex: number
  openTab: (content: PaneContent) => void
  openInCurrentTab: (content: PaneContent) => void
  closeTab: (id?: string) => void
  activateTab: (index: number) => void
  nextTab: () => void
  prevTab: () => void
  navBack: () => void
  navForward: () => void
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [makeTab({ kind: 'home' })],
  activeTabIndex: 0,

  openTab(content) {
    set((s) => ({ tabs: [...s.tabs, makeTab(content)], activeTabIndex: s.tabs.length }))
  },

  openInCurrentTab(content) {
    set((s) => {
      const tab = s.tabs[s.activeTabIndex]
      if (!tab) return s
      if (JSON.stringify(tab.content) === JSON.stringify(content)) return s
      const history = [...tab.history.slice(0, tab.historyIndex + 1), content].slice(-HISTORY_CAP)
      const next: Tab = { ...tab, content, history, historyIndex: history.length - 1 }
      return { tabs: s.tabs.map((t, i) => (i === s.activeTabIndex ? next : t)) }
    })
  },

  closeTab(id) {
    set((s) => {
      const index = id ? s.tabs.findIndex((t) => t.id === id) : s.activeTabIndex
      if (index < 0) return s
      const tabs = s.tabs.filter((_, i) => i !== index)
      // Last tab closed → replace with a fresh Home tab (the strip is never empty).
      if (tabs.length === 0) return { tabs: [makeTab({ kind: 'home' })], activeTabIndex: 0 }
      const active = s.activeTabIndex > index || s.activeTabIndex === tabs.length
        ? s.activeTabIndex - 1
        : s.activeTabIndex
      return { tabs, activeTabIndex: Math.max(0, Math.min(active, tabs.length - 1)) }
    })
  },

  activateTab(index) {
    set((s) => {
      const i = index === -1 ? s.tabs.length - 1 : index
      return i >= 0 && i < s.tabs.length ? { activeTabIndex: i } : s
    })
  },

  nextTab() {
    set((s) => ({ activeTabIndex: (s.activeTabIndex + 1) % s.tabs.length }))
  },

  prevTab() {
    set((s) => ({ activeTabIndex: (s.activeTabIndex - 1 + s.tabs.length) % s.tabs.length }))
  },

  navBack() {
    set((s) => {
      const tab = s.tabs[s.activeTabIndex]
      if (!tab || tab.historyIndex === 0) return s
      const historyIndex = tab.historyIndex - 1
      const next: Tab = { ...tab, historyIndex, content: tab.history[historyIndex]! }
      return { tabs: s.tabs.map((t, i) => (i === s.activeTabIndex ? next : t)) }
    })
  },

  navForward() {
    set((s) => {
      const tab = s.tabs[s.activeTabIndex]
      if (!tab || tab.historyIndex >= tab.history.length - 1) return s
      const historyIndex = tab.historyIndex + 1
      const next: Tab = { ...tab, historyIndex, content: tab.history[historyIndex]! }
      return { tabs: s.tabs.map((t, i) => (i === s.activeTabIndex ? next : t)) }
    })
  }
}))

// ── Session persistence: versioned blob in settings, restored on boot ─────────
const SESSION_KEY = 'session.tabs'
type SessionBlob = { v: 1; tabs: Tab[]; activeTabIndex: number }

const VALID_KINDS = new Set(['home', 'note', 'collection', 'search', 'trash'])

function isValidContent(c: unknown): c is PaneContent {
  if (typeof c !== 'object' || c === null) return false
  const k = (c as { kind?: unknown }).kind
  return typeof k === 'string' && VALID_KINDS.has(k)
}

function isValidSession(blob: unknown): blob is SessionBlob {
  if (typeof blob !== 'object' || blob === null) return false
  const b = blob as Partial<SessionBlob>
  if (b.v !== 1 || !Array.isArray(b.tabs) || typeof b.activeTabIndex !== 'number') return false
  return (
    b.tabs.length > 0 &&
    b.tabs.every(
      (t) =>
        typeof t?.id === 'string' &&
        Array.isArray(t.history) &&
        t.history.length > 0 &&
        t.history.every(isValidContent) &&
        typeof t.historyIndex === 'number' &&
        t.historyIndex >= 0 &&
        t.historyIndex < t.history.length &&
        isValidContent(t.content)
    )
  )
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistenceInited = false

function persistSession(s: Pick<TabsState, 'tabs' | 'activeTabIndex'>): void {
  const blob: SessionBlob = { v: 1, tabs: s.tabs, activeTabIndex: s.activeTabIndex }
  void invoke('settings:set', { key: SESSION_KEY, value: blob })
}

/** Call once from App: restores the session, then persists every change (debounced). */
export async function initTabsPersistence(): Promise<void> {
  if (persistenceInited) return // StrictMode double-mount guard
  persistenceInited = true
  try {
    const blob = await invoke('settings:get', { key: SESSION_KEY })
    if (isValidSession(blob)) {
      const activeTabIndex = Math.max(0, Math.min(blob.activeTabIndex, blob.tabs.length - 1))
      useTabsStore.setState({ tabs: blob.tabs, activeTabIndex })
      // Keep generated ids unique after restore.
      nextTabId += blob.tabs.length
    }
  } catch {
    // Parse/IPC failure → keep the fresh Home tab.
  }

  useTabsStore.subscribe((s) => {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistSession(s)
    }, 500)
  })

  // The debounce would drop the last ≤500 ms of tab changes on quit — flush it.
  window.addEventListener('beforeunload', () => {
    if (!persistTimer) return
    clearTimeout(persistTimer)
    persistTimer = null
    persistSession(useTabsStore.getState())
  })
}
