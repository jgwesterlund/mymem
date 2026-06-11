import { useNotesStore } from '../stores/notes'
import { useCollectionsStore } from '../stores/collections'
import { useTabsStore, type PaneContent } from '../stores/tabs'

function truncateMiddle(s: string, max = 24): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

export function TabStrip(): React.JSX.Element {
  const tabs = useTabsStore((s) => s.tabs)
  const activeTabIndex = useTabsStore((s) => s.activeTabIndex)
  const notes = useNotesStore((s) => s.items)
  const collections = useCollectionsStore((s) => s.items)

  function titleOf(content: PaneContent): string {
    switch (content.kind) {
      case 'home':
        return 'Home'
      case 'trash':
        return 'Trash'
      case 'search':
        return content.query ? `Search: ${content.query}` : 'Search'
      case 'collection':
        return collections.find((c) => c.id === content.collectionId)?.name ?? 'Collection'
      case 'note': {
        const n = notes.find((x) => x.id === content.noteId)
        return n?.title || 'Untitled'
      }
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {tabs.map((tab, i) => {
        const active = i === activeTabIndex
        const activePane = tab.panes[tab.activePane] ?? tab.panes[0]!
        return (
          <div
            key={tab.id}
            onClick={() => useTabsStore.getState().activateTab(i)}
            onAuxClick={(e) => {
              if (e.button === 1) useTabsStore.getState().closeTab(tab.id)
            }}
            className={`group flex min-w-0 max-w-44 cursor-default items-center gap-1.5 rounded-full px-3 py-1 text-[12px] ${
              active ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-muted hover:bg-hover'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span className="truncate">
              {tab.panes.length > 1 ? '◫ ' : ''}
              {truncateMiddle(titleOf(activePane.content))}
            </span>
            <button
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                useTabsStore.getState().closeTab(tab.id)
              }}
              className={`shrink-0 rounded-full px-1 text-[11px] leading-none text-ink-muted hover:bg-active hover:text-ink ${
                active ? '' : 'invisible group-hover:visible'
              }`}
            >
              ✕
            </button>
          </div>
        )
      })}
      <button
        title="New tab"
        onClick={() => useTabsStore.getState().openTab({ kind: 'home' })}
        className="shrink-0 rounded-full px-2 py-1 text-[13px] leading-none text-ink-muted hover:bg-hover"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        +
      </button>
    </div>
  )
}

export function TitlebarRegion(): React.JSX.Element {
  return (
    <div className="titlebar-drag flex h-13 shrink-0 items-center pl-20 pr-4">
      <TabStrip />
      <span className="shrink-0 select-none text-[12px] font-semibold tracking-tight text-ink-muted/50">
        myMem
      </span>
    </div>
  )
}
