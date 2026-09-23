/**
 * Decoder for the VTO1 recorded-clip format, shared with the vto-bracelets
 * recorder (recorder.html there writes these). Each frame carries the JPEG
 * frame, MediaPipe image + world landmarks, handedness and the selfie
 * multiclass category mask, so the whole perception input can be replayed
 * headlessly.
 */
/** @typedef {'front'|'side'|'rotation'|'fast-translation'|'dim-light'|'partial-sleeve'|string} FixtureClipId */

export const FIXTURE_MAGIC = 0x31505456 // 'VTO1' little-endian
export const FIXTURE_VERSION = 1
export const CATEGORY_MASK_SIZE = 256

const HEADER_BYTES = 64

const writeString = (view, offset, value) => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  view.setUint8(offset, bytes.length)
  new Uint8Array(view.buffer, offset + 1, bytes.length).set(bytes)
  return 1 + bytes.length
}

const readString = (view, offset) => {
  const length = view.getUint8(offset)
  const decoder = new TextDecoder()
  return {
    value: decoder.decode(new Uint8Array(view.buffer, offset + 1, length)),
    next: offset + 1 + length,
  }
}

/**
 * @param {object} header
 * @param {Array<object>} frames
 */
export const encodeFixture = ({
  clipId = 'clip',
  videoWidth,
  videoHeight,
  analysisWidth,
  analysisHeight,
  frames,
  // ImageSegmenter returns the category mask at the input image size, not the
  // model's internal 256×256. Record the actual size instead of assuming it.
  categoryMaskWidth = CATEGORY_MASK_SIZE,
  categoryMaskHeight = CATEGORY_MASK_SIZE,
}) => {
  if (!frames?.length) throw new TypeError('encodeFixture requires at least one frame')
  if (!(categoryMaskWidth > 0) || !(categoryMaskHeight > 0)) {
    throw new TypeError('encodeFixture requires positive categoryMask dimensions')
  }
  const parts = []
  const header = new ArrayBuffer(HEADER_BYTES)
  const view = new DataView(header)
  view.setUint32(0, FIXTURE_MAGIC, true)
  view.setUint16(4, FIXTURE_VERSION, true)
  view.setUint16(6, 0, true)
  view.setUint32(8, frames.length, true)
  view.setUint32(12, videoWidth, true)
  view.setUint32(16, videoHeight, true)
  view.setUint32(20, analysisWidth, true)
  view.setUint32(24, analysisHeight, true)
  view.setUint16(28, categoryMaskWidth, true)
  view.setUint16(30, categoryMaskHeight, true)
  writeString(view, 32, clipId)
  parts.push(new Uint8Array(header))

  for (const frame of frames) {
    const labelBytes = new TextEncoder().encode(frame.handedness?.label ?? 'Unknown')
    const category = frame.categoryMask
    const expectedCategoryBytes = categoryMaskWidth * categoryMaskHeight
    if (!ArrayBuffer.isView(category) || category.BYTES_PER_ELEMENT !== 1 || category.length !== expectedCategoryBytes) {
      throw new TypeError(
        `Each frame needs a ${categoryMaskWidth}×${categoryMaskHeight} categoryMask byte array `
        + `(${expectedCategoryBytes} bytes), received ${category?.length ?? 'nothing'}`,
      )
    }
    const chunkSize = 2 + 1 + 1 + 4 + frame.payload.length + 504 + 4 + 1 + labelBytes.length + category.length
    const chunk = new Uint8Array(chunkSize)
    const chunkView = new DataView(chunk.buffer)
    let offset = 0
    chunkView.setUint16(offset, frame.dtMs ?? 33, true)
    offset += 2
    chunkView.setUint8(offset, frame.compression ?? 0)
    offset += 1
    chunkView.setUint8(offset, 0)
    offset += 1
    chunkView.setUint32(offset, frame.payload.length, true)
    offset += 4
    chunk.set(frame.payload, offset)
    offset += frame.payload.length

    for (const landmarkSet of [frame.landmarks, frame.worldLandmarks]) {
      for (const point of landmarkSet) {
        chunkView.setFloat32(offset, point.x, true)
        chunkView.setFloat32(offset + 4, point.y, true)
        chunkView.setFloat32(offset + 8, point.z ?? 0, true)
        offset += 12
      }
    }

    chunkView.setFloat32(offset, frame.handedness?.score ?? 0, true)
    offset += 4
    chunkView.setUint8(offset, labelBytes.length)
    offset += 1
    chunk.set(labelBytes, offset)
    offset += labelBytes.length
    chunk.set(category, offset)
    parts.push(chunk)
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    output.set(part, cursor)
    cursor += part.length
  }
  return output
}

export const decodeFixture = (input) => {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== FIXTURE_MAGIC) throw new Error('Invalid fixture magic')
  if (view.getUint16(4, true) !== FIXTURE_VERSION) throw new Error('Unsupported fixture version')
  const frameCount = view.getUint32(8, true)
  const videoWidth = view.getUint32(12, true)
  const videoHeight = view.getUint32(16, true)
  const analysisWidth = view.getUint32(20, true)
  const analysisHeight = view.getUint32(24, true)
  const categoryMaskWidth = view.getUint16(28, true)
  const categoryMaskHeight = view.getUint16(30, true)
  const clip = readString(view, 32)
  let offset = HEADER_BYTES

  /** @type {Array<object>} */
  const frames = []
  for (let index = 0; index < frameCount; index += 1) {
    const dtMs = view.getUint16(offset, true)
    offset += 2
    const compression = view.getUint8(offset)
    offset += 1
    offset += 1
    const payloadLength = view.getUint32(offset, true)
    offset += 4
    const payload = bytes.subarray(offset, offset + payloadLength)
    offset += payloadLength

    const readLandmarks = () => {
      const landmarks = []
      for (let point = 0; point < 21; point += 1) {
        landmarks.push({
          x: view.getFloat32(offset, true),
          y: view.getFloat32(offset + 4, true),
          z: view.getFloat32(offset + 8, true),
        })
        offset += 12
      }
      return landmarks
    }
    const landmarks = readLandmarks()
    const worldLandmarks = readLandmarks()
    const handednessScore = view.getFloat32(offset, true)
    offset += 4
    const labelLength = view.getUint8(offset)
    offset += 1
    const label = new TextDecoder().decode(bytes.subarray(offset, offset + labelLength))
    offset += labelLength
    const categoryMask = bytes.slice(offset, offset + categoryMaskWidth * categoryMaskHeight)
    offset += categoryMaskWidth * categoryMaskHeight

    frames.push({
      index,
      dtMs,
      compression,
      payload,
      landmarks,
      worldLandmarks,
      handedness: { label, score: handednessScore },
      categoryMask,
    })
  }

  return {
    clipId: clip.value,
    videoWidth,
    videoHeight,
    analysisWidth,
    analysisHeight,
    categoryMaskWidth,
    categoryMaskHeight,
    frameCount,
    frames,
  }
}

export const EXPECTED_CLIP_IDS = [
  'front',
  'side',
  'rotation',
  'fast-translation',
  'dim-light',
  'partial-sleeve',
]
