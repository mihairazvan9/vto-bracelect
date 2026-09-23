import * as THREE from 'three'
import { HAND } from '../perception/models.js'

/**
 * Normalises a hand detection into the input the wrist observer consumes.
 *
 * The indirection is kept deliberately: the observer works against a landmark
 * source rather than a specific detector, so swapping or adding one later is a
 * change in this file only. Pose landmarking briefly lived here as a second
 * source and was removed - see the note in perception/models.js.
 */

/** Weights for the position solve. Metacarpal heads are the steadiest points. */
const HAND_SOLVE = [
  { i: HAND.WRIST, w: 1.4 },
  { i: HAND.THUMB_CMC, w: 0.7 },
  { i: HAND.THUMB_MCP, w: 0.6 },
  { i: HAND.INDEX_MCP, w: 1.2 },
  { i: HAND.MIDDLE_MCP, w: 1.2 },
  { i: HAND.RING_MCP, w: 1.2 },
  { i: HAND.PINKY_MCP, w: 1.2 },
]

export class LandmarkSourceBuilder {
  constructor() {
    // Reused between frames: the observer runs on every detection, so a fresh
    // point set per frame would be pure garbage pressure.
    this._world = Array.from({ length: 21 }, () => new THREE.Vector3())
    this._px = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }))
  }

  /**
   * @param {object|null} handResult HandLandmarker result
   * @param {import('../camera/CameraModel.js').CameraModel} cam
   * @returns {object|null} a source, or null when nothing usable was detected
   */
  build(handResult, cam) {
    const lm = handResult?.landmarks?.[0]
    const wlm = handResult?.worldLandmarks?.[0]
    if (!lm || !wlm) return null

    const mirrorSign = cam.mirrored ? -1 : 1
    for (let i = 0; i < 21; i++) {
      cam.toDisplayPx(lm[i].x, lm[i].y, this._px[i])
      // MediaPipe world landmarks: metres, +x right, +y down, +z away from camera.
      this._world[i].set(mirrorSign * wlm[i].x * 1000, -wlm[i].y * 1000, -wlm[i].z * 1000)
    }

    const entry = handResult.handedness?.[0]?.[0] ?? handResult.handednesses?.[0]?.[0]
    let handedness = entry?.categoryName ?? 'Right'
    // Mirroring the frame mirrors apparent handedness; we report what the user sees.
    if (cam.mirrored) handedness = handedness === 'Right' ? 'Left' : 'Right'

    return {
      origin: 'hand',
      world: this._world,
      px: this._px,
      key: {
        wrist: HAND.WRIST,
        index: HAND.INDEX_MCP,
        pinky: HAND.PINKY_MCP,
        thumb: HAND.THUMB_CMC,
      },
      solve: HAND_SOLVE,
      /**
       * Knuckles measured FROM the wrist, for sizing. These spans run along the
       * hand, so they barely move when the fingers splay - unlike the span
       * across the knuckles, which changes a great deal.
       */
      scaleSet: [HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP],
      /**
       * Averaged to locate the palm; palm -> wrist is the hand axis. All four
       * metacarpal heads, so their mean runs along the third metacarpal, which
       * is the one that lines up with the radius on a straight wrist.
       */
      palmCentre: [HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP],
      handedness,
      handednessScore: entry?.score ?? 0.5,
      quality: 1,
    }
  }
}
