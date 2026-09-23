/**
 * Contact sheet: camera frames with a mask outline drawn on top, for eyeballing
 * ground truth and candidate masks.
 *
 *   node sheet.mjs <clip> <maskDir> <out.png> [every=6]
 *
 * maskDir holds <index>.bin byte masks at frame resolution (255 = arm).
 */
import fs from 'node:fs'
import path from 'node:path'
import jpeg from 'jpeg-js'
import { decodeFixture } from '../../src/vto/replay/fixtureFormat.js'
import { writePng } from './png.mjs'

const [clip, maskDir, out, everyArg] = process.argv.slice(2)
const every = Number(everyArg) || 6
const ROOT = path.resolve(import.meta.dirname, '../..')
const fx = decodeFixture(fs.readFileSync(path.join(ROOT, 'fixtures', clip, 'recording.v1.bin')))

const tiles = []
for (const fr of fx.frames) {
  if (fr.index % every) continue
  const file = path.join(maskDir, `${fr.index}.bin`)
  if (!fs.existsSync(file)) continue
  const img = jpeg.decode(fr.payload, { useTArray: true, formatAsRGBA: false })
  const { width: W, height: H } = img
  const m = fs.readFileSync(file)
  const rgb = Buffer.from(img.data)
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const on = m[i] > 127
      const edge = on && (m[i - 1] <= 127 || m[i + 1] <= 127 || m[i - W] <= 127 || m[i + W] <= 127)
      if (edge) rgb.set([255, 0, 255], i * 3)
      else if (on) rgb[i * 3 + 1] = Math.min(255, rgb[i * 3 + 1] + 40)
    }
  }
  tiles.push({ W, H, rgb })
}
const cols = 3
const W = tiles[0].W * cols
const H = tiles[0].H * Math.ceil(tiles.length / cols)
const sheet = Buffer.alloc(W * H * 3)
tiles.forEach((t, i) => {
  const ox = (i % cols) * t.W
  const oy = Math.floor(i / cols) * t.H
  for (let y = 0; y < t.H; y++) t.rgb.copy(sheet, ((oy + y) * W + ox) * 3, y * t.W * 3, (y + 1) * t.W * 3)
})
fs.writeFileSync(out, writePng(W, H, sheet))
console.log(`${tiles.length} tiles -> ${out}`)
