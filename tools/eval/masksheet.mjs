/**
 * Crops around the wrist: camera frame with a method's mask (>=128) tinted and
 * the reference outline in magenta.   node masksheet.mjs <method> <clip> <out.png> [every]
 */
import fs from 'node:fs'
import { loadEvalClips, decodeRgb, methodMask } from './score.mjs'
import { writePng } from './png.mjs'
const [method, clipId, out, everyArg] = process.argv.slice(2)
const every = Number(everyArg) || 6
const S = 200
const tiles = []
for (const clip of loadEvalClips([clipId])) {
  for (const frame of clip.frames) {
    if (frame.index % every) continue
    const m = methodMask(method, clip.id, frame)
    if (!m) continue
    const img = decodeRgb(frame.fr)
    const { W, H, gt, geom } = frame
    const cx = Math.round(geom.wrist.x + geom.ax * geom.palmLen * 0.5)
    const cy = Math.round(geom.wrist.y + geom.ay * geom.palmLen * 0.5)
    const rgb = Buffer.alloc(S * S * 3)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const X = cx - S / 2 + x, Y = cy - S / 2 + y
      if (X < 1 || Y < 1 || X >= W - 1 || Y >= H - 1) continue
      const i = Y * W + X
      let c = [img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]]
      if (m[i] >= 128) c = [c[0] * 0.55, Math.min(255, c[1] * 0.55 + 100), c[2] * 0.55]
      const g = gt[i] >= 128
      if (g && (gt[i - 1] < 128 || gt[i + 1] < 128 || gt[i - W] < 128 || gt[i + W] < 128)) c = [255, 0, 255]
      rgb.set(c.map(Math.round), (y * S + x) * 3)
    }
    tiles.push(rgb)
  }
}
const cols = 5, Wd = S * cols, Hd = S * Math.ceil(tiles.length / cols), sheet = Buffer.alloc(Wd * Hd * 3)
tiles.forEach((t, i) => { const ox = (i % cols) * S, oy = Math.floor(i / cols) * S; for (let y = 0; y < S; y++) t.copy(sheet, ((oy + y) * Wd + ox) * 3, y * S * 3, (y + 1) * S * 3) })
fs.writeFileSync(out, writePng(Wd, Hd, sheet))
console.log(tiles.length, 'tiles')
