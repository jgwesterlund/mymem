import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke, on } from '../api'
import '../styles.css'

function QuickCapture(): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')

  useEffect(() => {
    ref.current?.focus()
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
    await invoke('capture:save', { text })
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
        <span>myMem quick capture</span>
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
