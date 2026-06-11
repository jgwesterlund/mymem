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
  /** Note whose OrganizeModal (Cmd+O) is open (rendered by that note's NoteView). */
  organizeNoteId: string | null
  /** Bumped by the export-note command; the mounted NoteView flushes, then exports. */
  exportRequest: number
  /** Bumped by the clean-up command; the mounted NoteView flushes, then opens the overlay. */
  cleanupRequest: number
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
  openOrganize: (noteId: string) => void
  closeOrganize: () => void
  requestExport: () => void
  requestCleanup: () => void
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
  settingsOpen: false,
  historyNoteId: null,
  organizeNoteId: null,
  exportRequest: 0,
  cleanupRequest: 0,
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
