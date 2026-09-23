/**
 * Rendered twin width vs the real arm width at several stations down the arm
 * (the occluder is built from exactly these cross-sections).
 *   node widths.mjs [maskMethod=app_3] [clip ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadEvalClips, bilinear } from './score.mjs'
import { CameraModel } from '../../src/vto/camera/CameraModel.js'
import { WristObserver } from '../../src/vto/wrist/WristObserver.js'
import { WristTracker } from '../../src/vto/wrist/WristTracker.js'
import { LandmarkSourceBuilder } from '../../src/vto/wrist/LandmarkSources.js'
import { ArmProfiler } from '../../src/vto/wrist/ArmProfiler.js'
const method = process.argv[2] || 'app_3'
const only = process.argv.slice(3)
const OUT = path.join(import.meta.dirname, 'out')
const gtP = new ArmProfiler()
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN }
for (const clip of loadEvalClips(only.length ? only : null)) {
  const cam = new CameraModel()
  cam.setResolution(clip.fx.videoWidth, clip.fx.videoHeight, false)
  const k = clip.fx.analysisWidth / clip.fx.videoWidth
  const ob = new WristObserver(cam), tr = new WristTracker(cam), src = new LandmarkSourceBuilder()
  const byIndex = new Map(clip.frames.map((f) => [f.index, f]))
  const ratios = {}
  let t = 1000
  for (const fr of clip.fx.frames) {
    t += 33
    if (!fr.landmarks.some((p) => p.x || p.y)) continue
    const file = path.join(OUT, method, clip.id, `${fr.index}.bin`)
    const data = fs.existsSync(file) ? fs.readFileSync(file) : null
    const W = clip.fx.analysisWidth, H = clip.fx.analysisHeight
    const per = data ? { armMask: { data, width: W, height: H }, sampleMask: (u, v) => bilinear(data, W, H, u * W, v * H) } : { armMask: null, sampleMask: () => -1 }
    const o = ob.observe(src.build({ landmarks: [fr.landmarks], worldLandmarks: [fr.worldLandmarks], handedness: [[{ categoryName: 'Left', score: 1 }]] }, cam), per, t)
    if (o) tr.ingest(o)
    const twin = tr.update(t, 1 / 30, t)
    const frame = byIndex.get(fr.index)
    if (!twin.valid || !frame) continue
    const g = frame.geom, mm = 85 / g.palmLen
    const r = gtP.measure((x, y) => bilinear(frame.gt, frame.W, frame.H, x, y), g.wrist, g.ax, g.ay, mm, 26, { reachMm: 100 })
    if (!r) continue
    for (const [i, sec] of twin.crossSections.entries()) {
      const q = { halfWidthMm: 0, offsetMm: 0 }
      if (!gtP.sectionAt(sec.s, q)) continue
      const realPx = (2 * q.halfWidthMm) / mm
      let lo = Infinity, hi = -Infinity
      for (let j = 0; j < 32; j++) {
        const a = (j / 32) * Math.PI * 2
        const pt = cam.project(sec.center.clone().addScaledVector(twin.radialAxis, Math.cos(a) * sec.a).addScaledVector(twin.dorsalAxis, Math.sin(a) * sec.b))
        const across = (pt.x * k) * -r.dy + (pt.y * k) * r.dx
        lo = Math.min(lo, across); hi = Math.max(hi, across)
      }
      ;(ratios[sec.s] ||= []).push((hi - lo) / realPx)
    }
  }
  console.log(clip.id.padEnd(9), Object.entries(ratios).map(([s, v]) => `s${s}:${med(v).toFixed(2)}`).join('  '))
}
