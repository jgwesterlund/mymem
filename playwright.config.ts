import { defineConfig } from 'playwright/test'

/**
 * E2E config (M9): a single Electron project — _electron.launch boots the real
 * built app (out/), so no browsers are downloaded or needed. Run `npm run e2e`
 * (build + test); specs isolate state via MYMEM_DB_PATH/MYMEM_SOCKET/
 * MYMEM_USER_DATA pointed at temp dirs (own single-instance lock, so the
 * suite runs fine next to a live myMem).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One worker: each test boots its own Electron app; parallel apps fight over
  // the dock/focus and make timing flaky for no speedup on this suite size.
  workers: 1,
  reporter: 'list',
  projects: [{ name: 'electron' }]
})
