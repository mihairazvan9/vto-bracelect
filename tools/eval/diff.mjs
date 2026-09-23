/**
 * Disagreement sheet: green = both, red = candidate only (false skin),
 * blue = reference only (missed skin), inside a crop around the wrist.
 *   node diff.mjs <method> <out.png> [clip] [every]
 */
import fs from 'node:fs'
import { loadEvalClips, decodeRgb, methodMask, inZone } from './score.mjs'
import { writePng } from './png.mjs'
const [method, out, clipId, everyArg] = process.argv.slice(2)
const every = Number(everyArg) || 10
const tiles = []
for (const clip of loadEvalClips(clipId ? [clipId] : null)) {
  for (const frame of clip.frames) {
    if (frame.index % every) continue
    const pred = methodMask(method, clip.id, frame)
    if (!pred) continue
    const img = decodeRgb(frame.fr)
    const { W, H, gt, geom } = frame
    const S = 160
    const cx = Math.round(geom.wrist.x + geom.ax * geom.palmLen * 0.4)
    const cy = Math.round(geom.wrist.y + geom.ay * geom.palmLen * 0.4)
    const rgb = Buffer.alloc(S * S * 3)
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const X = cx - S / 2 + x, Y = cy - S / 2 + y
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      const i = Y * W + X
      let c = [img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]]
      if (inZone(geom, X, Y)) {
        const a = gt[i] >= 128, b = pred[i] >= 128
        if (a && !b) c = [40, 80, 255]
        else if (!a && b) c = [255, 40, 40]
        else if (a && b) c = [c[0] * 0.6, Math.min(255, c[1] * 0.6 + 90), c[2] * 0.6]
      }
      rgb.set(c.map(Math.round), (y * S + x) * 3)
    }
    tiles.push({ rgb, S, label: `${clip.id}:${frame.index}` })
  }
}
const cols = 6, S = 160, W = S * cols, H = S * Math.ceil(tiles.length / cols), sheet = Buffer.alloc(W * H * 3)
tiles.forEach((t, i) => { const ox = (i % cols) * S, oy = Math.floor(i / cols) * S; for (let y = 0; y < S; y++) t.rgb.copy(sheet, ((oy + y) * W + ox) * 3, y * S * 3, (y + 1) * S * 3) })
fs.writeFileSync(out, writePng(W, H, sheet))
console.log(tiles.map(t => t.label).join(' '))
