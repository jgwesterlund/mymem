import { useTabsStore, type PaneContent } from '../stores/tabs'
import { useUiStore } from '../stores/ui'
import HomeView from '../views/HomeView'
import NoteView from '../views/NoteView'
import CollectionView from '../views/CollectionView'
import TrashView from '../views/TrashView'
import SearchResultsView from '../views/SearchResultsView'

function ViewSwitch({
  content,
  paneKey,
  focused
}: {
  content: PaneContent
  paneKey: string
  focused: boolean
}): React.JSX.Element {
  switch (content.kind) {
    case 'home':
      return <HomeView focused={focused} />
    case 'note':
      // Keyed per tab+pane+note: switching notes inside a pane remounts the editor.
      return <NoteView key={`${paneKey}:${content.noteId}`} noteId={content.noteId} focused={focused} />
    case 'collection':
      return <CollectionView collectionId={content.collectionId} focused={focused} />
    case 'trash':
      return <TrashView />
    case 'search':
      // Keyed per pane+query: a new palette search in the same pane resets the view.
      return <SearchResultsView key={`${paneKey}:${content.query}`} query={content.query} />
  }
}

function startDividerDrag(e: React.MouseEvent, container: HTMLElement | null): void {
  e.preventDefault()
  if (!container) return
  const rect = container.getBoundingClientRect()
  const onMove = (ev: MouseEvent): void => {
    useUiStore.getState().setSplitRatio((ev.clientX - rect.left) / Math.max(1, rect.width))
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/**
 * Renders the ACTIVE tab only (hidden tabs never mount, keeping the live-editor
 * budget at ≤3: two panes + quick capture). M9: 1–2 panes with a draggable
 * divider; the active pane carries the focus ring and receives note-scoped
 * commands (export/cleanup/find/history).
 */
export function PaneArea(): React.JSX.Element {
  const tab = useTabsStore((s) => s.tabs[s.activeTabIndex])
  const splitRatio = useUiStore((s) => s.splitRatio)

  if (!tab) {
    return <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm" />
  }

  const split = tab.panes.length > 1

  if (!split) {
    const pane = tab.panes[0]!
    return (
      <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm">
        <ViewSwitch content={pane.content} paneKey={`${tab.id}:0`} focused />
      </main>
    )
  }

  let containerEl: HTMLElement | null = null
  return (
    <main
      ref={(el) => {
        containerEl = el
      }}
      data-testid="pane-area"
      className="flex min-w-0 flex-1 flex-row rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm"
    >
      {tab.panes.map((pane, i) => {
        const focused = tab.activePane === i
        return (
          <div key={`${tab.id}:${i}`} className="contents">
            {i > 0 && (
              <div
                onMouseDown={(e) => startDividerDrag(e, containerEl)}
                className="z-10 w-1 shrink-0 cursor-col-resize bg-hairline hover:bg-accent/40"
              />
            )}
            <section
              data-testid={`pane-${i}`}
              // Capture phase: clicking ANYTHING inside the pane focuses it before
              // the click's own handler runs (so toolbar actions hit the right pane).
              onMouseDownCapture={() => useTabsStore.getState().setActivePane(i)}
              style={{ width: `${(i === 0 ? splitRatio : 1 - splitRatio) * 100}%` }}
              className={`flex min-h-0 min-w-0 flex-col ${
                focused ? 'ring-1 ring-inset ring-accent/35' : ''
              }`}
            >
              <ViewSwitch content={pane.content} paneKey={`${tab.id}:${i}`} focused={focused} />
            </section>
          </div>
        )
      })}
    </main>
  )
}
