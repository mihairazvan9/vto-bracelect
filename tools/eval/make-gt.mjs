/**
 * Pseudo ground truth for the recorded clips: Segment Anything, prompted with
 * points on the hand and a little way up the forearm (positive) and on the
 * face and the nearest clothing (negative).
 *
 * SAM is far too slow for the browser, but it draws much sharper, more honest
 * boundaries than a 256x256 selfie model, which is exactly what is needed to
 * SCORE the fast browser methods. Every mask is reviewed on a contact sheet
 * before it is trusted (see sheet.mjs); rejected frames are listed in
 * gt/rejected.json.
 *
 *   node make-gt.mjs [clip ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { SamModel, AutoProcessor, RawImage } from '@huggingface/transformers'
import jpeg from 'jpeg-js'
import { decodeFixture } from '../../src/vto/replay/fixtureFormat.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(import.meta.dirname, 'gt')
const MODEL = process.env.SAM_MODEL || 'Xenova/sam-vit-base'
const FACE_SKIN = 3
const CLOTHES = 4

const clips = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(ROOT, 'fixtures'))

const model = await SamModel.from_pretrained(MODEL, { dtype: 'fp32' })
const processor = await AutoProcessor.from_pretrained(MODEL)

for (const clip of clips) {
  const file = path.join(ROOT, 'fixtures', clip, 'recording.v1.bin')
  if (!fs.existsSync(file)) continue
  const fx = decodeFixture(fs.readFileSync(file))
  fs.mkdirSync(path.join(OUT, clip), { recursive: true })
  const meta = []
  for (const fr of fx.frames) {
    const img = jpeg.decode(fr.payload, { useTArray: true, formatAsRGBA: false })
    const W = img.width
    const H = img.height
    const lm = fr.landmarks.map((p) => [p.x * W, p.y * H])
    if (!fr.landmarks.some((p) => p.x || p.y)) continue

    const palm = [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + lm[i][0] / 5, a[1] + lm[i][1] / 5], [0, 0])
    const palmLen = Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1])
    const ax = (lm[0][0] - palm[0]) / Math.hypot(lm[0][0] - palm[0], lm[0][1] - palm[1])
    const ay = (lm[0][1] - palm[1]) / Math.hypot(lm[0][0] - palm[0], lm[0][1] - palm[1])
    const inside = (p) => p[0] >= 1 && p[1] >= 1 && p[0] < W - 1 && p[1] < H - 1
    const pos = [palm, lm[0], lm[5], lm[17], [lm[0][0] + ax * palmLen * 0.45, lm[0][1] + ay * palmLen * 0.45]].filter(inside)

    // Negatives from the recorded segmentation: the face, and the clothing
    // pixel nearest the wrist - that is where arm/shirt confusion happens.
    const neg = []
    const mw = fx.categoryMaskWidth
    const mh = fx.categoryMaskHeight
    let fx0 = 0
    let fy0 = 0
    let fn = 0
    let best = null
    let bestD = Infinity
    for (let y = 0; y < mh; y += 2) {
      for (let x = 0; x < mw; x += 2) {
        const c = fr.categoryMask[y * mw + x]
        const X = (x / mw) * W
        const Y = (y / mh) * H
        if (c === FACE_SKIN) { fx0 += X; fy0 += Y; fn++ }
        if (c === CLOTHES) {
          const d = Math.hypot(X - lm[0][0], Y - lm[0][1])
          if (d < bestD && d > palmLen * 0.5) { bestD = d; best = [X, Y] }
        }
      }
    }
    if (fn > 30) neg.push([fx0 / fn, fy0 / fn])
    if (best && bestD < palmLen * 2) neg.push(best)

    const image = new RawImage(img.data, W, H, 3)
    const points = [...pos, ...neg]
    const labels = [...pos.map(() => 1), ...neg.map(() => 0)]
    const inputs = await processor(image, { input_points: [[points]], input_labels: [[labels]] })
    const out = await model(inputs)
    const masks = await processor.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes)
    const scores = out.iou_scores.data
    // masks[0]: [1, 3, H, W]. Take the best-scored of the three proposals.
    let k = 0
    for (let i = 1; i < 3; i++) if (scores[i] > scores[k]) k = i
    const m = masks[0].data
    const mask = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) mask[i] = m[k * W * H + i] ? 255 : 0
    fs.writeFileSync(path.join(OUT, clip, `${fr.index}.bin`), mask)
    meta.push({ index: fr.index, W, H, score: scores[k], proposal: k, pos, neg })
    process.stdout.write(`\r${clip} ${fr.index + 1}/${fx.frames.length}  iou~${scores[k].toFixed(2)}   `)
  }
  fs.writeFileSync(path.join(OUT, clip, 'meta.json'), JSON.stringify(meta))
  console.log()
}
