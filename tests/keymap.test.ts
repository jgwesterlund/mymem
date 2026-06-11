// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/api', () => ({
  invoke: async (): Promise<unknown> => ({ ok: true }),
  on: () => () => {}
}))

import { COMMANDS, COMMAND_IDS } from '@shared/commands'
import type { CommandId } from '@shared/ipc'
import { commandHandlers } from '../src/renderer/commands/registry'

/**
 * Keymap regression test (M9): shared/commands.ts is THE single command table
 * (main builds the native menu from it, the renderer registers handlers by id).
 * This test fails on drift in any direction: an id without a handler, a handler
 * without an id, duplicate accelerators, or a silently changed shortcut.
 */
describe('keymap: COMMANDS ↔ commandHandlers', () => {
  it('every CommandId has a real handler in the renderer registry', () => {
    for (const id of COMMAND_IDS) {
      expect(commandHandlers[id], `missing handler for command '${id}'`).toBeTypeOf('function')
    }
  })

  it('the registry has no orphan handlers (ids that left the command table)', () => {
    for (const id of Object.keys(commandHandlers)) {
      expect(COMMAND_IDS, `orphan handler '${id}' — not in COMMANDS`).toContain(id as CommandId)
    }
  })

  it('accelerators are unique across the whole table', () => {
    const accelerators = COMMAND_IDS.map((id) => COMMANDS[id].accelerator).filter(
      (a): a is string => a !== undefined
    )
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('the full shortcut map matches the plan (fails on accidental rebinds)', () => {
    const expected: Record<CommandId, string | undefined> = {
      'new-note': 'CmdOrCtrl+N',
      'new-chat': 'CmdOrCtrl+J',
      'open-search': 'CmdOrCtrl+K',
      'import-files': undefined,
      'export-note': undefined,
      'close-tab': 'CmdOrCtrl+W',
      'toggle-sidebar': 'CmdOrCtrl+Shift+\\',
      'toggle-right-panel': 'CmdOrCtrl+\\',
      'toggle-heads-up': 'CmdOrCtrl+Shift+K',
      'nav-back': 'CmdOrCtrl+[',
      'nav-forward': 'CmdOrCtrl+]',
      organize: 'CmdOrCtrl+O',
      'auto-organize': 'CmdOrCtrl+Shift+O',
      'clean-up': 'CmdOrCtrl+Shift+U',
      'toggle-pin': 'CmdOrCtrl+Shift+P',
      'find-in-note': 'CmdOrCtrl+F',
      'view-history': undefined,
      'split-pane': 'CmdOrCtrl+.',
      'next-tab': 'Ctrl+Tab',
      'prev-tab': 'Ctrl+Shift+Tab',
      'activate-tab-1': 'CmdOrCtrl+1',
      'activate-tab-2': 'CmdOrCtrl+2',
      'activate-tab-3': 'CmdOrCtrl+3',
      'activate-tab-4': 'CmdOrCtrl+4',
      'activate-tab-5': 'CmdOrCtrl+5',
      'activate-tab-6': 'CmdOrCtrl+6',
      'activate-tab-7': 'CmdOrCtrl+7',
      'activate-tab-8': 'CmdOrCtrl+8',
      'activate-tab-9': 'CmdOrCtrl+9',
      'open-settings': 'CmdOrCtrl+,'
    }
    const actual = Object.fromEntries(COMMAND_IDS.map((id) => [id, COMMANDS[id].accelerator]))
    expect(actual).toEqual(expected)
  })
})
