import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Dev server only: allow the Vite HMR websocket (default-src 'self' blocks ws:). Prod stays strict. */
function relaxCspForDev(): Plugin {
  return {
    name: 'relax-csp-for-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("default-src 'self';", "default-src 'self'; connect-src 'self' ws: http:;")
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // utilityProcess entry: must stay its own file (out/main/embeddings.worker.js),
          // never bundled into main's index.js. @huggingface/transformers stays external
          // via externalizeDepsPlugin (it is in dependencies).
          'embeddings.worker': resolve('src/main/workers/embeddings.worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        output: {
          // Sandboxed preloads cannot be ESM; force a single CJS file.
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss(), relaxCspForDev()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'quick-capture': resolve('src/renderer/quick-capture.html')
        }
      }
    }
  }
})
