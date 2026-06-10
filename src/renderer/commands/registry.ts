import type { CommandId } from '@shared/ipc'
import { invoke, on } from '../api'
import { useTabsStore } from '../stores/tabs'
import { useUiStore, toast } from '../stores/ui'

/**
 * Renderer side of the command table: native menu accelerators arrive as
 * menu:command pushes and dispatch into the stores. Commands whose feature
 * hasn't shipped yet toast instead of silently no-oping.
 */
/** Commands that act on "the note" target the active tab's note. */
function activeNoteId(): string | null {
  const s = useTabsStore.getState()
  const content = s.tabs[s.activeTabIndex]?.content
  return content?.kind === 'note' ? content.noteId : null
}

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
  'view-history': () => {
    const noteId = activeNoteId()
    if (noteId) useUiStore.getState().openHistory(noteId)
    else toast('Open a note to view its history')
  },
  'export-note': () => {
    const noteId = activeNoteId()
    if (!noteId) {
      toast('Open a note to export')
      return
    }
    // The mounted NoteView owns the save pipeline: it flushes dirty edits, THEN exports.
    useUiStore.getState().requestExport()
  },
  'import-files': () => {
    // Empty filePaths = "ask": main owns the open dialog (sandboxed renderer has no fs).
    void invoke('notes:import', { filePaths: [] })
  },
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
