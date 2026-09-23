/**
 * Scores MaskRefiner on top of each network output, over a parameter sweep.
 *
 *   node refine-eval.mjs [source=full] [--save name]
 *
 * The refiner works on the wrist ROI only - the same crop the app uses.
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadEvalClips, decodeRgb, methodMask, scoreMask, summarize, printTable } from './score.mjs'
import { MaskRefiner } from '../../src/vto/perception/MaskRefiner.js'

const source = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'full'
const saveIdx = process.argv.indexOf('--save')
const saveName = saveIdx > 0 ? process.argv[saveIdx + 1] : null

export function roiOf(frame, pad = 1.5) {
  const g = frame.geom
  const half = g.palmLen * pad
  const x0 = Math.max(0, Math.floor(g.wrist.x - half))
  const y0 = Math.max(0, Math.floor(g.wrist.y - half))
  const x1 = Math.min(frame.W, Math.ceil(g.wrist.x + half))
  const y1 = Math.min(frame.H, Math.ceil(g.wrist.y + half))
  return { x0, y0, w: x1 - x0, h: y1 - y0 }
}

export function refineFrame(refiner, frame, soft, rgbImg) {
  const { W } = frame
  const roi = roiOf(frame)
  const n = roi.w * roi.h
  const rgb = new Uint8Array(n * 3)
  const prob = new Float32Array(n)
  for (let y = 0; y < roi.h; y++) {
    for (let x = 0; x < roi.w; x++) {
      const si = (roi.y0 + y) * W + roi.x0 + x
      const di = y * roi.w + x
      rgb[di * 3] = rgbImg.data[si * 3]
      rgb[di * 3 + 1] = rgbImg.data[si * 3 + 1]
      rgb[di * 3 + 2] = rgbImg.data[si * 3 + 2]
      prob[di] = soft[si] / 255
    }
  }
  const out = refiner.refine(rgb, 3, prob, roi.w, roi.h)
  const mask = Uint8Array.from(soft)
  for (let y = 0; y < roi.h; y++) {
    for (let x = 0; x < roi.w; x++) {
      mask[(roi.y0 + y) * W + roi.x0 + x] = Math.round(out[y * roi.w + x] * 255)
    }
  }
  return mask
}

const configs = {
  none: null,
  gf_gray_r4: { colourWeight: 0, radius: 4, eps: 2e-3, colourGuide: false },
  gf_col_r4: { colourWeight: 0, radius: 4, eps: 2e-3, colourGuide: true },
  gf_col_r6: { colourWeight: 0, radius: 6, eps: 1e-3, colourGuide: true },
  col_only: { colourWeight: 0.6, radius: 0 },
  col_gf_r4: { colourWeight: 0.6, radius: 4, eps: 2e-3, colourGuide: true },
  col1_gf_r4: { colourWeight: 1.0, radius: 4, eps: 2e-3, colourGuide: true },
  col_gf_r6: { colourWeight: 0.6, radius: 6, eps: 1e-3, colourGuide: true },
  col_gf_r3e4: { colourWeight: 0.6, radius: 3, eps: 1e-4, colourGuide: true },
  col_gray_r3e4: { colourWeight: 0.6, radius: 3, eps: 1e-4, colourGuide: false },
  col_gray_r3e3: { colourWeight: 0.6, radius: 3, eps: 1e-3, colourGuide: false },
  close2: { colourWeight: 0.6, radius: 3, eps: 1e-3, colourGuide: false, closeRadius: 2 },
  close3: { colourWeight: 0.6, radius: 3, eps: 1e-3, colourGuide: false, closeRadius: 3 },
  close5: { colourWeight: 0.6, radius: 3, eps: 1e-3, colourGuide: false, closeRadius: 5 },
}

if (process.argv[1].endsWith('refine-eval.mjs')) {
  const clips = loadEvalClips()
  const results = {}
  for (const [name, cfg] of Object.entries(configs)) {
    if (saveName && name !== saveName) continue
    const refiner = cfg ? new MaskRefiner(cfg) : null
    const all = []
    const t0 = performance.now()
    let count = 0
    for (const clip of clips) {
      for (const frame of clip.frames) {
        let soft = methodMask(source, clip.id, frame)
        if (!soft) continue
        let mask = soft
        if (refiner) mask = refineFrame(refiner, frame, soft, decodeRgb(frame.fr))
        count++
        all.push(scoreMask(frame, mask))
        if (saveName) {
          const dir = path.join(import.meta.dirname, 'out', `${source}+${name}`, clip.id)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, `${frame.index}.bin`), mask)
        }
      }
    }
    results[`${source}+${name}`.padEnd(20) + '  ALL'] = summarize(all)
    process.stderr.write(`${name}: ${((performance.now() - t0) / Math.max(1, count)).toFixed(1)} ms/frame incl. scoring\n`)
  }
  printTable(results)
}
