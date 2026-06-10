import { create } from 'zustand'
import type { CollectionWithCount, Pin } from '@shared/types'
import { invoke } from '../api'

interface CollectionsState {
  items: CollectionWithCount[]
  pins: Pin[]
  refresh: () => Promise<void>
  create: (name: string) => Promise<CollectionWithCount>
}

export const useCollectionsStore = create<CollectionsState>((set) => ({
  items: [],
  pins: [],
  async refresh() {
    const [items, pins] = await Promise.all([invoke('collections:list'), invoke('pins:list')])
    set({ items, pins })
  },
  async create(name) {
    const c = await invoke('collections:create', { name })
    // data:changed will refresh too; update eagerly so the click feels instant.
    const withCount = { ...c, noteCount: 0 }
    set((s) => ({ items: [...s.items, withCount].sort((a, b) => a.name.localeCompare(b.name)) }))
    return withCount
  }
}))

export function collectionName(collectionId: string): string {
  const item = useCollectionsStore.getState().items.find((c) => c.id === collectionId)
  return item?.name ?? 'Collection'
}
