import { create } from 'zustand'
import type { NoteListItem } from '@shared/types'
import { invoke } from '../api'

/**
 * Cache of all live (non-trashed) notes, newest first. Invalidated by the
 * data:changed subscription set up once in App. Also feeds tab titles
 * (the '@' note-link menu queries search:typeahead in main instead).
 */
interface NotesState {
  items: NoteListItem[]
  loaded: boolean
  refresh: () => Promise<void>
}

export const useNotesStore = create<NotesState>((set) => ({
  items: [],
  loaded: false,
  async refresh() {
    const { items } = await invoke('notes:list', { scope: 'all', limit: 500 })
    set({ items, loaded: true })
  }
}))

export function noteTitle(noteId: string): string {
  const item = useNotesStore.getState().items.find((n) => n.id === noteId)
  return item ? item.title || 'Untitled' : 'Untitled'
}
