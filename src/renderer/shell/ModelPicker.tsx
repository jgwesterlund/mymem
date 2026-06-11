import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelChoice } from '@shared/types'

/**
 * Searchable model picker (v1.2): replaces the native <select> for model
 * choices — OpenRouter alone adds ~256 models, which makes a flat dropdown
 * unusable. Models are grouped under provider section headers; a filter input
 * appears above the list once there are more than 15 models (case-insensitive
 * substring match on the full 'Provider · model-id' label). ArrowDown/Up +
 * Enter navigate the FILTERED list; Escape closes.
 */
const FILTER_THRESHOLD = 15

type ModelRef = { providerId: string; modelId: string }

export function ModelPicker({
  choices,
  value,
  noneLabel,
  selectableNone = false,
  direction = 'down',
  triggerClassName,
  onChange
}: {
  choices: ModelChoice[]
  value: ModelRef | null
  /** Trigger text when nothing is selected — and, with selectableNone, a pickable clear row. */
  noneLabel: string
  selectableNone?: boolean
  direction?: 'up' | 'down'
  triggerClassName: string
  onChange: (model: ModelRef | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // Index into the keyboard-navigable flat list: [noneLabel row?, ...filtered].
  // Section headers are not entries, so arrows skip them for free.
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const showFilter = choices.length > FILTER_THRESHOLD
  const needle = q.trim().toLowerCase()
  const filtered = useMemo(
    () => (needle ? choices.filter((c) => c.label.toLowerCase().includes(needle)) : choices),
    [choices, needle]
  )
  // The clear row only makes sense unfiltered — it can never match a model query.
  const noneRow = selectableNone && needle === ''
  const navOffset = noneRow ? 1 : 0
  const navLength = filtered.length + navOffset

  const groups = useMemo(() => {
    const out: { header: string; items: { c: ModelChoice; nav: number }[] }[] = []
    filtered.forEach((c, i) => {
      // The label is 'Short · model-id' (providers.ts models()) — the prefix is the header.
      const header = c.label.split(' · ')[0] ?? c.providerId
      if (out.length === 0 || out[out.length - 1]!.header !== header) out.push({ header, items: [] })
      out[out.length - 1]!.items.push({ c, nav: i + navOffset })
    })
    return out
  }, [filtered, navOffset])

  const isSelected = (c: ModelChoice): boolean =>
    c.providerId === value?.providerId && c.modelId === value?.modelId
  const currentLabel =
    choices.find(isSelected)?.label ?? (value ? `${value.providerId} · ${value.modelId}` : noneLabel)

  const openPicker = (): void => {
    setQ('')
    const selected = choices.findIndex(isSelected)
    setHighlight(selected >= 0 ? selected + (selectableNone ? 1 : 0) : 0)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Few models → no filter input → the panel itself must take the key events.
  useEffect(() => {
    if (open && !showFilter) panelRef.current?.focus()
  }, [open, showFilter])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector(`[data-nav="${highlight}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight])

  const pick = (m: ModelRef | null): void => {
    onChange(m)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation() // the Settings overlay also closes on Escape — eat it here
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, navLength - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (noneRow && highlight === 0) return pick(null)
      const c = filtered[highlight - navOffset]
      if (c) pick({ providerId: c.providerId, modelId: c.modelId })
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button onClick={() => (open ? setOpen(false) : openPicker())} title={currentLabel} className={triggerClassName}>
        <span className="truncate">{currentLabel}</span>
        <span className="shrink-0 text-[9px] text-ink-muted">▾</span>
      </button>
      {open && (
        <div
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`absolute left-0 z-30 w-72 overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg outline-none ${
            direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {showFilter && (
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setHighlight(0) // typing re-filters — restart at the top of the new list
              }}
              placeholder="Filter models…"
              className="w-full border-b border-hairline bg-transparent px-3 py-2 text-[12px] outline-none"
              style={{ userSelect: 'text' }}
            />
          )}
          <div ref={listRef} className="max-h-64 overflow-y-auto p-1">
            {noneRow && (
              <button
                data-nav={0}
                onClick={() => pick(null)}
                onMouseEnter={() => setHighlight(0)}
                className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] ${
                  highlight === 0 ? 'bg-hover' : ''
                } ${value === null ? 'font-medium' : ''}`}
              >
                {noneLabel}
              </button>
            )}
            {groups.map((g) => (
              <div key={g.header}>
                <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  {g.header}
                </p>
                {g.items.map(({ c, nav }) => (
                  <button
                    key={`${c.providerId}|${c.modelId}`}
                    data-nav={nav}
                    onClick={() => pick({ providerId: c.providerId, modelId: c.modelId })}
                    onMouseEnter={() => setHighlight(nav)}
                    className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] ${
                      nav === highlight ? 'bg-hover' : ''
                    } ${isSelected(c) ? 'font-medium text-accent' : ''}`}
                  >
                    {c.modelId}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-3 text-center text-[11px] text-ink-muted">No models match.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
