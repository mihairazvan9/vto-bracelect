import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
/** The only files a recorded take consists of (src/vto/capture/ClipWriter.js). */
const FIXTURE_FILES = new Set(['recording.v1.bin', 'armmask.bin', 'capture.json'])
const CLIP_ID = /^[a-z0-9][a-z0-9-]{0,30}$/
const MAX_BYTES = 512 * 1024 * 1024

/**
 * Dev server only: lets the in-app recorder write takes straight into
 * fixtures/<clip>/, where `npm run bench` picks them up. Never part of a
 * build. Clip ids and file names are allow-listed, so nothing can be written
 * outside that folder.
 */
function fixtureSink() {
  return {
    name: 'fixture-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__fixtures/save', (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const clip = url.searchParams.get('clip') ?? ''
        const file = url.searchParams.get('file') ?? ''
        if (req.method !== 'POST' || !CLIP_ID.test(clip) || !FIXTURE_FILES.has(file)) {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BYTES) req.destroy()
          else chunks.push(chunk)
        })
        req.on('end', () => {
          try {
            const dir = path.join(FIXTURES, clip)
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(path.join(dir, file), Buffer.concat(chunks))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, path: `fixtures/${clip}/${file}`, bytes: size }))
          } catch (err) {
            res.statusCode = 500
            res.end(String(err?.message ?? err))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
    fixtureSink(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
