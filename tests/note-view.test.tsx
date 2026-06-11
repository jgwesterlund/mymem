// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Editor as TipTapEditor } from '@tiptap/core'
import type { DataChangedEvent } from '../src/shared/ipc'
import NoteView from '../src/renderer/views/NoteView'

declare global {
  // React act() opt-in for non-test-renderer environments.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * NoteView save-pipeline regressions (review C1/C2/M1/minor 6). The api module
 * is mocked wholesale; the Editor component is replaced by a HEADLESS TipTap
 * instance built from the real buildExtensions() schema — same documents, same
 * markdown manager, no React editor chrome (BubbleMenu et al. need a layouting
 * DOM that happy-dom does not provide).
 */
const h = vi.hoisted(() => ({
  invokeCalls: [] as { channel: string; args: unknown[] }[],
  invokeImpl: undefined as ((channel: string, ...args: unknown[]) => Promise<unknown>) | undefined,
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
  currentEditor: null as TipTapEditor | null
}))

vi.mock('../src/renderer/api', () => ({
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    h.invokeCalls.push({ channel, args })
    if (!h.invokeImpl) return Promise.reject(new Error('invokeImpl not set'))
    return h.invokeImpl(channel, ...args)
  },
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!h.listeners.has(channel)) h.listeners.set(channel, new Set())
    h.listeners.get(channel)!.add(cb)
    return () => h.listeners.get(channel)!.delete(cb)
  }
}))

vi.mock('../src/renderer/editor/Editor', async () => {
  const { Editor } = await import('@tiptap/core')
  const { buildExtensions } = await import('../src/renderer/editor/extensions')
  const { useEffect } = await import('react')
  function EditorStub(props: {
    initialMd: string
    onReady: (e: TipTapEditor) => void
    onDocChanged: (e: TipTapEditor) => void
  }): null {
    const { initialMd, onReady, onDocChanged } = props
    useEffect(() => {
      const editor = new Editor({
        element: document.createElement('div'),
        extensions: buildExtensions(),
        content: initialMd,
        contentType: 'markdown',
        onCreate: ({ editor: e }) => onReady(e),
        onUpdate: ({ editor: e }) => onDocChanged(e)
      })
      h.currentEditor = editor
      return () => editor.destroy()
      // Mounted once per key — mirrors the real Editor component contract.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
  }
  return { default: EditorStub }
})

function noteFixture(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'n1',
    title: 'T',
    titleSource: 'user',
    contentMd: 'Hello.',
    createdAt: 1,
    updatedAt: 100,
    trashedAt: null,
    collectionIds: [],
    pinned: false,
    ...over
  }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await tick(10)
  }
}

async function renderNoteView(noteId: string): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<NoteView noteId={noteId} />)
  })
  // TipTap emits 'create' (→ onReady) from a setTimeout(0) — let it land before
  // tests interact with the editor, like the real app does before any typing.
  await act(async () => {
    await tick(20)
  })
  return { root, container }
}

async function emitData(ev: DataChangedEvent): Promise<void> {
  await act(async () => {
    for (const cb of h.listeners.get('data:changed') ?? []) cb(ev)
  })
}

const updateCalls = (): { channel: string; args: unknown[] }[] =>
  h.invokeCalls.filter((c) => c.channel === 'notes:update')

beforeEach(() => {
  h.invokeCalls.length = 0
  h.listeners.clear()
  h.currentEditor = null
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('NoteView save pipeline', () => {
  it('C2: never writes an unedited note back, even when stored markdown is non-canonical', async () => {
    // '*' bullets, CRLF and a setext heading all serialize differently — the old
    // lastMd baseline (normalized STORED text) made this note "dirty" at open.
    const stored = '* one\r\n* two\r\n\r\nBig title\n=========\n'
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture({ contentMd: stored })
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { root } = await renderNoteView('n1')
    expect(h.currentEditor).not.toBeNull()
    await act(async () => {
      await tick(900) // outlive the 800 ms debounce window
      root.unmount() // unmount flush is the destructive path
    })
    await act(async () => {
      await tick(20)
    })
    expect(updateCalls()).toHaveLength(0)
  })

  it('C2: silent-reloads a clean non-canonical note on external change (no banner)', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture({ contentMd: '* one\n* two' })
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { container } = await renderNoteView('n1')
    await emitData({ entity: 'note', ids: ['n1'], op: 'update', origin: 'ai' })
    await waitUntil(() => h.invokeCalls.filter((c) => c.channel === 'notes:get').length === 2)
    await act(async () => {
      await tick(20)
    })
    expect(container.textContent).not.toContain('Note changed elsewhere')
  })

  it('C1: flush awaits the in-flight save and loops until clean — typing during a save is never dropped', async () => {
    let releaseFirstSave: ((v: { updatedAt: number }) => void) | null = null
    h.invokeImpl = async (channel, payload) => {
      if (channel === 'notes:get') return noteFixture()
      if (channel === 'notes:update') {
        if (updateCalls().length === 1) {
          return new Promise((r) => {
            releaseFirstSave = r
          })
        }
        return { updatedAt: 200 + updateCalls().length }
      }
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { root } = await renderNoteView('n1')
    const editor = h.currentEditor!

    // Edit #1 → debounce fires → save starts and stays in flight.
    await act(async () => {
      editor.commands.insertContent('AAA ')
      await tick(850)
    })
    expect(updateCalls()).toHaveLength(1)
    expect(releaseFirstSave).not.toBeNull()

    // Edit #2 lands while save #1 is in flight, then the tab closes immediately.
    await act(async () => {
      editor.commands.insertContent('BBB ')
    })
    const finalMd = editor.getMarkdown().replace(/\n+$/, '')
    await act(async () => {
      root.unmount()
    })

    releaseFirstSave!({ updatedAt: 150 })
    // The fixed flush loops: a second save must carry the BBB keystrokes.
    await waitUntil(() => updateCalls().length === 2)
    const second = updateCalls()[1]!.args[0] as { patch: { contentMd?: string } }
    expect(second.patch.contentMd).toBe(finalMd)
    expect(finalMd).toContain('BBB')
  })

  it('M1: shows a recoverable state with a close button when the note is gone', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') throw new Error('note not found: nX')
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { container } = await renderNoteView('nX')
    await act(async () => {
      await tick(20)
    })
    expect(container.textContent).toContain('Note not found')
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Close tab')
  })

  it('minor 6: stops saving and offers to close when the open note is trashed', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture()
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { root, container } = await renderNoteView('n1')
    await act(async () => {
      h.currentEditor!.commands.insertContent('dirty ') // pending debounce
    })
    await emitData({ entity: 'note', ids: ['n1'], op: 'trash', origin: 'user' })
    expect(container.textContent).toContain('moved to Trash')
    await act(async () => {
      await tick(900) // pending save must NOT fire after the trash
      root.unmount() // neither may the unmount flush
    })
    await act(async () => {
      await tick(20)
    })
    expect(updateCalls()).toHaveLength(0)
  })

  it('M2: asks before a Reload discards dirty local edits', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture()
      if (channel === 'notes:update') return { updatedAt: 200 }
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { container } = await renderNoteView('n1')
    await act(async () => {
      h.currentEditor!.commands.insertContent('dirty ') // dirty → external write banners
    })
    await emitData({ entity: 'note', ids: ['n1'], op: 'update', origin: 'ai' })
    expect(container.textContent).toContain('Note changed elsewhere')

    const confirmSpy = vi.fn().mockReturnValue(false)
    vi.stubGlobal('confirm', confirmSpy) // happy-dom ships no window.confirm
    const reload = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!
    await act(async () => {
      reload.click()
    })
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(h.invokeCalls.filter((c) => c.channel === 'notes:get')).toHaveLength(1) // declined → no reload

    confirmSpy.mockReturnValue(true)
    await act(async () => {
      reload.click()
    })
    await waitUntil(() => h.invokeCalls.filter((c) => c.channel === 'notes:get').length === 2)
    vi.unstubAllGlobals()
  })
})

/**
 * M9 split panes: the SAME note can be open in both panes (the default Cmd+.
 * state). Pane A's autosave reaches pane B as data:changed origin 'user' —
 * the old blanket origin-user skip left pane B's CAS base permanently stale
 * (first keystroke → unfixable conflict). The fix: a clean, stale instance
 * silently adopts the save; the saver and dirty instances skip.
 */
describe('NoteView two-pane save adoption (origin user)', () => {
  const getCalls = (): number => h.invokeCalls.filter((c) => c.channel === 'notes:get').length

  it('a clean co-mounted view silently reloads when its base is stale', async () => {
    let updatedAt = 100
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') {
        return noteFixture({ updatedAt, contentMd: updatedAt === 100 ? 'Hello.' : 'Hello from pane A.' })
      }
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { container } = await renderNoteView('n1')
    updatedAt = 150 // pane A saved → newer updatedAt in the DB
    await emitData({ entity: 'note', ids: ['n1'], op: 'update', origin: 'user' })
    // get #2 = the staleness check, get #3 = the adopting epoch reload.
    await waitUntil(() => getCalls() === 3)
    await act(async () => {
      await tick(20)
    })
    expect(container.textContent).not.toContain('Note changed elsewhere') // silent — no banner
  })

  it('the saving pane (base already current) checks but does not reload', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture() // updatedAt 100 === the view's base
      throw new Error(`unexpected invoke: ${channel}`)
    }
    await renderNoteView('n1')
    await emitData({ entity: 'note', ids: ['n1'], op: 'update', origin: 'user' })
    await waitUntil(() => getCalls() === 2) // staleness check runs…
    await act(async () => {
      await tick(50)
    })
    expect(getCalls()).toBe(2) // …but no adopting reload (would clobber the cursor)
  })

  it('a dirty view skips entirely — the CAS guard decides at save time', async () => {
    h.invokeImpl = async (channel) => {
      if (channel === 'notes:get') return noteFixture()
      if (channel === 'notes:update') return { updatedAt: 200 }
      throw new Error(`unexpected invoke: ${channel}`)
    }
    const { root, container } = await renderNoteView('n1')
    await act(async () => {
      h.currentEditor!.commands.insertContent('local edits ') // pending debounce → dirty
    })
    await emitData({ entity: 'note', ids: ['n1'], op: 'update', origin: 'user' })
    await act(async () => {
      await tick(50)
    })
    expect(getCalls()).toBe(1) // no staleness fetch, no reload
    expect(container.textContent).not.toContain('Note changed elsewhere') // and no banner
    await act(async () => {
      root.unmount() // flush the pending save inside the mocked pipeline
    })
  })
})
