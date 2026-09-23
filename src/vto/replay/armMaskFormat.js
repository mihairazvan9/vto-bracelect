/**
 * Sidecar to a VTO1 clip (fixtureFormat.js): the arm mask the LIVE app used
 * on each frame - ArmSegmenter's refined soft mask over its region of
 * interest - so a replay sees exactly what the pipeline saw, instead of the
 * clip's hard full-frame category mask.
 *
 * Written by the in-app recorder (src/vto/capture) as armmask.bin next to
 * recording.v1.bin; read by scripts/bench.mjs. Plain typed arrays, so it runs
 * in the browser and in Node.
 *
 *   header  16 B: magic 'ARM1', version u16, mask size u16, frame count u32, reserved u32
 *   frame   20 B + size^2: valid u8, 3 B pad, roi x/y/w/h f32 (normalised RAW
 *           video coords, before any display mirroring), then the mask bytes
 *           (0..255 skin probability, row 0 = top of the image)
 */

export const ARM_MASK_MAGIC = 0x314d5241 // 'ARM1' little-endian
export const ARM_MASK_VERSION = 1

const HEADER_BYTES = 16
const FRAME_HEAD_BYTES = 20

/**
 * @param {number} size mask side in pixels
 * @param {Array<{data:Uint8Array, roi:{x:number,y:number,w:number,h:number}}|null>} frames
 *        one entry per clip frame; null where the app had no mask
 */
export function encodeArmMasks(size, frames) {
  const frameBytes = FRAME_HEAD_BYTES + size * size
  const out = new Uint8Array(HEADER_BYTES + frames.length * frameBytes)
  const view = new DataView(out.buffer)
  view.setUint32(0, ARM_MASK_MAGIC, true)
  view.setUint16(4, ARM_MASK_VERSION, true)
  view.setUint16(6, size, true)
  view.setUint32(8, frames.length, true)
  let offset = HEADER_BYTES
  for (const frame of frames) {
    if (frame) {
      if (frame.data.length !== size * size) throw new TypeError(`arm mask must be ${size}x${size}`)
      view.setUint8(offset, 1)
      view.setFloat32(offset + 4, frame.roi.x, true)
      view.setFloat32(offset + 8, frame.roi.y, true)
      view.setFloat32(offset + 12, frame.roi.w, true)
      view.setFloat32(offset + 16, frame.roi.h, true)
      out.set(frame.data, offset + FRAME_HEAD_BYTES)
    }
    offset += frameBytes
  }
  return out
}

/** @returns {{size:number, frames:Array<{data:Uint8Array, width:number, height:number, roi:object}|null>}} */
export function decodeArmMasks(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== ARM_MASK_MAGIC) throw new Error('Invalid arm mask magic')
  if (view.getUint16(4, true) !== ARM_MASK_VERSION) throw new Error('Unsupported arm mask version')
  const size = view.getUint16(6, true)
  const count = view.getUint32(8, true)
  const frameBytes = FRAME_HEAD_BYTES + size * size
  const frames = []
  let offset = HEADER_BYTES
  for (let i = 0; i < count; i++) {
    if (view.getUint8(offset)) {
      frames.push({
        data: bytes.subarray(offset + FRAME_HEAD_BYTES, offset + frameBytes),
        width: size,
        height: size,
        roi: {
          x: view.getFloat32(offset + 4, true),
          y: view.getFloat32(offset + 8, true),
          w: view.getFloat32(offset + 12, true),
          h: view.getFloat32(offset + 16, true),
        },
      })
    } else {
      frames.push(null)
    }
    offset += frameBytes
  }
  return { size, frames }
}

/**
 * Skin probability 0..255 at raw normalised video coords, bilinear - the same
 * lookup ArmSegmenter.sample() does live - or -1 outside the region of
 * interest (unknown, which the arm profiler reads as "out of view").
 */
export function sampleArmMask(mask, u, v) {
  if (!mask || u < 0 || v < 0 || u > 1 || v > 1) return -1
  const n = mask.width
  const fx = ((u - mask.roi.x) / mask.roi.w) * n - 0.5
  const fy = ((v - mask.roi.y) / mask.roi.h) * n - 0.5
  if (fx < -0.5 || fy < -0.5 || fx > n - 0.5 || fy > n - 0.5) return -1
  const x0 = fx < 0 ? 0 : fx | 0
  const y0 = fy < 0 ? 0 : fy | 0
  const x1 = x0 + 1 < n ? x0 + 1 : x0
  const y1 = y0 + 1 < n ? y0 + 1 : y0
  const ax = Math.min(1, Math.max(0, fx - x0))
  const ay = Math.min(1, Math.max(0, fy - y0))
  const d = mask.data
  return (
    d[y0 * n + x0] * (1 - ax) * (1 - ay) +
    d[y0 * n + x1] * ax * (1 - ay) +
    d[y1 * n + x0] * (1 - ax) * ay +
    d[y1 * n + x1] * ax * ay
  )
}
