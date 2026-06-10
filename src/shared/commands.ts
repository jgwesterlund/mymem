import type { CommandId } from './ipc'

/**
 * THE single command table: main builds the native NSMenu from it, the renderer
 * registers handlers by id in commands/registry.ts. One table, zero drift.
 *
 * Accelerators are wired milestone by milestone — commands without one still live
 * here so the menu items exist (handlers toast when the feature hasn't shipped).
 */
export interface CommandSpec {
  label: string
  accelerator?: string
  menu: 'file' | 'edit' | 'view' | 'note' | 'window' | null
}

export const COMMANDS: Record<CommandId, CommandSpec> = {
  // ── File ──
  'new-note': { label: 'New Note', accelerator: 'CmdOrCtrl+N', menu: 'file' },
  'new-chat': { label: 'New Chat', menu: 'file' },
  'open-search': { label: 'Search Notes…', accelerator: 'CmdOrCtrl+K', menu: 'file' },
  'import-files': { label: 'Import Files…', menu: 'file' },
  'export-note': { label: 'Export as Markdown…', menu: 'file' },
  'close-tab': { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', menu: 'file' },

  // ── View ──
  'toggle-sidebar': { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+\\', menu: 'view' },
  'toggle-right-panel': { label: 'Toggle Right Panel', accelerator: 'CmdOrCtrl+\\', menu: 'view' },
  'toggle-heads-up': { label: 'Heads Up', accelerator: 'CmdOrCtrl+Shift+K', menu: 'view' },
  'nav-back': { label: 'Back', accelerator: 'CmdOrCtrl+[', menu: 'view' },
  'nav-forward': { label: 'Forward', accelerator: 'CmdOrCtrl+]', menu: 'view' },

  // ── Note ──
  organize: { label: 'Organize…', accelerator: 'CmdOrCtrl+O', menu: 'note' },
  'auto-organize': { label: 'Auto-Organize', menu: 'note' },
  'clean-up': { label: 'Clean Up', menu: 'note' },
  'toggle-pin': { label: 'Pin Note', menu: 'note' },
  'find-in-note': { label: 'Find in Note…', menu: 'note' },
  'view-history': { label: 'Version History…', menu: 'note' },

  // ── Window ──
  'split-pane': { label: 'Split Pane', menu: 'window' },
  'next-tab': { label: 'Show Next Tab', accelerator: 'Ctrl+Tab', menu: 'window' },
  'prev-tab': { label: 'Show Previous Tab', accelerator: 'Ctrl+Shift+Tab', menu: 'window' },
  'activate-tab-1': { label: 'Tab 1', accelerator: 'CmdOrCtrl+1', menu: 'window' },
  'activate-tab-2': { label: 'Tab 2', accelerator: 'CmdOrCtrl+2', menu: 'window' },
  'activate-tab-3': { label: 'Tab 3', accelerator: 'CmdOrCtrl+3', menu: 'window' },
  'activate-tab-4': { label: 'Tab 4', accelerator: 'CmdOrCtrl+4', menu: 'window' },
  'activate-tab-5': { label: 'Tab 5', accelerator: 'CmdOrCtrl+5', menu: 'window' },
  'activate-tab-6': { label: 'Tab 6', accelerator: 'CmdOrCtrl+6', menu: 'window' },
  'activate-tab-7': { label: 'Tab 7', accelerator: 'CmdOrCtrl+7', menu: 'window' },
  'activate-tab-8': { label: 'Tab 8', accelerator: 'CmdOrCtrl+8', menu: 'window' },
  'activate-tab-9': { label: 'Last Tab', accelerator: 'CmdOrCtrl+9', menu: 'window' },

  // ── No menu yet (settings is an in-window overlay, M9) ──
  'open-settings': { label: 'Settings…', menu: null }
}

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[]
