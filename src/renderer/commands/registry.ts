import type { CommandId } from '@shared/ipc'
import { invoke, on } from '../api'
import { useTabsStore } from '../stores/tabs'
import { useUiStore, toast } from '../stores/ui'

/**
 * Renderer side of the command table: native menu accelerators arrive as
 * menu:command pushes and dispatch into the stores. Commands whose feature
 * hasn't shipped yet toast instead of silently no-oping.
 */
const handlers: Partial<Record<CommandId, () => void>> = {
  'new-note': () => {
    void invoke('notes:create', {}).then((note) => {
      useTabsStore.getState().openInCurrentTab({ kind: 'note', noteId: note.id })
    })
  },
  'open-search': () =>
    useUiStore.getState().setSearchPaletteOpen(!useUiStore.getState().searchPaletteOpen),
  'toggle-sidebar': () => useUiStore.getState().toggleSidebar(),
  'close-tab': () => useTabsStore.getState().closeTab(),
  'next-tab': () => useTabsStore.getState().nextTab(),
  'prev-tab': () => useTabsStore.getState().prevTab(),
  'nav-back': () => useTabsStore.getState().navBack(),
  'nav-forward': () => useTabsStore.getState().navForward(),
  'view-history': () => toast('Version history arrives in M4'),
  organize: () => toast('Organize arrives in M8')
}

for (let n = 1; n <= 9; n++) {
  handlers[`activate-tab-${n}` as CommandId] = () => {
    // Cmd+9 = last tab (macOS convention).
    useTabsStore.getState().activateTab(n === 9 ? -1 : n - 1)
  }
}

export function dispatchCommand(commandId: CommandId): void {
  const handler = handlers[commandId]
  if (handler) handler()
  else toast('Not available yet')
}

/** Call once from App. Returns the unsubscribe function. */
export function initCommandRegistry(): () => void {
  return on('menu:command', ({ commandId }) => dispatchCommand(commandId))
}
