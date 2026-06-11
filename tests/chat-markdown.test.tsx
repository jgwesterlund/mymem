// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatMarkdown } from '../src/renderer/chat/ChatMarkdown'
import { useTabsStore } from '../src/renderer/stores/tabs'

declare global {
  // React act() opt-in for non-test-renderer environments.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * Review C1: react-markdown 10's defaultUrlTransform strips mymem: hrefs (its
 * whitelist is http/https/irc/mailto/xmpp), so without our urlTransform the 'a'
 * override never sees the citation URL — chips died AND an empty-href
 * target=_blank anchor shell-opened the app URL on click. The transform must
 * whitelist ONLY mymem://note/<uuid>, keep external links intact, and keep
 * javascript: neutralized (rendered as plain text, no anchor).
 */
const NOTE_ID = '01890000-0000-7000-8000-000000000001'
const MD = [
  `See [Flux research](mymem://note/${NOTE_ID}) for details.`,
  'Docs: [react site](https://react.dev/learn).',
  'Evil: [click me](javascript:alert(1)).',
  'Also evil: [almost a note](mymem://note/not-a-uuid).'
].join('\n\n')

async function render(md: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<ChatMarkdown text={md} />)
  })
  return container
}

const initialTabs = useTabsStore.getState()

beforeEach(() => {
  useTabsStore.setState(initialTabs, true)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ChatMarkdown link handling', () => {
  it('renders a mymem://note/<uuid> citation as a chip that opens the note', async () => {
    const container = await render(MD)
    const chip = container.querySelector('button.citation-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('Flux research')

    await act(async () => {
      ;(chip as HTMLButtonElement).click()
    })
    const tabs = useTabsStore.getState()
    const active = tabs.tabs[tabs.activeTabIndex]!
    // M9 pane shape: the citation opens in the ACTIVE pane of the active tab.
    expect(active.panes[active.activePane]!.content).toEqual({ kind: 'note', noteId: NOTE_ID })
  })

  it('keeps external https links intact (target=_blank, href preserved)', async () => {
    const container = await render(MD)
    const external = [...container.querySelectorAll('a')].find((a) => a.textContent === 'react site')
    expect(external).toBeDefined()
    expect(external!.getAttribute('href')).toBe('https://react.dev/learn')
    expect(external!.getAttribute('target')).toBe('_blank')
  })

  it('neutralizes javascript: links — no anchor, no empty-href shell, text kept', async () => {
    const container = await render(MD)
    for (const a of container.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
      // The empty-href anchor was the shell-open vector — none may render.
      expect(a.getAttribute('href') ?? '').not.toBe('')
    }
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'click me')).toBe(false)
    expect(container.textContent).toContain('click me') // plain text survives
  })

  it('does not chip mymem URLs that are not a full note uuid', async () => {
    const container = await render(MD)
    expect(container.querySelectorAll('button.citation-chip')).toHaveLength(1)
    expect(container.textContent).toContain('almost a note')
  })
})
