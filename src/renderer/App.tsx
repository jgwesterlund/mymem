import { useEffect, useState } from 'react'
import { on } from './api'
import { initTabsPersistence } from './stores/tabs'
import { useNotesStore } from './stores/notes'
import { useCollectionsStore } from './stores/collections'
import { useUiStore } from './stores/ui'
import { initCommandRegistry } from './commands/registry'
import { TitlebarRegion } from './shell/TabStrip'
import { Sidebar } from './shell/Sidebar'
import { PaneArea } from './shell/PaneArea'
import { SearchPalette } from './shell/SearchPalette'

function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto rounded-lg border border-hairline bg-surface px-4 py-2 text-[13px] shadow-lg"
          onClick={() => useUiStore.getState().dismissToast(t.id)}
        >
          {t.message}
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
    // The one data:changed subscription that keeps the renderer caches fresh.
    const offData = on('data:changed', (ev) => {
      if (ev.entity === 'note') {
        void useNotesStore.getState().refresh()
        void useCollectionsStore.getState().refresh() // membership counts
      } else {
        void useCollectionsStore.getState().refresh()
      }
    })
    const offTheme = on('theme:changed', ({ dark }) => {
      document.documentElement.classList.toggle('dark', dark)
    })
    void Promise.all([
      initTabsPersistence(),
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
    }
  }, [])

  if (bootError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-ink-muted">myMem failed to start: {bootError}</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-black/5"
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
      </div>
      <SearchPalette />
      <Toasts />
    </div>
  )
}
