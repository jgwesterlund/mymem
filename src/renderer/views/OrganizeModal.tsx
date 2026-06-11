import { useEffect, useState } from 'react'
import { invoke } from '../api'
import { useCollectionsStore } from '../stores/collections'
import { toast } from '../stores/ui'

/**
 * Organize modal (Cmd+O): MANUAL collection picker for the active note — a
 * checklist of existing collections plus a create-new input, saved via
 * collections:setForNote. No AI here (that's Auto-Organize, Cmd+Shift+O).
 */
export default function OrganizeModal({
  noteId,
  onClose
}: {
  noteId: string
  onClose: () => void
}): React.JSX.Element {
  const collections = useCollectionsStore((s) => s.items)
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void invoke('notes:get', { id: noteId })
      .then((n) => setSelected(new Set(n.collectionIds)))
      .catch(() => onClose())
  }, [noteId, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      if (!prev) return prev
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (!selected || saving) return
    setSaving(true)
    try {
      const ids = [...selected]
      const name = newName.trim()
      if (name) {
        // Reuse an existing collection on a (case-insensitive) name match.
        const existing = collections.find((c) => c.name.toLowerCase() === name.toLowerCase())
        const id = existing ? existing.id : (await invoke('collections:create', { name })).id
        if (!ids.includes(id)) ids.push(id)
      }
      await invoke('collections:setForNote', { noteId, collectionIds: ids })
      toast('Collections updated')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update collections')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/20" onMouseDown={onClose}>
      <div
        className="mx-auto mt-[16vh] flex max-h-[60vh] w-96 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-hairline px-4 py-2.5 text-[12px] font-semibold">Organize</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {collections.length === 0 && (
            <p className="px-2 py-4 text-center text-[12px] text-ink-muted">
              No collections yet — create one below.
            </p>
          )}
          {collections.map((c) => (
            <label
              key={c.id}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={selected?.has(c.id) ?? false}
                disabled={selected === null}
                onChange={() => toggle(c.id)}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
              <span className="shrink-0 text-[11px] text-ink-muted">{c.noteCount}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void save()
              }
            }}
            placeholder="New collection…"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-dim px-2 py-1 text-[12px] outline-none focus:border-accent/50"
            style={{ userSelect: 'text' }}
          />
          <button
            onClick={onClose}
            className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-medium hover:bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={selected === null || saving}
            className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
