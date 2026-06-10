import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
}

interface UiState {
  sidebarVisible: boolean
  searchPaletteOpen: boolean
  /** Note whose VersionHistoryModal is open (rendered by that note's NoteView). */
  historyNoteId: string | null
  /** Bumped by the export-note command; the mounted NoteView flushes, then exports. */
  exportRequest: number
  toasts: Toast[]
  toggleSidebar: () => void
  setSearchPaletteOpen: (open: boolean) => void
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
  historyNoteId: null,
  exportRequest: 0,
  toasts: [],
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
  },
  setSearchPaletteOpen(open) {
    set({ searchPaletteOpen: open })
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
