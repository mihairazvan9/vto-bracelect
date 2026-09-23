import { encodeFixture } from '../replay/fixtureFormat.js'
import { encodeArmMasks, sampleArmMask } from '../replay/armMaskFormat.js'
import { SEG_CLASS } from '../perception/models.js'

/**
 * The category mask VTO1 requires, derived from the live arm mask (see
 * below). Only older tools read it - the bench replays armmask.bin - so it is
 * kept small: at 256x144 it was half of every clip's size.
 */
const CATEGORY_W = 160
const CATEGORY_H = 90
/** VTO1 stores the clip id in 31 bytes. */
const MAX_CLIP_ID = 31
const ZERO_LANDMARKS = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))

/**
 * Turns a finished take into the files the benchmarks read, and puts them in
 * fixtures/<clipId>/:
 *
 *   recording.v1.bin  VTO1 clip (fixtureFormat.js): JPEG frame, MediaPipe image
 *                     and world landmarks, handedness, a category mask. Every
 *                     existing tool reads it unchanged.
 *   armmask.bin       the live pipeline's own soft arm mask per frame
 *                     (armMaskFormat.js) - what the bench replays by default.
 *   capture.json      scenario, lens, timing, per-frame framing flags.
 *
 * VTO1 requires a category mask; this one is the live arm mask thresholded
 * and projected to the full frame (skin / background). It exists for the
 * older tools - the soft mask in armmask.bin is the faithful one.
 */
export async function writeClip(take) {
  const { clipId, frames } = take
  if (clipId.length > MAX_CLIP_ID) throw new Error(`clip id longer than ${MAX_CLIP_ID}: ${clipId}`)

  const payloads = await Promise.all(
    frames.map(async (f) => new Uint8Array(await (await f.jpeg).arrayBuffer())),
  )
  const fixtureFrames = frames.map((f, i) => ({
    dtMs: f.dtMs,
    compression: 1,
    payload: payloads[i],
    landmarks: f.landmarks ?? ZERO_LANDMARKS,
    worldLandmarks: f.worldLandmarks ?? ZERO_LANDMARKS,
    handedness: f.handedness ?? { label: 'Unknown', score: 0 },
    categoryMask: categoryFromArmMask(f.armMask),
  }))

  const recording = encodeFixture({
    clipId,
    videoWidth: take.videoWidth,
    videoHeight: take.videoHeight,
    analysisWidth: take.analysisWidth,
    analysisHeight: take.analysisHeight,
    frames: fixtureFrames,
    categoryMaskWidth: CATEGORY_W,
    categoryMaskHeight: CATEGORY_H,
  })
  const maskSize = frames.find((f) => f.armMask)?.armMask.width ?? 160
  const armMasks = encodeArmMasks(maskSize, frames.map((f) => f.armMask))
  const meta = JSON.stringify(take.meta, null, 2)

  const files = [
    ['recording.v1.bin', recording],
    ['armmask.bin', armMasks],
    ['capture.json', new TextEncoder().encode(meta)],
  ]
  const bytes = files.reduce((s, [, b]) => s + b.length, 0)
  try {
    for (const [name, body] of files) await postFile(clipId, name, body)
    return { savedTo: `fixtures/${clipId}/`, bytes, downloaded: false }
  } catch (err) {
    // No dev server to write through (a preview build, a static host):
    // hand the files over as downloads instead.
    console.warn('[capture] dev save unavailable, downloading instead', err)
    for (const [name, body] of files) download(`${clipId}__${name}`, body)
    return { savedTo: null, bytes, downloaded: true }
  }
}

async function postFile(clipId, file, body) {
  const url = `/__fixtures/save?clip=${encodeURIComponent(clipId)}&file=${encodeURIComponent(file)}`
  const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
}

function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes]))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function categoryFromArmMask(armMask) {
  const out = new Uint8Array(CATEGORY_W * CATEGORY_H)
  if (!armMask) return out
  for (let j = 0; j < CATEGORY_H; j++) {
    const v = (j + 0.5) / CATEGORY_H
    for (let i = 0; i < CATEGORY_W; i++) {
      const p = sampleArmMask(armMask, (i + 0.5) / CATEGORY_W, v)
      if (p >= 128) out[j * CATEGORY_W + i] = SEG_CLASS.BODY_SKIN
    }
  }
  return out
}

/** A clip id: scenario plus local date and time, e.g. turn-0923-1542. */
export function makeClipId(scenarioId, date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  return `${scenarioId}-${stamp}`.slice(0, MAX_CLIP_ID)
}
