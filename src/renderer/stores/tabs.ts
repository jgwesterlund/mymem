import { create } from 'zustand'
import { invoke } from '../api'

/**
 * The tabs store IS the router (no react-router). M9: each Tab owns 1–2 Panes
 * (Cmd+. split); every pane keeps its own back/forward history. Actions keep
 * their M2 signatures and operate on the ACTIVE pane of the active tab.
 */
export type PaneContent =
  | { kind: 'home' }
  | { kind: 'note'; noteId: string }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'search'; query: string }
  | { kind: 'trash' }

export interface Pane {
  content: PaneContent // always === history[historyIndex]
  history: PaneContent[]
  historyIndex: number
}

export interface Tab {
  id: string
  panes: Pane[] // length 1 (normal) or 2 (split)
  activePane: number // index into panes
}

const HISTORY_CAP = 50

function makePane(content: PaneContent): Pane {
  return { content, history: [content], historyIndex: 0 }
}

let nextTabId = 1
function makeTab(content: PaneContent): Tab {
  return { id: `tab-${nextTabId++}-${Date.now().toString(36)}`, panes: [makePane(content)], activePane: 0 }
}

function pushContent(pane: Pane, content: PaneContent): Pane {
  if (JSON.stringify(pane.content) === JSON.stringify(content)) return pane
  const history = [...pane.history.slice(0, pane.historyIndex + 1), content].slice(-HISTORY_CAP)
  return { content, history, historyIndex: history.length - 1 }
}

interface TabsState {
  tabs: Tab[]
  activeTabIndex: number
  openTab: (content: PaneContent) => void
  openInCurrentTab: (content: PaneContent) => void
  /** ⌥ (Alt) target: open in the OTHER pane of the active tab, splitting if needed. */
  openInOtherPane: (content: PaneContent) => void
  /** Cmd+. — toggle split: duplicate the active pane / collapse to the active pane. */
  splitPane: () => void
  setActivePane: (index: number) => void
  closeTab: (id?: string) => void
  activateTab: (index: number) => void
  nextTab: () => void
  prevTab: () => void
  navBack: () => void
  navForward: () => void
  /** A collection was hard-deleted (UI, CLI or API): panes showing it go Home,
   *  history entries pointing at it are dropped. */
  purgeCollection: (collectionId: string) => void
}

/** Content of the active pane of the active tab (zustand selector / imperative). */
export function selectActiveContent(s: Pick<TabsState, 'tabs' | 'activeTabIndex'>): PaneContent | undefined {
  const tab = s.tabs[s.activeTabIndex]
  return tab?.panes[tab.activePane]?.content
}

export function getActiveContent(): PaneContent | undefined {
  return selectActiveContent(useTabsStore.getState())
}

/** Open content according to a click/key modifier target. */
export function openContent(content: PaneContent, target: 'self' | 'tab' | 'pane'): void {
  const s = useTabsStore.getState()
  if (target === 'tab') s.openTab(content)
  else if (target === 'pane') s.openInOtherPane(content)
  else s.openInCurrentTab(content)
}

function updateActiveTab(s: TabsState, update: (tab: Tab) => Tab): Pick<TabsState, 'tabs'> | TabsState {
  const tab = s.tabs[s.activeTabIndex]
  if (!tab) return s
  const next = update(tab)
  if (next === tab) return s
  return { tabs: s.tabs.map((t, i) => (i === s.activeTabIndex ? next : t)) }
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [makeTab({ kind: 'home' })],
  activeTabIndex: 0,

  openTab(content) {
    set((s) => ({ tabs: [...s.tabs, makeTab(content)], activeTabIndex: s.tabs.length }))
  },

  openInCurrentTab(content) {
    set((s) =>
      updateActiveTab(s, (tab) => {
        const pane = tab.panes[tab.activePane]
        if (!pane) return tab
        const next = pushContent(pane, content)
        if (next === pane) return tab
        return { ...tab, panes: tab.panes.map((p, i) => (i === tab.activePane ? next : p)) }
      })
    )
  },

  openInOtherPane(content) {
    set((s) =>
      updateActiveTab(s, (tab) => {
        if (tab.panes.length < 2) {
          // Create the split with the new content in pane 2; keep focus where it is
          // so list keyboard navigation can keep firing ⌥+Enter.
          return { ...tab, panes: [...tab.panes, makePane(content)] }
        }
        const other = tab.activePane === 0 ? 1 : 0
        const pane = tab.panes[other]!
        const next = pushContent(pane, content)
        if (next === pane) return tab
        return { ...tab, panes: tab.panes.map((p, i) => (i === other ? next : p)) }
      })
    )
  },

  splitPane() {
    set((s) =>
      updateActiveTab(s, (tab) => {
        if (tab.panes.length >= 2) {
          // Collapse keeping the ACTIVE pane (its history survives).
          return { ...tab, panes: [tab.panes[tab.activePane]!], activePane: 0 }
        }
        const pane = tab.panes[tab.activePane]!
        // Duplicate the current content into pane 2 and focus it.
        return { ...tab, panes: [pane, makePane(pane.content)], activePane: 1 }
      })
    )
  },

  setActivePane(index) {
    set((s) =>
      updateActiveTab(s, (tab) =>
        index >= 0 && index < tab.panes.length && index !== tab.activePane ? { ...tab, activePane: index } : tab
      )
    )
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

  purgeCollection(collectionId) {
    const refersTo = (c: PaneContent): boolean =>
      c.kind === 'collection' && c.collectionId === collectionId
    set((s) => ({
      tabs: s.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => {
          if (!pane.history.some(refersTo)) return pane
          const history = pane.history.filter((c) => !refersTo(c))
          if (history.length === 0) history.push({ kind: 'home' })
          const wasCurrent = refersTo(pane.content)
          const historyIndex = wasCurrent
            ? history.length - 1
            : Math.max(0, history.findIndex((c) => c === pane.content))
          return { content: history[historyIndex]!, history, historyIndex }
        }) as typeof tab.panes
      }))
    }))
  },

  navBack() {
    set((s) =>
      updateActiveTab(s, (tab) => {
        const pane = tab.panes[tab.activePane]
        if (!pane || pane.historyIndex === 0) return tab
        const historyIndex = pane.historyIndex - 1
        const next: Pane = { ...pane, historyIndex, content: pane.history[historyIndex]! }
        return { ...tab, panes: tab.panes.map((p, i) => (i === tab.activePane ? next : p)) }
      })
    )
  },

  navForward() {
    set((s) =>
      updateActiveTab(s, (tab) => {
        const pane = tab.panes[tab.activePane]
        if (!pane || pane.historyIndex >= pane.history.length - 1) return tab
        const historyIndex = pane.historyIndex + 1
        const next: Pane = { ...pane, historyIndex, content: pane.history[historyIndex]! }
        return { ...tab, panes: tab.panes.map((p, i) => (i === tab.activePane ? next : p)) }
      })
    )
  }
}))

// ── Session persistence: versioned blob in settings, restored on boot ─────────
const SESSION_KEY = 'session.tabs'
type SessionBlob = { v: 2; tabs: Tab[]; activeTabIndex: number }
/** Pre-split shape (M2–M8) — upgraded on read, never written anymore. */
type SessionBlobV1 = {
  v: 1
  tabs: { id: string; content: PaneContent; history: PaneContent[]; historyIndex: number }[]
  activeTabIndex: number
}

const VALID_KINDS = new Set(['home', 'note', 'collection', 'search', 'trash'])

function isValidContent(c: unknown): c is PaneContent {
  if (typeof c !== 'object' || c === null) return false
  const k = (c as { kind?: unknown }).kind
  return typeof k === 'string' && VALID_KINDS.has(k)
}

function isValidPane(p: unknown): p is Pane {
  if (typeof p !== 'object' || p === null) return false
  const pane = p as Partial<Pane>
  return (
    Array.isArray(pane.history) &&
    pane.history.length > 0 &&
    pane.history.every(isValidContent) &&
    typeof pane.historyIndex === 'number' &&
    pane.historyIndex >= 0 &&
    pane.historyIndex < pane.history.length &&
    isValidContent(pane.content)
  )
}

function isValidSession(blob: unknown): blob is SessionBlob {
  if (typeof blob !== 'object' || blob === null) return false
  const b = blob as Partial<SessionBlob>
  if (b.v !== 2 || !Array.isArray(b.tabs) || typeof b.activeTabIndex !== 'number') return false
  return (
    b.tabs.length > 0 &&
    b.tabs.every(
      (t) =>
        typeof t?.id === 'string' &&
        Array.isArray(t.panes) &&
        t.panes.length >= 1 &&
        t.panes.length <= 2 &&
        t.panes.every(isValidPane) &&
        typeof t.activePane === 'number' &&
        t.activePane >= 0 &&
        t.activePane < t.panes.length
    )
  )
}

/**
 * v1 → v2: wrap each tab's single content+history into panes[0]. Never throws:
 * corrupt entries (null tabs, missing history, …) produce an invalid candidate
 * that isValidSession rejects → the caller falls back to a fresh Home tab.
 */
function upgradeV1(blob: unknown): SessionBlob | null {
  if (typeof blob !== 'object' || blob === null) return null
  const b = blob as Partial<SessionBlobV1>
  if (b.v !== 1 || !Array.isArray(b.tabs) || typeof b.activeTabIndex !== 'number') return null
  const upgraded = {
    v: 2,
    tabs: b.tabs.map((t) => ({
      id: String(t?.id ?? `tab-${nextTabId++}`),
      panes: [{ content: t?.content, history: t?.history, historyIndex: t?.historyIndex }],
      activePane: 0
    })),
    activeTabIndex: b.activeTabIndex
  } as SessionBlob
  return isValidSession(upgraded) ? upgraded : null
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistenceInited = false

function persistSession(s: Pick<TabsState, 'tabs' | 'activeTabIndex'>): void {
  const blob: SessionBlob = { v: 2, tabs: s.tabs, activeTabIndex: s.activeTabIndex }
  void invoke('settings:set', { key: SESSION_KEY, value: blob })
}

/** Call once from App: restores the session, then persists every change (debounced). */
export async function initTabsPersistence(): Promise<void> {
  if (persistenceInited) return // StrictMode double-mount guard
  persistenceInited = true
  try {
    const raw = await invoke('settings:get', { key: SESSION_KEY })
    const blob = isValidSession(raw) ? raw : upgradeV1(raw)
    if (blob) {
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
