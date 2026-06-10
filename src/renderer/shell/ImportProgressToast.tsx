import { useEffect, useRef, useState } from 'react'
import { on } from '../api'

/** Batch-import progress (import:progress pushes) — lingers briefly when done. */
export function ImportProgressToast(): React.JSX.Element | null {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const off = on('import:progress', (p) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      setProgress(p)
      if (p.done >= p.total) {
        hideTimer.current = setTimeout(() => setProgress(null), 2000)
      }
    })
    return () => {
      off()
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  if (!progress) return null
  const finished = progress.done >= progress.total
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 rounded-lg border border-hairline bg-surface px-4 py-2 text-[13px] shadow-lg">
      {finished
        ? `Import finished — ${progress.total} file${progress.total === 1 ? '' : 's'} processed`
        : `Importing ${progress.done} of ${progress.total}…`}
    </div>
  )
}
