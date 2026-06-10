import { describe, expect, it } from 'vitest'
import { COMMANDS, COMMAND_IDS } from '@shared/commands'
import type { CommandId } from '@shared/ipc'

// Type-level: COMMANDS is declared as Record<CommandId, CommandSpec>, so a stale
// or misspelled id (in either direction) fails the build before tests run.
const _ids: CommandId[] = COMMAND_IDS
void _ids

describe('command table', () => {
  it('every command has a non-empty label and a valid menu', () => {
    for (const [id, spec] of Object.entries(COMMANDS)) {
      expect(spec.label.length, id).toBeGreaterThan(0)
      expect([null, 'file', 'edit', 'view', 'note', 'window']).toContain(spec.menu)
    }
  })

  it('accelerators are unique', () => {
    const accelerators = Object.values(COMMANDS)
      .map((spec) => spec.accelerator)
      .filter((a): a is string => a !== undefined)
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('M2 shortcuts are wired', () => {
    expect(COMMANDS['new-note'].accelerator).toBe('CmdOrCtrl+N')
    expect(COMMANDS['open-search'].accelerator).toBe('CmdOrCtrl+K')
    expect(COMMANDS['close-tab'].accelerator).toBe('CmdOrCtrl+W')
    expect(COMMANDS['toggle-sidebar'].accelerator).toBe('CmdOrCtrl+Shift+\\')
    expect(COMMANDS['next-tab'].accelerator).toBe('Ctrl+Tab')
    expect(COMMANDS['prev-tab'].accelerator).toBe('Ctrl+Shift+Tab')
    expect(COMMANDS['nav-back'].accelerator).toBe('CmdOrCtrl+[')
    expect(COMMANDS['nav-forward'].accelerator).toBe('CmdOrCtrl+]')
  })
})
