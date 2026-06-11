import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke, on } from '../api'
import '../styles.css'

function QuickCapture(): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [autoOrganize, setAutoOrganize] = useState(false)

  useEffect(() => {
    ref.current?.focus()
    // The toggle persists across captures (settings key 'capture.autoOrganize').
    void invoke('settings:get', { key: 'capture.autoOrganize' }).then((v) => setAutoOrganize(v === true))
    return on('capture:focus', () => {
      setStatus('idle')
      if (ref.current) {
        ref.current.value = ''
        ref.current.focus()
      }
    })
  }, [])

  async function save(): Promise<void> {
    const text = ref.current?.value.trim()
    if (!text) {
      void invoke('capture:hide')
      return
    }
    setStatus('saving')
    // autoOrganize runs fire-and-forget in main — the panel never waits on AI.
    await invoke('capture:save', { text, autoOrganize })
    setStatus('saved')
    setTimeout(() => void invoke('capture:hide'), 250)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      void invoke('capture:hide')
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void save()
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-white/10 bg-transparent p-3">
      <textarea
        ref={ref}
        onKeyDown={onKeyDown}
        placeholder="Capture a thought… (Enter to save, Esc to dismiss)"
        className="flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-white placeholder-white/40 outline-none"
      />
      <div className="flex items-center justify-between pt-1 text-[11px] text-white/40">
        <label className="flex cursor-default items-center gap-1.5">
          <input
            type="checkbox"
            checked={autoOrganize}
            onChange={(e) => {
              setAutoOrganize(e.target.checked)
              void invoke('settings:set', { key: 'capture.autoOrganize', value: e.target.checked })
            }}
          />
          Auto-organize
        </label>
        <span>{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved ✓' : '↩ save · esc dismiss'}</span>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QuickCapture />
  </React.StrictMode>
)
