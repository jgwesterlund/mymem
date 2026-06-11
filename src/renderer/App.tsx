import { useEffect, useState } from 'react'
import { invoke, on, pathForFile } from './api'
import { initTabsPersistence, useTabsStore } from './stores/tabs'
import { useNotesStore } from './stores/notes'
import { useCollectionsStore } from './stores/collections'
import { useUiStore, initUiPersistence } from './stores/ui'
import { initChatEvents } from './stores/chat'
import { initCommandRegistry } from './commands/registry'
import { TitlebarRegion } from './shell/TabStrip'
import { Sidebar } from './shell/Sidebar'
import { PaneArea } from './shell/PaneArea'
import { RightPanel } from './shell/RightPanel'
import { SearchPalette } from './shell/SearchPalette'
import { ImportProgressToast } from './shell/ImportProgressToast'
import { SettingsOverlay } from './settings/SettingsOverlay'


function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-center gap-3 rounded-lg border border-hairline bg-surface px-4 py-2 text-[13px] shadow-lg"
          onClick={() => useUiStore.getState().dismissToast(t.id)}
        >
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                t.action!.onClick()
                useUiStore.getState().dismissToast(t.id)
              }}
              className="font-medium text-accent hover:underline"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const sidebarVisible = useUiStore((s) => s.sidebarVisible)

  useEffect(() => {
    const offCommands = initCommandRegistry()
    initChatEvents() // chat:event stream must be captured even with the panel closed
    // The one data:changed subscription that keeps the renderer caches fresh.
    const offData = on('data:changed', (ev) => {
      if (ev.entity === 'note') {
        void useNotesStore.getState().refresh()
        void useCollectionsStore.getState().refresh() // membership counts
      } else {
        void useCollectionsStore.getState().refresh()
        if (ev.entity === 'collection' && ev.op === 'delete') {
          // Hard delete (sidebar, CLI or API): tabs showing it must not go stale.
          for (const id of ev.ids) useTabsStore.getState().purgeCollection(id)
        }
      }
    })
    const offTheme = on('theme:changed', ({ dark }) => {
      document.documentElement.classList.toggle('dark', dark)
    })
    // Drag-and-drop import: collect absolute paths via the preload bridge
    // (File.path does not exist in sandboxed renderers) and hand them to main.
    function onDragOver(e: DragEvent): void {
      e.preventDefault()
    }
    function onDrop(e: DragEvent): void {
      e.preventDefault()
      // No extension filter here: collectTargets (main) filters md/txt and
      // expands dropped FOLDERS into their files + a collection (review minor 3).
      const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => pathForFile(f))
      // Guard: an empty list must NOT invoke (empty filePaths means "open the dialog").
      if (paths.length > 0) void invoke('notes:import', { filePaths: paths })
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    void Promise.all([
      initTabsPersistence(),
      initUiPersistence(),
      useNotesStore.getState().refresh(),
      useCollectionsStore.getState().refresh()
    ])
      .then(() => setBooted(true))
      .catch((err: unknown) => {
        // A failed boot must show SOMETHING — never a permanently blank window.
        setBootError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      offCommands()
      offData()
      offTheme()
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (bootError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-ink-muted">myMem failed to start: {bootError}</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
        >
          Retry
        </button>
      </div>
    )
  }

  if (!booted) return <div className="h-full" />

  return (
    <div className="flex h-full flex-col">
      <TitlebarRegion />
      <div className="flex min-h-0 flex-1">
        {sidebarVisible && <Sidebar />}
        <PaneArea />
        <RightPanel />
      </div>
      <SearchPalette />
      <SettingsOverlay />
      <ImportProgressToast />
      <Toasts />
    </div>
  )
}
