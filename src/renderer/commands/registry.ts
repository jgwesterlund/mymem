import type { CommandId } from '@shared/ipc'
import { invoke, on } from '../api'
import { useTabsStore, getActiveContent } from '../stores/tabs'
import { useChatStore } from '../stores/chat'
import { useCollectionsStore } from '../stores/collections'
import { useUiStore, toast } from '../stores/ui'

/**
 * Renderer side of the command table: native menu accelerators arrive as
 * menu:command pushes and dispatch into the stores. Commands whose feature
 * hasn't shipped yet toast instead of silently no-oping.
 */
/** Commands that act on "the note" target the ACTIVE PANE's note. */
function activeNoteId(): string | null {
  const content = getActiveContent()
  return content?.kind === 'note' ? content.noteId : null
}

/** Exported for the keymap regression test: every CommandId must resolve here. */
export const commandHandlers: Partial<Record<CommandId, () => void>> = {
  'new-note': () => {
    void invoke('notes:create', {}).then((note) => {
      useTabsStore.getState().openInCurrentTab({ kind: 'note', noteId: note.id })
    })
  },
  'new-chat': () => {
    // Cmd+J: open the right panel on the Chat tab with a fresh conversation.
    useUiStore.setState({ rightPanelVisible: true, rightPanelTab: 'chat' })
    useChatStore.getState().newChat()
  },
  'open-settings': () => useUiStore.getState().setSettingsOpen(true),
  'open-search': () =>
    useUiStore.getState().setSearchPaletteOpen(!useUiStore.getState().searchPaletteOpen),
  'toggle-sidebar': () => useUiStore.getState().toggleSidebar(),
  'toggle-right-panel': () => useUiStore.getState().toggleRightPanel(),
  'toggle-heads-up': () => useUiStore.getState().toggleHeadsUp(),
  'close-tab': () => useTabsStore.getState().closeTab(),
  'next-tab': () => useTabsStore.getState().nextTab(),
  'prev-tab': () => useTabsStore.getState().prevTab(),
  'nav-back': () => useTabsStore.getState().navBack(),
  'nav-forward': () => useTabsStore.getState().navForward(),
  // Cmd+. — toggle split on the active tab.
  'split-pane': () => useTabsStore.getState().splitPane(),
  // Cmd+Shift+P — pin/unpin whatever the active pane shows (note or collection).
  'toggle-pin': () => {
    const content = getActiveContent()
    const target =
      content?.kind === 'note'
        ? { itemType: 'note' as const, itemId: content.noteId }
        : content?.kind === 'collection'
          ? { itemType: 'collection' as const, itemId: content.collectionId }
          : null
    if (!target) {
      toast('Open a note or collection to pin')
      return
    }
    const pinned = useCollectionsStore
      .getState()
      .pins.some((p) => p.itemType === target.itemType && p.itemId === target.itemId)
    void invoke('pins:set', { ...target, pinned: !pinned }).then(() =>
      toast(pinned ? 'Unpinned' : 'Pinned to sidebar')
    )
  },
  // Cmd+F — the focused NoteView opens its FindBar.
  'find-in-note': () => {
    if (activeNoteId()) useUiStore.getState().requestFind()
    else toast('Open a note to find in it')
  },
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
  // Cmd+O — MANUAL collection picker (the modal lives in the active NoteView).
  organize: () => {
    const noteId = activeNoteId()
    if (noteId) useUiStore.getState().openOrganize(noteId)
    else toast('Open a note to organize')
  },
  // Cmd+Shift+O — AI files the note; result toast carries Undo (shared ai:undo registry).
  'auto-organize': () => {
    const noteId = activeNoteId()
    if (!noteId) {
      toast('Open a note to auto-organize')
      return
    }
    void invoke('ai:autoOrganize', { noteId })
      .then((res) => {
        const all = [...res.applied, ...res.created]
        if (all.length === 0) {
          toast('No confident matches')
          return
        }
        const names = all.map((c) => c.name).join(', ')
        useUiStore.getState().showToast(`Filed into ${names}`, {
          label: 'Undo',
          onClick: () => {
            void invoke('ai:undo', { undoToken: res.undoToken })
              .then(() => toast('Filing undone'))
              .catch((err: unknown) => toast(err instanceof Error ? err.message : 'Undo failed'))
          }
        })
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : 'Auto-organize failed'))
  },
  // Cmd+Shift+U — the mounted NoteView flushes its editor, THEN opens the overlay.
  'clean-up': () => {
    const noteId = activeNoteId()
    if (noteId) useUiStore.getState().requestCleanup()
    else toast('Open a note to clean up')
  }
}

for (let n = 1; n <= 9; n++) {
  commandHandlers[`activate-tab-${n}` as CommandId] = () => {
    // Cmd+9 = last tab (macOS convention).
    useTabsStore.getState().activateTab(n === 9 ? -1 : n - 1)
  }
}

export function dispatchCommand(commandId: CommandId): void {
  const handler = commandHandlers[commandId]
  if (handler) handler()
  else toast('Not available yet')
}

/** Call once from App. Returns the unsubscribe function. */
export function initCommandRegistry(): () => void {
  return on('menu:command', ({ commandId }) => dispatchCommand(commandId))
}
