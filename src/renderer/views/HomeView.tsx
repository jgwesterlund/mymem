import { useNotesStore } from '../stores/notes'
import { NoteList } from './NoteList'

export default function HomeView(): React.JSX.Element {
  const items = useNotesStore((s) => s.items)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <h1 className="mb-4 px-1 text-xl font-semibold tracking-tight">Home</h1>
      <NoteList items={items} empty="No notes yet — press ⌘N, or ⌃⌘Space from anywhere." />
    </div>
  )
}
