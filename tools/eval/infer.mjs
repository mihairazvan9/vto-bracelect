/**
 * Runs MediaPipe segmentation strategies on the recorded frames in real
 * Chrome and stores their soft masks under out/<method>/<clip>/<index>.bin.
 *
 *   node infer.mjs [--methods full,roi:4.4,app:3] [--clips front,side] [--cpu]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(import.meta.dirname, 'out')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const methods = arg('methods', 'full,roi:2.4,roi:3.2,roi:4.4,app:3').split(',')
const clips = arg('clips', fs.readdirSync(path.join(ROOT, 'fixtures')).join(',')).split(',')
const delegate = process.argv.includes('--cpu') ? 'CPU' : 'GPU'

const { createServer } = await import(pathToFileURL(path.join(ROOT, 'node_modules/vite/dist/node/index.js')).href)
const server = await createServer({ root: ROOT, configFile: false, logLevel: 'error', server: { port: 5199, strictPort: true } })
await server.listen()

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-webgpu'],
})
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()) })
  await page.goto('http://localhost:5199/tools/eval/harness.html')
  await page.waitForFunction(() => window.evalApi, { timeout: 60000 })
  await page.evaluate((d) => window.evalApi.init(d), delegate)
  for (const clip of clips) {
    const n = await page.evaluate((c) => window.evalApi.loadClip(c), clip)
    for (const method of methods) {
      // Warm-up pass so model compilation does not count as frame time.
      if (method === methods[0]) await page.evaluate((m) => window.evalApi.run(m), method)
      const { masks, msPerFrame } = await page.evaluate((m) => window.evalApi.run(m), method)
      const dir = path.join(OUT, method.replace(':', '_'), clip)
      fs.mkdirSync(dir, { recursive: true })
      masks.forEach((m, i) => m && fs.writeFileSync(path.join(dir, `${i}.bin`), Buffer.from(m, 'base64')))
      console.log(`${clip.padEnd(17)} ${method.padEnd(8)} ${n} frames  ${msPerFrame.toFixed(1)} ms/frame (${delegate})`)
    }
  }
} finally {
  await browser.close()
  await server.close()
}
