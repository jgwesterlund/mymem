import { useCallback, useEffect, useState } from 'react'
import type { NoteListItem } from '@shared/types'
import { invoke, on } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { toast } from '../stores/ui'
import { NoteList } from './NoteList'

export default function CollectionView({
  collectionId,
  focused = true
}: {
  collectionId: string
  focused?: boolean
}): React.JSX.Element {
  const [items, setItems] = useState<NoteListItem[]>([])
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const collection = useCollectionsStore((s) => s.items.find((c) => c.id === collectionId))

  const refresh = useCallback(async (): Promise<void> => {
    const res = await invoke('notes:list', { scope: 'collection', collectionId })
    setItems(res.items)
  }, [collectionId])

  useEffect(() => {
    void refresh()
    return on('data:changed', () => void refresh())
  }, [refresh])

  async function commitRename(): Promise<void> {
    const next = name.trim()
    setRenaming(false)
    if (!next || !collection || next === collection.name) return
    try {
      await invoke('collections:update', { id: collectionId, patch: { name: next } })
    } catch {
      toast('Rename failed — is the name already taken?')
    }
  }

  function deleteCollection(): void {
    if (!collection) return
    if (
      window.confirm(
        `Delete the collection “${collection.name}”? Notes in it are NOT deleted — they just leave the collection.`
      )
    ) {
      // Tabs showing this collection are cleaned up by App's data:changed handler.
      void invoke('collections:delete', { id: collectionId })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="group mb-1 flex items-center gap-2 px-1">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={() => void commitRename()}
            className="bg-transparent text-xl font-semibold tracking-tight outline-none"
          />
        ) : (
          <h1 className="text-xl font-semibold tracking-tight">{collection?.name ?? 'Collection'}</h1>
        )}
        {!renaming && collection && (
          <span className="hidden items-center gap-1 text-[12px] text-ink-muted group-hover:flex">
            <button
              onClick={() => {
                setName(collection.name)
                setRenaming(true)
              }}
              className="rounded px-1.5 py-0.5 hover:bg-hover"
            >
              Rename
            </button>
            <button
              onClick={deleteCollection}
              className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-red-600 dark:hover:text-red-400"
            >
              Delete
            </button>
          </span>
        )}
      </div>
      <p className="mb-4 px-1 text-[12px] text-ink-muted">
        {items.length} {items.length === 1 ? 'note' : 'notes'}
      </p>
      <NoteList items={items} focused={focused} empty="No notes in this collection yet — tag one with '#' in the editor." />
    </div>
  )
}
