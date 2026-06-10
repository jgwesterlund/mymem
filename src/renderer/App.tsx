import { useEffect, useState } from 'react'
import { invoke } from './api'

/**
 * M0 walking skeleton: the final shell geometry (vibrant sidebar | opaque content | right panel)
 * with placeholder content. Real stores/views land in M1–M2.
 */
export default function App(): React.JSX.Element {
  const [ping, setPing] = useState<string>('…')

  useEffect(() => {
    invoke('app:ping')
      .then((r) => setPing(`v${r.version} · Electron ${r.electron} · Node ${r.node}`))
      .catch((err: unknown) => setPing(`IPC error: ${String(err)}`))
  }, [])

  return (
    <div className="flex h-full">
      {/* Sidebar — transparent: macOS vibrancy shows through */}
      <aside className="flex w-60 shrink-0 flex-col bg-transparent">
        <div className="titlebar-drag h-13 shrink-0" />
        <nav className="flex flex-col gap-0.5 px-3 text-[13px] text-ink-muted">
          <SidebarItem label="Home" active />
          <SidebarItem label="Collections" />
          <SidebarItem label="Pinned" />
        </nav>
        <div className="mt-auto px-4 py-3 text-[11px] text-ink-muted/70">{ping}</div>
      </aside>

      {/* Content — opaque for readability */}
      <main className="flex min-w-0 flex-1 flex-col rounded-tl-lg border-l border-t border-hairline bg-surface shadow-sm">
        <div className="titlebar-drag h-13 shrink-0 border-b border-hairline" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight">myMem</h1>
            <p className="mt-2 max-w-sm text-sm text-ink-muted">
              M0 walking skeleton. Editor, search and chat arrive in the next milestones.
              Press <kbd className="rounded border border-hairline px-1">⌃⌘Space</kbd> to try quick capture.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

function SidebarItem({ label, active }: { label: string; active?: boolean }): React.JSX.Element {
  return (
    <div
      className={`rounded-md px-2.5 py-1.5 ${active ? 'bg-black/10 font-medium text-ink dark:bg-white/10' : 'hover:bg-black/5'}`}
    >
      {label}
    </div>
  )
}
