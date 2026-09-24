/**
 * End-to-end smoke test of the REAL app in Chrome: a recorded clip is turned
 * into a .y4m file and fed to Chrome as a fake webcam, the app is started as a
 * user would start it, and its live diagnostics plus a screenshot (with the
 * segmentation overlay on) are captured.
 *
 *   node live-smoke.mjs [clip=rotation] [seconds=12]
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
import jpeg from 'jpeg-js'
import { decodeFixture } from '../../src/vto/replay/fixtureFormat.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const clip = process.argv[2] || 'rotation'
const seconds = Number(process.argv[3]) || 12
const OUT = path.join(import.meta.dirname, 'out', 'live')
fs.mkdirSync(OUT, { recursive: true })

// --- clip -> y4m (4:2:0), played forward then backward so the loop is seamless
const fx = decodeFixture(fs.readFileSync(path.join(ROOT, 'fixtures', clip, 'recording.v1.bin')))
const frames = fx.frames.map((f) => jpeg.decode(f.payload, { useTArray: true, formatAsRGBA: false }))
const W = frames[0].width
const H = frames[0].height
const y4m = path.join(OUT, `${clip}.y4m`)
const fd = fs.openSync(y4m, 'w')
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`)
const order = [...frames, ...frames.slice(1, -1).reverse()]
for (const img of order) {
  const Y = Buffer.alloc(W * H)
  const U = Buffer.alloc((W / 2) * (H / 2))
  const V = Buffer.alloc((W / 2) * (H / 2))
  for (let i = 0; i < W * H; i++) {
    const r = img.data[i * 3], g = img.data[i * 3 + 1], b = img.data[i * 3 + 2]
    Y[i] = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b))
  }
  for (let y = 0; y < H / 2; y++) {
    for (let x = 0; x < W / 2; x++) {
      const i = (y * 2 * W + x * 2) * 3
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      U[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 - 0.1687 * r - 0.3313 * g + 0.5 * b))
      V[y * (W / 2) + x] = Math.max(0, Math.min(255, 128 + 0.5 * r - 0.4187 * g - 0.0813 * b))
    }
  }
  fs.writeSync(fd, 'FRAME\n')
  fs.writeSync(fd, Y)
  fs.writeSync(fd, U)
  fs.writeSync(fd, V)
}
fs.closeSync(fd)

const { createServer } = await import(pathToFileURL(path.join(ROOT, 'node_modules/vite/dist/node/index.js')).href)
const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 5198, strictPort: true } })
await server.listen()
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    '--window-size=1400,900',
  ],
  defaultViewport: { width: 1400, height: 900 },
})
const errors = []
try {
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message))
  await page.goto('http://localhost:5198/', { waitUntil: 'networkidle2' })
  await page.click('button.primary')
  await page.waitForFunction(() => window.__vto, { timeout: 60000 })
  await page.evaluate((occ, walls) => { window.__vto.options.showSegmentation = true; window.__vto.options.showWristFrame = true; window.__vto.options.showOccluder = occ; window.__vto.options.showWalls = walls }, !process.env.NO_OCC, !!process.env.WALLS)
  const samples = []
  for (let s = 0; s < seconds; s++) {
    await new Promise((r) => setTimeout(r, 1000))
    samples.push(await page.evaluate(() => {
      const d = window.__vto.diagnostics
      return {
        frameSource: window.__vto._frame?.image?.constructor?.name, fps: d.fps, cameraFps: d.cameraFps, frameMs: d.frameMs, latencyMs: d.latencyMs, state: d.state, handHz: d.handHz, handMs: d.handMs, segHz: d.segHz, segMs: d.segMs,
        refineMs: d.refineMs, maskActive: d.maskActive, sil: d.forearmFromSilhouette, silConf: d.silhouetteConfidence,
        joint: d.forearmCorrectionDeg, width: d.wristWidthMm, jitterPx: d.jitterPx, jitterDeg: d.jitterDeg,
        fov: d.fovYDeg, fovSource: d.fovSource,
        geo: (() => { const g = window.__vto.tracker.geometry, o = window.__vto.observer; return { locked: g.locked, good: g.goodFrames, w: +g.widthMm.toFixed(1), d: +g.depthMm.toFixed(1), sv: g._singleView.length, svMed: g._singleView.length ? +[...g._singleView].sort((a,b)=>a-b)[g._singleView.length>>1].toFixed(1) : 0, palmLock: +o._scale.value.toFixed(1), palmN: o._scale.samples.length, fit: g.sampleCount } })(),
      }
    }))
  }
  await page.screenshot({ path: path.join(OUT, `${clip}.png`) })
  for (const s of samples) console.log(JSON.stringify(s))
} finally {
  await browser.close()
  await server.close()
}
console.log(`GL/driver messages filtered: ${errors.filter((e) => /GL Driver Message|WebGL: INVALID|gpu|OpenGL/i.test(e)).length}`)
const relevant = errors.filter((e) => !/GL Driver Message|WebGL: INVALID|gpu|OpenGL/i.test(e))
console.log(`\nconsole errors/warnings: ${relevant.length}`)
relevant.slice(0, 15).forEach((e) => console.log('  ' + e.slice(0, 300)))
console.log(`screenshot: ${path.join(OUT, `${clip}.png`)}`)
