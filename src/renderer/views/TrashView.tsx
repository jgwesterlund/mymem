import { useCallback, useEffect, useState } from 'react'
import type { NoteListItem } from '@shared/types'
import { invoke, on } from '../api'

export default function TrashView(): React.JSX.Element {
  const [items, setItems] = useState<NoteListItem[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const res = await invoke('notes:list', { scope: 'trash' })
    setItems(res.items)
  }, [])

  useEffect(() => {
    void refresh()
    return on('data:changed', () => void refresh())
  }, [refresh])

  async function emptyTrash(): Promise<void> {
    if (!window.confirm(`Delete ${items.length} ${items.length === 1 ? 'note' : 'notes'} forever? This cannot be undone.`)) return
    await invoke('notes:emptyTrash')
  }

  async function deleteForever(id: string): Promise<void> {
    if (!window.confirm('Delete this note forever? This cannot be undone.')) return
    await invoke('notes:deleteForever', { id })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <div className="mb-4 flex items-center justify-between px-1">
        <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
        {items.length > 0 && (
          <button
            onClick={() => void emptyTrash()}
            className="rounded-md px-2.5 py-1 text-[12px] font-medium text-red-600 hover:bg-red-600/10 dark:text-red-400"
          >
            Empty Trash
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="px-1 py-6 text-[13px] text-ink-muted">Trash is empty.</p>
      ) : (
        <div className="flex flex-col">
          {items.map((n) => (
            <div key={n.id} className="group rounded-lg px-3 py-2 hover:bg-hover">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-[14px] font-medium">{n.title || 'Untitled'}</span>
                <span className="shrink-0 text-[11px] text-ink-muted">
                  {n.trashedAt ? new Date(n.trashedAt).toLocaleDateString() : ''}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-[12px] text-ink-muted">{n.excerpt || 'Empty note'}</span>
                <span className="hidden shrink-0 gap-2 group-hover:flex">
                  <button
                    onClick={() => void invoke('notes:restore', { id: n.id })}
                    className="text-[11px] text-accent hover:underline"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => void deleteForever(n.id)}
                    className="text-[11px] text-red-600 hover:underline dark:text-red-400"
                  >
                    Delete forever
                  </button>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
