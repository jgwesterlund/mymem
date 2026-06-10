import { create } from 'zustand'
import type { SuggestionProps } from '@tiptap/suggestion'

/**
 * One shared popup shell for all three Suggestion menus ('/', '@', '#').
 * The Suggestion plugins write into this store; <SuggestionPopup> renders it.
 * Only one menu can be open at a time, so a single store slot is enough.
 */
export interface PopupItem {
  key: string
  label: string
  hint?: string
}

interface SuggestionUiState {
  active: boolean
  items: PopupItem[]
  selectedIndex: number
  rect: { left: number; bottom: number } | null
  pick: (index: number) => void
  move: (delta: number) => void
  close: () => void
}

export const useSuggestionUi = create<SuggestionUiState>((set, get) => ({
  active: false,
  items: [],
  selectedIndex: 0,
  rect: null,
  pick: () => {},
  move(delta) {
    set((s) => {
      if (s.items.length === 0) return s
      const selectedIndex = (s.selectedIndex + delta + s.items.length) % s.items.length
      return { selectedIndex }
    })
  },
  close() {
    if (get().active) set({ active: false, items: [], rect: null, selectedIndex: 0, pick: () => {} })
  }
}))

/** Builds the render() handlers a Suggestion plugin needs, backed by the shared store. */
export function createSuggestionRenderer<I>(toItem: (item: I) => Omit<PopupItem, 'key'>) {
  return () => {
    const sync = (props: SuggestionProps<I, I>): void => {
      const rect = props.clientRect?.()
      useSuggestionUi.setState((s) => ({
        active: props.items.length > 0,
        items: props.items.map((item, i) => ({ key: String(i), ...toItem(item) })),
        selectedIndex: Math.min(s.active ? s.selectedIndex : 0, Math.max(0, props.items.length - 1)),
        rect: rect ? { left: rect.left, bottom: rect.bottom } : null,
        pick: (index: number) => {
          const picked = props.items[index]
          if (picked !== undefined) props.command(picked)
        }
      }))
    }
    return {
      onStart: sync,
      onUpdate: sync,
      onKeyDown({ event }: { event: KeyboardEvent }): boolean {
        const ui = useSuggestionUi.getState()
        if (!ui.active) return false
        if (event.key === 'ArrowDown') {
          ui.move(1)
          return true
        }
        if (event.key === 'ArrowUp') {
          ui.move(-1)
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          ui.pick(useSuggestionUi.getState().selectedIndex)
          return true
        }
        if (event.key === 'Escape') {
          ui.close()
          return true
        }
        return false
      },
      onExit() {
        useSuggestionUi.getState().close()
      }
    }
  }
}
