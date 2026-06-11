import { useEffect, useState } from 'react'
import type { Pin } from '@shared/types'
import { invoke, on } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { useNotesStore } from '../stores/notes'
import { openContent, useTabsStore, selectActiveContent, type PaneContent } from '../stores/tabs'
import { useUiStore } from '../stores/ui'
import { dispatchCommand } from '../commands/registry'

/** Small badge while the embedding backlog drains (index:progress phase 'embedding'). */
function IndexingBadge(): React.JSX.Element | null {
  const [remaining, setRemaining] = useState(0)
  useEffect(
    () =>
      on('index:progress', (p) => {
        if (p.phase !== 'embedding') return
        setRemaining(Math.max(0, p.total - p.done))
      }),
    []
  )
  if (remaining === 0) return null
  return (
    <div className="mx-2.5 mt-auto rounded-md bg-hover px-2 py-1 text-[11px] text-ink-muted">
      Embedding {remaining} chunk{remaining === 1 ? '' : 's'}…
    </div>
  )
}

/** Open target per the app-wide modifier contract: ⌘ = new tab, ⌥ = other pane. */
type OpenTarget = 'self' | 'tab' | 'pane'

function NavItem({
  label,
  onClick,
  active,
  testId,
  onDelete,
  deleteTitle
}: {
  label: string
  onClick: (target: OpenTarget) => void
  active?: boolean
  testId?: string
  onDelete?: () => void
  deleteTitle?: string
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="button"
      tabIndex={0}
      onClick={(e) => onClick(e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick(e.metaKey ? 'tab' : e.altKey ? 'pane' : 'self')
      }}
      className={`group flex w-full cursor-default items-center rounded-md px-2.5 py-1 text-left text-[13px] ${
        active ? 'bg-active font-medium' : 'hover:bg-hover'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onDelete && (
        <button
          title={deleteTitle ?? 'Delete'}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="hidden shrink-0 rounded px-1 text-[12px] leading-none text-ink-muted hover:text-red-600 group-hover:block dark:hover:text-red-400"
        >
          ✕
        </button>
      )}
    </div>
  )
}

/** Pinned notes/collections with HTML5 drag-reorder (pins:reorder, no new deps). */
function PinnedList({
  pins,
  navigate
}: {
  pins: Pin[]
  navigate: (content: PaneContent, target: OpenTarget) => void
}): React.JSX.Element | null {
  const collections = useCollectionsStore((s) => s.items)
  const notes = useNotesStore((s) => s.items)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  if (pins.length === 0) return null

  const label = (p: Pin): string =>
    p.itemType === 'note'
      ? notes.find((n) => n.id === p.itemId)?.title || 'Untitled'
      : collections.find((c) => c.id === p.itemId)?.name || 'Collection'

  function drop(): void {
    if (dragIndex === null || overIndex === null || dragIndex === overIndex) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    const next = [...pins]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(overIndex, 0, moved!)
    setDragIndex(null)
    setOverIndex(null)
    // Optimistic order; pins:reorder returns the canonical list via the store refresh.
    useCollectionsStore.setState({ pins: next })
    void invoke('pins:reorder', {
      orderedKeys: next.map((p) => ({ itemType: p.itemType, itemId: p.itemId }))
    }).then((canonical) => useCollectionsStore.setState({ pins: canonical }))
  }

  return (
    <div>
      <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Pinned</div>
      <nav className="flex flex-col gap-0.5">
        {pins.map((p, i) => (
          <div
            key={`${p.itemType}:${p.itemId}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              setDragIndex(i)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overIndex !== i) setOverIndex(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop()
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
            className={
              dragIndex !== null && overIndex === i && overIndex !== dragIndex
                ? overIndex < dragIndex
                  ? 'border-t-2 border-accent'
                  : 'border-b-2 border-accent'
                : ''
            }
          >
            <NavItem
              label={label(p)}
              onClick={(target) =>
                navigate(
                  p.itemType === 'note'
                    ? { kind: 'note', noteId: p.itemId }
                    : { kind: 'collection', collectionId: p.itemId },
                  target
                )
              }
            />
          </div>
        ))}
      </nav>
    </div>
  )
}

function startSidebarResize(e: React.MouseEvent): void {
  e.preventDefault()
  const onMove = (ev: MouseEvent): void => {
    useUiStore.getState().setSidebarWidth(ev.clientX)
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

export function Sidebar(): React.JSX.Element {
  const collections = useCollectionsStore((s) => s.items)
  const pins = useCollectionsStore((s) => s.pins)
  const activeContent = useTabsStore(selectActiveContent)
  const width = useUiStore((s) => s.sidebarWidth)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  function navigate(content: PaneContent, target: OpenTarget): void {
    openContent(content, target)
  }

  async function createCollection(): Promise<void> {
    const name = newName.trim()
    setCreating(false)
    setNewName('')
    if (!name) return
    const c = await useCollectionsStore.getState().create(name)
    navigate({ kind: 'collection', collectionId: c.id }, 'self')
  }

  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col gap-4 overflow-y-auto px-3 pb-4">
      <div
        onMouseDown={startSidebarResize}
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
      />
      <div className="flex flex-col gap-1.5">
        {/* Opens the Cmd+K search palette (same path as the menu accelerator). */}
        <button
          data-testid="open-search"
          onClick={() => dispatchCommand('open-search')}
          className="w-full rounded-md border border-hairline bg-hover px-2.5 py-1 text-left text-[12px] text-ink-muted"
        >
          Search…&nbsp;&nbsp;⌘K
        </button>
        <button
          data-testid="new-note"
          onClick={() => dispatchCommand('new-note')}
          className="w-full rounded-md bg-accent px-2.5 py-1 text-left text-[12px] font-medium text-white hover:opacity-90"
        >
          New note
        </button>
      </div>

      <nav className="flex flex-col gap-0.5">
        <NavItem
          label="Home"
          testId="nav-home"
          active={activeContent?.kind === 'home'}
          onClick={(target) => navigate({ kind: 'home' }, target)}
        />
        <NavItem
          label="Trash"
          active={activeContent?.kind === 'trash'}
          onClick={(target) => navigate({ kind: 'trash' }, target)}
        />
      </nav>

      <PinnedList pins={pins} navigate={navigate} />

      <div>
        <div className="flex items-center justify-between px-2.5 pb-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Collections</span>
          <button
            title="New collection"
            onClick={() => setCreating(true)}
            className="rounded px-1 text-[13px] leading-none text-ink-muted hover:bg-active"
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
              onClick={(target) => navigate({ kind: 'collection', collectionId: c.id }, target)}
              deleteTitle="Delete collection"
              onDelete={() => {
                if (
                  window.confirm(
                    `Delete the collection “${c.name}”? Notes in it are NOT deleted — they just leave the collection.`
                  )
                ) {
                  void invoke('collections:delete', { id: c.id })
                }
              }}
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

      <IndexingBadge />
    </aside>
  )
}
