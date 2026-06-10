import { useState } from 'react'
import { useCollectionsStore } from '../stores/collections'
import { useNotesStore } from '../stores/notes'
import { useTabsStore, type PaneContent } from '../stores/tabs'
import { dispatchCommand } from '../commands/registry'

function NavItem({
  label,
  onClick,
  active
}: {
  label: string
  onClick: (metaKey: boolean) => void
  active?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={(e) => onClick(e.metaKey)}
      className={`w-full truncate rounded-md px-2.5 py-1 text-left text-[13px] ${
        active ? 'bg-black/10 font-medium' : 'hover:bg-black/5'
      }`}
    >
      {label}
    </button>
  )
}

export function Sidebar(): React.JSX.Element {
  const collections = useCollectionsStore((s) => s.items)
  const pins = useCollectionsStore((s) => s.pins)
  const notes = useNotesStore((s) => s.items)
  const activeContent = useTabsStore((s) => s.tabs[s.activeTabIndex]?.content)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  function navigate(content: PaneContent, metaKey: boolean): void {
    const tabs = useTabsStore.getState()
    if (metaKey) tabs.openTab(content)
    else tabs.openInCurrentTab(content)
  }

  async function createCollection(): Promise<void> {
    const name = newName.trim()
    setCreating(false)
    setNewName('')
    if (!name) return
    const c = await useCollectionsStore.getState().create(name)
    navigate({ kind: 'collection', collectionId: c.id }, false)
  }

  const pinLabel = (itemType: 'note' | 'collection', itemId: string): string =>
    itemType === 'note'
      ? notes.find((n) => n.id === itemId)?.title || 'Untitled'
      : collections.find((c) => c.id === itemId)?.name || 'Collection'

  return (
    <aside className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto px-3 pb-4">
      <div className="flex flex-col gap-1.5">
        {/* Stub: focuses real search palette from M3; for now it opens the search tab. */}
        <button
          onClick={() => dispatchCommand('open-search')}
          className="w-full rounded-md border border-hairline bg-black/5 px-2.5 py-1 text-left text-[12px] text-ink-muted"
        >
          Search…&nbsp;&nbsp;⌘K
        </button>
        <button
          onClick={() => dispatchCommand('new-note')}
          className="w-full rounded-md bg-accent px-2.5 py-1 text-left text-[12px] font-medium text-white hover:opacity-90"
        >
          New note
        </button>
      </div>

      <nav className="flex flex-col gap-0.5">
        <NavItem
          label="Home"
          active={activeContent?.kind === 'home'}
          onClick={(meta) => navigate({ kind: 'home' }, meta)}
        />
        <NavItem
          label="Trash"
          active={activeContent?.kind === 'trash'}
          onClick={(meta) => navigate({ kind: 'trash' }, meta)}
        />
      </nav>

      {pins.length > 0 && (
        <div>
          <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Pinned</div>
          <nav className="flex flex-col gap-0.5">
            {pins.map((p) => (
              <NavItem
                key={`${p.itemType}:${p.itemId}`}
                label={pinLabel(p.itemType, p.itemId)}
                onClick={(meta) =>
                  navigate(
                    p.itemType === 'note'
                      ? { kind: 'note', noteId: p.itemId }
                      : { kind: 'collection', collectionId: p.itemId },
                    meta
                  )
                }
              />
            ))}
          </nav>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Collections</span>
          <button
            title="New collection"
            onClick={() => setCreating(true)}
            className="rounded px-1 text-[13px] leading-none text-ink-muted hover:bg-black/10"
          >
            +
          </button>
        </div>
        <nav className="flex flex-col gap-0.5">
          {collections.map((c) => (
            <NavItem
              key={c.id}
              label={`${c.name} (${c.noteCount})`}
              active={activeContent?.kind === 'collection' && activeContent.collectionId === c.id}
              onClick={(meta) => navigate({ kind: 'collection', collectionId: c.id }, meta)}
            />
          ))}
          {creating && (
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createCollection()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
              onBlur={() => void createCollection()}
              placeholder="Collection name"
              className="mx-1 rounded-md border border-hairline bg-surface px-2 py-1 text-[12px] outline-none"
            />
          )}
          {collections.length === 0 && !creating && (
            <p className="px-2.5 py-1 text-[12px] text-ink-muted">No collections yet.</p>
          )}
        </nav>
      </div>
    </aside>
  )
}
