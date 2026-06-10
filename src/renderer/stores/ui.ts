import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
}

interface UiState {
  sidebarVisible: boolean
  searchPaletteOpen: boolean
  toasts: Toast[]
  toggleSidebar: () => void
  setSearchPaletteOpen: (open: boolean) => void
  showToast: (message: string) => void
  dismissToast: (id: number) => void
}

let nextToastId = 1

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  searchPaletteOpen: false,
  toasts: [],
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
  },
  setSearchPaletteOpen(open) {
    set({ searchPaletteOpen: open })
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
