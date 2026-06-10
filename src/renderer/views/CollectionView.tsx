import { useCallback, useEffect, useState } from 'react'
import type { NoteListItem } from '@shared/types'
import { invoke, on } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { NoteList } from './NoteList'

export default function CollectionView({ collectionId }: { collectionId: string }): React.JSX.Element {
  const [items, setItems] = useState<NoteListItem[]>([])
  const collection = useCollectionsStore((s) => s.items.find((c) => c.id === collectionId))

  const refresh = useCallback(async (): Promise<void> => {
    const res = await invoke('notes:list', { scope: 'collection', collectionId })
    setItems(res.items)
  }, [collectionId])

  useEffect(() => {
    void refresh()
    return on('data:changed', () => void refresh())
  }, [refresh])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <h1 className="mb-1 px-1 text-xl font-semibold tracking-tight">{collection?.name ?? 'Collection'}</h1>
      <p className="mb-4 px-1 text-[12px] text-ink-muted">
        {items.length} {items.length === 1 ? 'note' : 'notes'}
      </p>
      <NoteList items={items} empty="No notes in this collection yet — tag one with '#' in the editor." />
    </div>
  )
}
