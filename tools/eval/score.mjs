/**
 * Scores segmentation candidates against the SAM pseudo ground truth, inside
 * the region that matters for a bracelet: the wrist and ~1 palm length of
 * forearm. Besides mask overlap it measures what the tracker actually
 * consumes: the forearm axis angle and the arm half-width, both read with the
 * app's own ArmProfiler from the candidate mask and from the ground truth.
 *
 *   node score.mjs [method ...]         methods = folders under out/, plus
 *                                       'recorded' (the clip's own mask)
 *
 * Also exported for experiments that post-process candidates in Node.
 */
import fs from 'node:fs'
import path from 'node:path'
import jpeg from 'jpeg-js'
import { decodeFixture } from '../../src/vto/replay/fixtureFormat.js'
import { ArmProfiler } from '../../src/vto/wrist/ArmProfiler.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const GT = path.join(import.meta.dirname, 'gt')
const OUT = path.join(import.meta.dirname, 'out')
const FACE_SKIN = 3
const BODY_SKIN = 2

export const rejected = []

export function loadEvalClips(only = null) {
  const clips = []
  for (const id of fs.readdirSync(GT)) {
    if (only && !only.includes(id)) continue
    const metaFile = path.join(GT, id, 'meta.json')
    if (!fs.existsSync(metaFile)) continue
    const fx = decodeFixture(fs.readFileSync(path.join(ROOT, 'fixtures', id, 'recording.v1.bin')))
    const frames = []
    for (const m of JSON.parse(fs.readFileSync(metaFile, 'utf8'))) {
      const fr = fx.frames[m.index]
      const gt = fs.readFileSync(path.join(GT, id, `${m.index}.bin`))
      const W = m.W
      const H = m.H
      // Reject reference masks that leaked sideways off the arm (into the
      // face or torso): reference pixels in the bracelet zone that sit far
      // from the hand's axis line.
      const geom = frameGeometry(fr, W, H)
      let zone = 0
      let leak = 0
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!gt[y * W + x] || !inZone(geom, x, y)) continue
          zone++
          const lateral = Math.abs((x - geom.wrist.x) * -geom.ay + (y - geom.wrist.y) * geom.ax)
          if (lateral > 0.7 * geom.palmLen) leak++
        }
      }
      if (!zone || leak > zone * 0.03) {
        rejected.push(`${id}:${m.index}`)
        continue
      }
      frames.push({ index: m.index, W, H, gt, fr, geom })
    }
    clips.push({ id, fx, frames })
  }
  return clips
}

export function decodeRgb(fr) {
  return jpeg.decode(fr.payload, { useTArray: true, formatAsRGBA: false })
}

function frameGeometry(fr, W, H) {
  const lm = fr.landmarks.map((p) => ({ x: p.x * W, y: p.y * H }))
  const palm = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + lm[i].x / 5, y: a.y + lm[i].y / 5 }), { x: 0, y: 0 })
  const palmLen = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y)
  const d = Math.hypot(lm[0].x - palm.x, lm[0].y - palm.y) || 1
  return { lm, wrist: lm[0], palmLen, ax: (lm[0].x - palm.x) / d, ay: (lm[0].y - palm.y) / d }
}

/** Bracelet zone: within 1.1 palm lengths of the wrist, on the forearm side. */
export function inZone(g, x, y) {
  const dx = x - g.wrist.x
  const dy = y - g.wrist.y
  if (dx * dx + dy * dy > (1.1 * g.palmLen) ** 2) return false
  return dx * g.ax + dy * g.ay > -0.15 * g.palmLen
}

const profiler = new ArmProfiler()

/** Bilinear lookup of a 0..255 map; -1 outside the frame. */
export function bilinear(mask, W, H, x, y) {
  const fx = x - 0.5
  const fy = y - 0.5
  if (fx < -0.5 || fy < -0.5 || fx > W - 0.5 || fy > H - 0.5) return -1
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)))
  const x1 = Math.min(W - 1, x0 + 1)
  const y1 = Math.min(H - 1, y0 + 1)
  const ax = Math.min(1, Math.max(0, fx - x0))
  const ay = Math.min(1, Math.max(0, fy - y0))
  return mask[y0 * W + x0] * (1 - ax) * (1 - ay) + mask[y0 * W + x1] * ax * (1 - ay) +
    mask[y1 * W + x0] * (1 - ax) * ay + mask[y1 * W + x1] * ax * ay
}

/** Arm axis + half-widths from a binary mask, in pixels, via the app's profiler. */
function armOf(mask, W, H, g, seed = null) {
  const sample = (x, y) => bilinear(mask, W, H, x, y)
  // mmPerPx = palmLen/85 makes the profiler's millimetre constants meaningful.
  const mmPerPx = 85 / g.palmLen
  const s = seed || { dx: g.ax, dy: g.ay }
  const r = profiler.measure(sample, g.wrist, s.dx, s.dy, mmPerPx, 26, { reachMm: 100 })
  if (!r || r.confidence < 0.15) return null
  const widths = [20, 40, 60].map((mm) => {
    const o = { halfWidthMm: 0, offsetMm: 0 }
    return profiler.sectionAt(mm, o) ? o.halfWidthMm / mmPerPx : NaN
  })
  return { dx: r.dx, dy: r.dy, widths }
}

export function scoreMask(frame, pred) {
  const { W, H, gt, geom } = frame
  let inter = 0
  let union = 0
  const edgeGt = []
  const edgePr = []
  const isEdge = (m, i, x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1 &&
    (m[i] >= 128) !== (m[i - 1] >= 128 || m[i + 1] >= 128 || m[i - W] >= 128 || m[i + W] >= 128 ? m[i] >= 128 : !(m[i] >= 128)) ||
    ((m[i] >= 128) && (m[i - 1] < 128 || m[i + 1] < 128 || m[i - W] < 128 || m[i + W] < 128))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inZone(geom, x, y)) continue
      const i = y * W + x
      const a = gt[i] >= 128
      const b = pred[i] >= 128
      if (a && b) inter++
      if (a || b) union++
      if (a && isEdge(gt, i, x, y)) edgeGt.push(i)
      if (b && isEdge(pred, i, x, y)) edgePr.push(i)
    }
  }
  // Boundary F1 at 2 px tolerance.
  const near = (list, m) => {
    let hit = 0
    for (const i of list) {
      const x = i % W
      const y = (i / W) | 0
      let ok = false
      for (let dy = -2; dy <= 2 && !ok; dy++) {
        for (let dx = -2; dx <= 2 && !ok; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
          const j = yy * W + xx
          ok = m === gt ? isEdge(gt, j, xx, yy) && gt[j] >= 128 : isEdge(pred, j, xx, yy) && pred[j] >= 128
        }
      }
      if (ok) hit++
    }
    return list.length ? hit / list.length : 0
  }
  const precision = near(edgePr, gt)
  const recall = near(edgeGt, pred)
  const bf = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  const armGt = armOf(gt, W, H, geom)
  const armPr = armGt ? armOf(pred, W, H, geom, armGt) : null
  let angleDeg = NaN
  let widthErrPct = NaN
  if (armGt && armPr) {
    angleDeg = (Math.acos(Math.min(1, Math.abs(armGt.dx * armPr.dx + armGt.dy * armPr.dy))) * 180) / Math.PI
    const errs = armGt.widths
      .map((w, k) => (Number.isFinite(w) && Number.isFinite(armPr.widths[k]) ? Math.abs(armPr.widths[k] - w) / w : NaN))
      .filter(Number.isFinite)
    if (errs.length) widthErrPct = (100 * errs.reduce((a, b) => a + b, 0)) / errs.length
  }
  return { iou: union ? inter / union : 1, bf, angleDeg, widthErrPct, armFound: !!armPr, gtArm: !!armGt }
}

export function recordedMask(frame) {
  const { W, H, fr } = frame
  const out = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) out[i] = fr.categoryMask[i] === BODY_SKIN ? 255 : 0
  return out
}

export function methodMask(method, clipId, frame) {
  if (method === 'recorded') return recordedMask(frame)
  const file = path.join(OUT, method, clipId, `${frame.index}.bin`)
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

export function summarize(rows) {
  const mean = (k) => {
    const v = rows.map((r) => r[k]).filter(Number.isFinite)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN
  }
  const p90 = (k) => {
    const v = rows.map((r) => r[k]).filter(Number.isFinite).sort((a, b) => a - b)
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : NaN
  }
  const withGt = rows.filter((r) => r.gtArm)
  return {
    n: rows.length,
    iou: mean('iou'),
    bf: mean('bf'),
    angle: mean('angleDeg'),
    angleP90: p90('angleDeg'),
    width: mean('widthErrPct'),
    widthP90: p90('widthErrPct'),
    armFound: withGt.length ? withGt.filter((r) => r.armFound).length / withGt.length : NaN,
  }
}

export function printTable(results) {
  console.log('method              clip              n    IoU    bndF1  axis°  axis°p90  width%  width%p90  armFound')
  for (const [key, s] of Object.entries(results)) {
    const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ')
    console.log(`${key.padEnd(38)} ${String(s.n).padStart(3)}  ${f(s.iou)}  ${f(s.bf)}  ${f(s.angle, 1).padStart(5)}  ${f(s.angleP90, 1).padStart(8)}  ${f(s.width, 1).padStart(6)}  ${f(s.widthP90, 1).padStart(9)}  ${f(s.armFound, 2).padStart(8)}`)
  }
}

if (process.argv[1] && process.argv[1].endsWith('score.mjs')) {
  const methods = process.argv.slice(2).length ? process.argv.slice(2) : ['recorded', ...fs.readdirSync(OUT)]
  const clips = loadEvalClips()
  const results = {}
  for (const method of methods) {
    const all = []
    for (const clip of clips) {
      const rows = []
      for (const frame of clip.frames) {
        const pred = methodMask(method, clip.id, frame)
        if (pred) rows.push(scoreMask(frame, pred))
      }
      all.push(...rows)
      results[`${method.padEnd(18)}  ${clip.id}`] = summarize(rows)
    }
    results[`${method.padEnd(18)}  ALL`] = summarize(all)
  }
  printTable(results)
  console.log(`
reference frames rejected as leaked: ${rejected.length ? rejected.join(' ') : 'none'}`)
}
