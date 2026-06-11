import { create } from 'zustand'
import { invoke } from '../api'

export interface Toast {
  id: number
  message: string
}

export type RightPanelTab = 'chat' | 'headsup'

const RIGHT_PANEL_MIN_W = 260
const RIGHT_PANEL_MAX_W = 560
const RIGHT_PANEL_DEFAULT_W = 320

interface UiState {
  sidebarVisible: boolean
  searchPaletteOpen: boolean
  rightPanelVisible: boolean
  rightPanelTab: RightPanelTab
  rightPanelWidth: number
  /** Settings overlay (Cmd+,) — a modal in the main window, NOT a separate window (plan cut). */
  settingsOpen: boolean
  /** Note whose VersionHistoryModal is open (rendered by that note's NoteView). */
  historyNoteId: string | null
  /** Bumped by the export-note command; the mounted NoteView flushes, then exports. */
  exportRequest: number
  toasts: Toast[]
  toggleSidebar: () => void
  setSearchPaletteOpen: (open: boolean) => void
  toggleRightPanel: () => void
  /** Cmd+Shift+K: opens the panel on Heads Up; toggles closed if already there. */
  toggleHeadsUp: () => void
  setRightPanelTab: (tab: RightPanelTab) => void
  setRightPanelWidth: (width: number) => void
  setSettingsOpen: (open: boolean) => void
  openHistory: (noteId: string) => void
  closeHistory: () => void
  requestExport: () => void
  showToast: (message: string) => void
  dismissToast: (id: number) => void
}

let nextToastId = 1

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  searchPaletteOpen: false,
  rightPanelVisible: false,
  rightPanelTab: 'headsup',
  rightPanelWidth: RIGHT_PANEL_DEFAULT_W,
  settingsOpen: false,
  historyNoteId: null,
  exportRequest: 0,
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
  requestExport() {
    set((s) => ({ exportRequest: s.exportRequest + 1 }))
  },
  showToast(message) {
    const id = nextToastId++
    set((s) => ({ toasts: [...s.toasts, { id, message }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 3500)
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
}))

export function toast(message: string): void {
  useUiStore.getState().showToast(message)
}

// ── Right panel persistence: versioned blob in settings, restored on boot ─────
const RIGHT_PANEL_KEY = 'ui.rightPanel'
type RightPanelBlob = { v: 1; visible: boolean; tab: RightPanelTab; width: number }

function isValidBlob(blob: unknown): blob is RightPanelBlob {
  if (typeof blob !== 'object' || blob === null) return false
  const b = blob as Partial<RightPanelBlob>
  return (
    b.v === 1 &&
    typeof b.visible === 'boolean' &&
    (b.tab === 'chat' || b.tab === 'headsup') &&
    typeof b.width === 'number'
  )
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
          ? Math.max(RIGHT_PANEL_MIN_W, Math.min(RIGHT_PANEL_MAX_W, Math.round(blob.width)))
          : RIGHT_PANEL_DEFAULT_W
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
      s.rightPanelWidth !== prev.rightPanelWidth
    prev = s
    if (!changed) return
    if (uiPersistTimer) clearTimeout(uiPersistTimer)
    uiPersistTimer = setTimeout(() => {
      uiPersistTimer = null
      const cur = useUiStore.getState()
      const blob: RightPanelBlob = {
        v: 1,
        visible: cur.rightPanelVisible,
        tab: cur.rightPanelTab,
        width: cur.rightPanelWidth
      }
      void invoke('settings:set', { key: RIGHT_PANEL_KEY, value: blob })
    }, 500)
  })
}
