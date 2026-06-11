import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, _electron, type ElectronApplication, type Page } from 'playwright/test'

/**
 * E2E smoke (M9): boots the REAL packaged-layout app (electron . → out/main)
 * against a throwaway DB/socket/userData and drives the actual UI.
 *
 * Electron 41 + ESM main: _electron.launch({ args: ['.'] }) resolves the app
 * from package.json "main" exactly like `npx electron .` — works as-is, no
 * adaptation needed (verified locally).
 */

let app: ElectronApplication
let win: Page
let dir: string

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mymem-e2e-'))
  app = await _electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      // Full isolation: own DB, own agent socket, own userData (= own
      // single-instance lock — the suite can run next to a live myMem).
      MYMEM_DB_PATH: join(dir, 'e2e.db'),
      MYMEM_SOCKET: join(dir, 'api.sock'),
      MYMEM_USER_DATA: join(dir, 'user-data')
    }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('boots to a usable shell with onboarding seeds', async () => {
  await expect(win.getByTestId('new-note')).toBeVisible()
  await expect(win.getByTestId('open-search')).toBeVisible()
  // First run seeds the Welcome collection (3 notes) in the sidebar.
  await expect(win.getByText('Welcome (3)')).toBeVisible()
})

test('creates a note via the UI and the note list shows it', async () => {
  await win.getByTestId('new-note').click()
  const title = win.getByPlaceholder('Untitled')
  await expect(title).toBeVisible()
  await title.fill('Playwright smoke note')
  await title.blur() // blur flushes the autosave immediately

  await win.getByTestId('nav-home').click()
  await expect(
    win.getByTestId('note-list-item').filter({ hasText: 'Playwright smoke note' })
  ).toBeVisible()
})

test('theme:set drives the .dark class end-to-end', async () => {
  // Settings → General does exactly this invoke; going through the preload
  // bridge exercises the full chain: typed IPC → nativeTheme.themeSource →
  // theme:changed push → renderer class toggle (and persistence in settings).
  // globalThis === window in the page; tsconfig.node has no DOM lib.
  type Bridge = { api: { invoke: (ch: string, args: unknown) => Promise<unknown> } }
  await win.evaluate(() => (globalThis as unknown as Bridge).api.invoke('theme:set', { theme: 'dark' }))
  await expect(win.locator('html')).toHaveClass(/dark/)
  await win.evaluate(() => (globalThis as unknown as Bridge).api.invoke('theme:set', { theme: 'light' }))
  await expect(win.locator('html')).not.toHaveClass(/dark/)
})

test('Cmd+K palette finds the new note and opens it', async () => {
  await win.getByTestId('open-search').click()
  const input = win.getByPlaceholder('Search notes…')
  await expect(input).toBeVisible()
  await input.fill('Playwright smoke')
  const row = win.getByRole('button', { name: /Playwright smoke note/ })
  await expect(row).toBeVisible()
  await input.press('Enter')
  // Palette closed and the note is open in the active pane.
  await expect(input).toHaveCount(0)
  await expect(win.getByPlaceholder('Untitled')).toHaveValue('Playwright smoke note')
})
