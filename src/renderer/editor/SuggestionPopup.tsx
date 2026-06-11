import { useEffect, useRef } from 'react'
import { useSuggestionUi } from './suggestionUi'

/** Shared dropdown for the '/', '@' and '#' suggestion menus. */
export function SuggestionPopup(): React.JSX.Element | null {
  const { active, items, selectedIndex, rect, pick } = useSuggestionUi()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.children[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex, items])

  if (!active || !rect || items.length === 0) return null

  return (
    <div
      ref={listRef}
      className="fixed z-50 max-h-64 w-64 overflow-y-auto rounded-lg border border-hairline bg-surface p-1 shadow-xl"
      style={{ left: rect.left, top: rect.bottom + 4 }}
    >
      {items.map((item, i) => (
        <button
          key={item.key}
          onMouseDown={(e) => {
            e.preventDefault()
            pick(i)
          }}
          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] ${
            i === selectedIndex ? 'bg-accent/15 text-ink' : 'text-ink hover:bg-hover'
          }`}
        >
          <span className="truncate">{item.label}</span>
          {item.hint && <span className="ml-2 shrink-0 text-[11px] text-ink-muted">{item.hint}</span>}
        </button>
      ))}
    </div>
  )
}
