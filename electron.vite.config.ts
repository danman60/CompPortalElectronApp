import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // D1/D2: worker_threads entrypoints — emitted as out/main/workers/<name>.js
          // so exifWorkerPool.ts / matcherWorkerPool.ts can resolve them relative
          // to __dirname at runtime.
          'workers/exifReader': resolve(__dirname, 'src/main/workers/exifReader.ts'),
          'workers/matcher': resolve(__dirname, 'src/main/workers/matcher.ts'),
          // build9r — child-process upload worker (feature-flagged, see
          // settings.upload.uploadStrategy). Spawned via process.execPath
          // with ELECTRON_RUN_AS_NODE=1 so wmic can priority-control it.
          'workers/uploadWorker': resolve(__dirname, 'src/main/workers/uploadWorker.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html')
        }
      }
    }
  }
})
