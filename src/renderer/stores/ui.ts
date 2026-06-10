import { create } from 'zustand'

export interface Toast {
  id: number
  message: string
}

interface UiState {
  sidebarVisible: boolean
  toasts: Toast[]
  toggleSidebar: () => void
  showToast: (message: string) => void
  dismissToast: (id: number) => void
}

let nextToastId = 1

export const useUiStore = create<UiState>((set) => ({
  sidebarVisible: true,
  toasts: [],
  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }))
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
