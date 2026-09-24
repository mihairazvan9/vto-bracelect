/**
 * Browser half of the evaluation harness. Runs the real MediaPipe models on
 * recorded frames and hands their raw soft outputs back to Node (run.mjs),
 * which does all scoring and all post-processing experiments.
 *
 * Driven by puppeteer through window.evalApi.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'
import { decodeFixture } from '../../src/vto/replay/fixtureFormat.js'
import { ArmSegmenter } from '../../src/vto/perception/ArmSegmenter.js'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MULTICLASS = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite'
const BODY_SKIN = 2

let fileset
let multiclass
let clip = null
const frames = []
let ts = 0

async function init(delegate) {
  fileset = await FilesetResolver.forVisionTasks(WASM)
  multiclass = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MULTICLASS, delegate },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  })
  return true
}

async function loadClip(id) {
  const buf = await (await fetch(`/fixtures/${id}/recording.v1.bin`)).arrayBuffer()
  clip = decodeFixture(new Uint8Array(buf))
  frames.length = 0
  for (const fr of clip.frames) {
    const bmp = await createImageBitmap(new Blob([fr.payload], { type: 'image/jpeg' }))
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    c.getContext('2d').drawImage(bmp, 0, 0)
    // One camera frame as the app code takes it (CameraStream.takeFrame).
    frames.push({ canvas: c, frame: { image: c, width: bmp.width, height: bmp.height }, lm: fr.landmarks, W: bmp.width, H: bmp.height })
  }
  return frames.length
}

/** Soft body-skin probability (0..255) at frame resolution. */
function toFrameMask(conf, W, H, crop) {
  const out = new Uint8Array(W * H)
  const cw = conf.width
  const ch = conf.height
  const data = conf.getAsFloat32Array()
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Frame pixel -> source (crop) pixel -> mask pixel, bilinear.
      let u = (x + 0.5 - crop.x) / crop.size
      let v = (y + 0.5 - crop.y) / crop.size
      if (!crop.square) { u = (x + 0.5) / W; v = (y + 0.5) / H }
      if (u < 0 || v < 0 || u >= 1 || v >= 1) continue
      const fx = u * cw - 0.5
      const fy = v * ch - 0.5
      const x0 = Math.max(0, Math.floor(fx))
      const y0 = Math.max(0, Math.floor(fy))
      const x1 = Math.min(cw - 1, x0 + 1)
      const y1 = Math.min(ch - 1, y0 + 1)
      const ax = Math.min(1, Math.max(0, fx - x0))
      const ay = Math.min(1, Math.max(0, fy - y0))
      const p = data[y0 * cw + x0] * (1 - ax) * (1 - ay) + data[y0 * cw + x1] * ax * (1 - ay) +
        data[y1 * cw + x0] * (1 - ax) * ay + data[y1 * cw + x1] * ax * ay
      out[y * W + x] = Math.round(Math.min(1, Math.max(0, p)) * 255)
    }
  }
  return out
}

/** Square crop around the wrist, biased down the arm, `scale` palm lengths wide. */
function wristCrop(f, scale, bias = 0.35) {
  const lm = f.lm.map((p) => [p.x * f.W, p.y * f.H])
  const palm = [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + lm[i][0] / 5, a[1] + lm[i][1] / 5], [0, 0])
  const len = Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1])
  const d = Math.hypot(lm[0][0] - palm[0], lm[0][1] - palm[1]) || 1
  const cx = lm[0][0] + ((lm[0][0] - palm[0]) / d) * len * bias
  const cy = lm[0][1] + ((lm[0][1] - palm[1]) / d) * len * bias
  const size = Math.max(64, len * scale)
  return { x: cx - size / 2, y: cy - size / 2, size, square: true }
}

function runMulticlass(f, crop) {
  let src = f.canvas
  if (crop.square) {
    const c = new OffscreenCanvas(256, 256)
    const g = c.getContext('2d')
    g.fillStyle = '#000'
    g.fillRect(0, 0, 256, 256)
    g.drawImage(f.canvas, crop.x, crop.y, crop.size, crop.size, 0, 0, 256, 256)
    src = c
  }
  let out = null
  multiclass.segmentForVideo(src, ++ts, (r) => {
    out = toFrameMask(r.confidenceMasks[BODY_SKIN], f.W, f.H, crop)
    r.close?.()
  })
  return out
}

/**
 * The app's own ArmSegmenter, frame by frame as the engine drives it: the
 * network every `segEvery` frames, refinement every frame. Output is the
 * sampled refined mask at frame resolution (0 where unknown).
 */
async function runApp(segEvery) {
  const arm = new ArmSegmenter()
  const masks = []
  let ms = 0
  let t = 1000
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    t += 33
    if (!f.lm.some((p) => p.x || p.y)) { masks.push(null); continue }
    const t0 = performance.now()
    const geom = ArmSegmenter.geometry(f.lm, f.W, f.H)
    if (i % segEvery === 0) {
      arm.segment(multiclass, f.frame, ++ts, geom)
      arm.adoptNet() // same-frame, as this replay has always measured it
    }
    arm.netTime = t - (i % segEvery) * 33 // network age in the replay's clock
    arm.refine(f.frame, t, geom)
    ms += performance.now() - t0
    const out = new Uint8Array(f.W * f.H)
    for (let y = 0; y < f.H; y++) {
      for (let x = 0; x < f.W; x++) {
        const p = arm.sample((x + 0.5) / f.W, (y + 0.5) / f.H)
        out[y * f.W + x] = p > 0 ? Math.round(p) : 0
      }
    }
    masks.push(b64(out))
  }
  return { masks, msPerFrame: ms / frames.length }
}

const b64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}

window.evalApi = {
  init,
  loadClip,
  /** method: 'full' | 'roi:<scale>' | 'app:<segEvery>'. Returns base64 soft masks + timing. */
  async run(method) {
    const masks = []
    let ms = 0
    if (method.startsWith('app:')) return runApp(Number(method.slice(4)))
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      if (!f.lm.some((p) => p.x || p.y)) { masks.push(null); continue }
      const t0 = performance.now()
      let m
      if (method === 'full') m = runMulticlass(f, { square: false })
      else if (method.startsWith('roi:')) m = runMulticlass(f, wristCrop(f, Number(method.slice(4))))
      ms += performance.now() - t0
      masks.push(m ? b64(m) : null)
    }
    return { masks, msPerFrame: ms / frames.length }
  },
}
document.getElementById('status').textContent = 'ready'
