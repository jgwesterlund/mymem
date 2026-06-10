import { useUiStore, type RightPanelTab } from '../stores/ui'
import { HeadsUpPanel } from './HeadsUpPanel'

/**
 * Resizable right panel (Cmd+\): 'Chat' (M7 placeholder) and 'Heads Up' (the M5
 * tab, Cmd+Shift+K). Width/visibility/tab persist via the ui store settings blob.
 */
function TabButton({ tab, label }: { tab: RightPanelTab; label: string }): React.JSX.Element {
  const active = useUiStore((s) => s.rightPanelTab === tab)
  return (
    <button
      onClick={() => useUiStore.getState().setRightPanelTab(tab)}
      className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${
        active ? 'bg-black/10' : 'text-ink-muted hover:bg-black/5'
      }`}
    >
      {label}
    </button>
  )
}

function ChatPlaceholder(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="rounded-lg border border-hairline bg-surface-dim px-4 py-3">
        <p className="text-[13px] font-medium">Chat arrives in M7</p>
        <p className="mt-1 text-[12px] text-ink-muted">
          Connect an AI provider in Settings to chat with your notes once it lands.
        </p>
      </div>
    </div>
  )
}

function startResize(e: React.MouseEvent): void {
  e.preventDefault()
  const onMove = (ev: MouseEvent): void => {
    useUiStore.getState().setRightPanelWidth(window.innerWidth - ev.clientX)
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

export function RightPanel(): React.JSX.Element | null {
  const visible = useUiStore((s) => s.rightPanelVisible)
  const tab = useUiStore((s) => s.rightPanelTab)
  const width = useUiStore((s) => s.rightPanelWidth)
  if (!visible) return null

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-t border-hairline bg-surface"
    >
      <div
        onMouseDown={startResize}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
      />
      <div className="flex shrink-0 gap-1 border-b border-hairline px-2 py-1.5">
        <TabButton tab="chat" label="Chat" />
        <TabButton tab="headsup" label="Heads Up" />
      </div>
      {tab === 'chat' ? <ChatPlaceholder /> : <HeadsUpPanel />}
    </aside>
  )
}
