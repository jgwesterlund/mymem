import { create } from 'zustand'
import { invoke } from '../api'

export interface Toast {
  id: number
  message: string
  /** Optional action button (e.g. Undo after auto-organize) — extends the timeout. */
  action?: { label: string; onClick: () => void }
}

export type RightPanelTab = 'chat' | 'headsup'

const RIGHT_PANEL_MIN_W = 260
const RIGHT_PANEL_MAX_W = 560
const RIGHT_PANEL_DEFAULT_W = 320
const SIDEBAR_MIN_W = 200
const SIDEBAR_MAX_W = 360
const SIDEBAR_DEFAULT_W = 240
const SPLIT_RATIO_MIN = 0.2
const SPLIT_RATIO_MAX = 0.8

interface UiState {
  sidebarVisible: boolean
  searchPaletteOpen: boolean
  rightPanelVisible: boolean
  rightPanelTab: RightPanelTab
  rightPanelWidth: number
  sidebarWidth: number
  /** Width fraction of pane 1 when a tab is split (global, not per tab). */
  splitRatio: number
  /** Settings overlay (Cmd+,) — a modal in the main window, NOT a separate window (plan cut). */
  settingsOpen: boolean
  /** Note whose VersionHistoryModal is open (rendered by that note's NoteView). */
  historyNoteId: string | null
  /** Note whose OrganizeModal (Cmd+O) is open (rendered by that note's NoteView). */
  organizeNoteId: string | null
  /** Bumped by the export-note command; the mounted NoteView flushes, then exports. */
  exportRequest: number
  /** Bumped by the clean-up command; the mounted NoteView flushes, then opens the overlay. */
  cleanupRequest: number
  /** Bumped by Cmd+F; the FOCUSED NoteView opens its FindBar. */
  findRequest: number
  toasts: Toast[]
  toggleSidebar: () => void
  setSearchPaletteOpen: (open: boolean) => void
  toggleRightPanel: () => void
  /** Cmd+Shift+K: opens the panel on Heads Up; toggles closed if already there. */
  toggleHeadsUp: () => void
  setRightPanelTab: (tab: RightPanelTab) => void
  setRightPanelWidth: (width: number) => void
  setSidebarWidth: (width: number) => void
  setSplitRatio: (ratio: number) => void
  setSettingsOpen: (open: boolean) => void
  openHistory: (noteId: string) => void
  closeHistory: () => void
  openOrganize: (noteId: string) => void
  closeOrganize: () => void
  requestExport: () => void
  requestCleanup: () => void
  requestFind: () => void
  showToast: (message: string, action?: Toast['action']) => void
  dismissToast: (id: number) => void
}

let nextToastId = 1

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  searchPaletteOpen: false,
  rightPanelVisible: false,
  rightPanelTab: 'headsup',
  rightPanelWidth: RIGHT_PANEL_DEFAULT_W,
  sidebarWidth: SIDEBAR_DEFAULT_W,
  splitRatio: 0.5,
  settingsOpen: false,
  historyNoteId: null,
  organizeNoteId: null,
  exportRequest: 0,
  cleanupRequest: 0,
  findRequest: 0,
  toasts: [],
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
  },
  toggleRightPanel() {
    set((s) => ({ rightPanelVisible: !s.rightPanelVisible }))
  },
  toggleHeadsUp() {
    set((s) =>
      s.rightPanelVisible && s.rightPanelTab === 'headsup'
        ? { rightPanelVisible: false }
        : { rightPanelVisible: true, rightPanelTab: 'headsup' }
    )
  },
  setRightPanelTab(tab) {
    set({ rightPanelTab: tab })
  },
  setRightPanelWidth(width) {
    set({ rightPanelWidth: Math.max(RIGHT_PANEL_MIN_W, Math.min(RIGHT_PANEL_MAX_W, Math.round(width))) })
  },
  setSidebarWidth(width) {
    set({ sidebarWidth: Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, Math.round(width))) })
  },
  setSplitRatio(ratio) {
    set({ splitRatio: Math.max(SPLIT_RATIO_MIN, Math.min(SPLIT_RATIO_MAX, ratio)) })
  },
  setSearchPaletteOpen(open) {
    set({ searchPaletteOpen: open })
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open })
  },
  openHistory(noteId) {
    set({ historyNoteId: noteId })
  },
  closeHistory() {
    set({ historyNoteId: null })
  },
  openOrganize(noteId) {
    set({ organizeNoteId: noteId })
  },
  closeOrganize() {
    set({ organizeNoteId: null })
  },
  requestExport() {
    set((s) => ({ exportRequest: s.exportRequest + 1 }))
  },
  requestCleanup() {
    set((s) => ({ cleanupRequest: s.cleanupRequest + 1 }))
  },
  requestFind() {
    set((s) => ({ findRequest: s.findRequest + 1 }))
  },
  showToast(message, action) {
    const id = nextToastId++
    set((s) => ({ toasts: [...s.toasts, { id, message, action }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, action ? 8000 : 3500) // actionable toasts linger long enough to click Undo
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

export function toast(message: string): void {
  useUiStore.getState().showToast(message)
}

// ── Layout persistence: versioned blob in settings, restored on boot ──────────
// v1 carried only the right panel; v2 (M9) adds sidebarWidth + splitRatio.
const RIGHT_PANEL_KEY = 'ui.rightPanel'
type LayoutBlob = {
  v: 1 | 2
  visible: boolean
  tab: RightPanelTab
  width: number
  sidebarWidth?: number
  splitRatio?: number
}

function isValidBlob(blob: unknown): blob is LayoutBlob {
  if (typeof blob !== 'object' || blob === null) return false
  const b = blob as Partial<LayoutBlob>
  return (
    (b.v === 1 || b.v === 2) &&
    typeof b.visible === 'boolean' &&
    (b.tab === 'chat' || b.tab === 'headsup') &&
    typeof b.width === 'number'
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

let uiPersistTimer: ReturnType<typeof setTimeout> | null = null
let uiPersistenceInited = false

/** Call once from App: restores panel visibility/tab/width, then persists changes. */
export async function initUiPersistence(): Promise<void> {
  if (uiPersistenceInited) return // StrictMode double-mount guard
  uiPersistenceInited = true
  try {
    const blob = await invoke('settings:get', { key: RIGHT_PANEL_KEY })
    if (isValidBlob(blob)) {
      useUiStore.setState({
        rightPanelVisible: blob.visible,
        rightPanelTab: blob.tab,
        rightPanelWidth: Number.isFinite(blob.width)
          ? clamp(Math.round(blob.width), RIGHT_PANEL_MIN_W, RIGHT_PANEL_MAX_W)
          : RIGHT_PANEL_DEFAULT_W,
        sidebarWidth:
          typeof blob.sidebarWidth === 'number' && Number.isFinite(blob.sidebarWidth)
            ? clamp(Math.round(blob.sidebarWidth), SIDEBAR_MIN_W, SIDEBAR_MAX_W)
            : SIDEBAR_DEFAULT_W,
        splitRatio:
          typeof blob.splitRatio === 'number' && Number.isFinite(blob.splitRatio)
            ? clamp(blob.splitRatio, SPLIT_RATIO_MIN, SPLIT_RATIO_MAX)
            : 0.5
      })
    }
  } catch {
    // Parse/IPC failure → keep defaults.
  }

  let prev = useUiStore.getState()
  useUiStore.subscribe((s) => {
    const changed =
      s.rightPanelVisible !== prev.rightPanelVisible ||
      s.rightPanelTab !== prev.rightPanelTab ||
      s.rightPanelWidth !== prev.rightPanelWidth ||
      s.sidebarWidth !== prev.sidebarWidth ||
      s.splitRatio !== prev.splitRatio
    prev = s
    if (!changed) return
    if (uiPersistTimer) clearTimeout(uiPersistTimer)
    uiPersistTimer = setTimeout(() => {
      uiPersistTimer = null
      const cur = useUiStore.getState()
      const blob: LayoutBlob = {
        v: 2,
        visible: cur.rightPanelVisible,
        tab: cur.rightPanelTab,
        width: cur.rightPanelWidth,
        sidebarWidth: cur.sidebarWidth,
        splitRatio: cur.splitRatio
      }
      void invoke('settings:set', { key: RIGHT_PANEL_KEY, value: blob })
    }, 500)
  })
}
