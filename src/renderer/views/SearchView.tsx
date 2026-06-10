export default function SearchView({ query }: { query: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <h1 className="mb-4 px-1 text-xl font-semibold tracking-tight">Search</h1>
      <input
        defaultValue={query}
        placeholder="Search notes…"
        className="mb-6 w-full max-w-md rounded-lg border border-hairline bg-surface-dim px-3 py-1.5 text-[13px] outline-none"
        disabled
      />
      <p className="px-1 text-[13px] text-ink-muted">Full-text search arrives in M3.</p>
    </div>
  )
}
