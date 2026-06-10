import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  esbuild: { jsx: 'automatic' }, // .tsx tests use the same JSX runtime as the app build
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer')
    }
  },
  test: {
    // Main-process code imports better-sqlite3 (Electron-ABI native) and cannot
    // load under plain Node — only tests/ is in scope.
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node' // editor tests opt into happy-dom via per-file directive
  }
})
