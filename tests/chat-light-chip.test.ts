// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextChip } from '../src/shared/types'

/**
 * Chat-store light-chip tracking (v1.1 review M2): the active note's content is
 * FULL-attached once per conversation; while {noteId, updatedAt} are unchanged
 * the chip goes out with light:true (main then skips content re-injection).
 * An edit (updatedAt bump) or a new/reopened conversation re-attaches fully.
 */

const h = vi.hoisted(() => ({
  invokeCalls: [] as { channel: string; args: unknown[] }[],
  noteUpdatedAt: 100
}))

vi.mock('../src/renderer/api', () => ({
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    h.invokeCalls.push({ channel, args })
    switch (channel) {
      case 'notes:get':
        return Promise.resolve({
          id: (args[0] as { id: string }).id,
          title: 'Note under test',
          contentMd: 'body',
          updatedAt: h.noteUpdatedAt,
          createdAt: 1,
          trashedAt: null,
          titleSource: 'user',
          collectionIds: [],
          pinned: false
        })
      case 'chat:send':
        return Promise.resolve({ chatId: 'chat-1', requestId: `req-${h.invokeCalls.length}` })
      case 'chats:list':
        return Promise.resolve([])
      case 'ai:models':
        return Promise.resolve([])
      case 'settings:get':
        return Promise.resolve(null)
      default:
        return Promise.resolve(null)
    }
  },
  on: () => () => {}
}))

import { useChatStore } from '../src/renderer/stores/chat'
import { useTabsStore } from '../src/renderer/stores/tabs'

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function sentChips(): ContextChip[][] {
  return h.invokeCalls
    .filter((c) => c.channel === 'chat:send')
    .map((c) => (c.args[0] as { contextChips: ContextChip[] }).contextChips)
}

async function sendTurn(text: string): Promise<void> {
  useChatStore.setState({ streaming: false })
  await useChatStore.getState().send(text)
}

beforeEach(async () => {
  useChatStore.getState().newChat() // also resets the module-level attach tracking
  await settle() // let newChat's refreshModels resolve before pinning a model
  useChatStore.setState({ model: { providerId: 'fake', modelId: 'fake-model' } })
  useTabsStore.getState().openInCurrentTab({ kind: 'note', noteId: 'n1' })
  h.invokeCalls = []
  h.noteUpdatedAt = 100
})

describe('light active chip', () => {
  it('full chip on turn 1, light while unchanged, full again after an edit', async () => {
    await sendTurn('turn one')
    await sendTurn('turn two')
    h.noteUpdatedAt = 200 // the note was edited between turns
    await sendTurn('turn three')
    await sendTurn('turn four')

    const chips = sentChips()
    expect(chips).toEqual([
      [{ type: 'note', id: 'n1', active: true }],
      [{ type: 'note', id: 'n1', active: true, light: true }],
      [{ type: 'note', id: 'n1', active: true }],
      [{ type: 'note', id: 'n1', active: true, light: true }]
    ])
  })

  it('a new conversation re-attaches the full content', async () => {
    await sendTurn('turn one')
    expect(sentChips()[0]).toEqual([{ type: 'note', id: 'n1', active: true }])

    useChatStore.getState().newChat()
    await settle()
    useChatStore.setState({ model: { providerId: 'fake', modelId: 'fake-model' } })
    await sendTurn('fresh conversation')
    expect(sentChips()[1]).toEqual([{ type: 'note', id: 'n1', active: true }]) // NOT light
  })

  it('a dismissed auto chip sends no chip and fetches nothing', async () => {
    useChatStore.getState().dismissActiveChip()
    await sendTurn('no chip please')
    expect(sentChips()[0]).toEqual([])
    expect(h.invokeCalls.filter((c) => c.channel === 'notes:get')).toHaveLength(0)
  })

  it('switching to another note attaches that note fully', async () => {
    await sendTurn('turn one')
    useTabsStore.getState().openInCurrentTab({ kind: 'note', noteId: 'n2' })
    await sendTurn('other note')
    expect(sentChips()[1]).toEqual([{ type: 'note', id: 'n2', active: true }]) // NOT light
  })
})
