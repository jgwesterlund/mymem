import { useTabsStore, type PaneContent } from '../stores/tabs'
import HomeView from '../views/HomeView'
import NoteView from '../views/NoteView'
import CollectionView from '../views/CollectionView'
import TrashView from '../views/TrashView'
import SearchResultsView from '../views/SearchResultsView'

function ViewSwitch({ content, tabId }: { content: PaneContent; tabId: string }): React.JSX.Element {
  switch (content.kind) {
    case 'home':
      return <HomeView />
    case 'note':
      // Keyed per tab+note: switching notes inside a tab remounts the editor.
      return <NoteView key={`${tabId}:${content.noteId}`} noteId={content.noteId} />
    case 'collection':
      return <CollectionView collectionId={content.collectionId} />
    case 'trash':
      return <TrashView />
    case 'search':
      // Keyed per tab+query: a new palette search in the same tab resets the view.
      return <SearchResultsView key={`${tabId}:${content.query}`} query={content.query} />
  }
}

/** Single pane per tab in M2 — the M9 split adds a second ViewSwitch + divider here. */
export function PaneArea(): React.JSX.Element {
  const tab = useTabsStore((s) => s.tabs[s.activeTabIndex])

  return (
    <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm">
      {tab ? <ViewSwitch content={tab.content} tabId={tab.id} /> : null}
    </main>
  )
}
