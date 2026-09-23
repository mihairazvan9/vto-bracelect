import * as THREE from 'three'

const _tip = new THREE.Vector3()
const _px = { x: 0, y: 0 }

/**
 * Palm length (wrist to knuckles) as a fraction of the frame height. Below,
 * the arm is too few pixels to measure; above, the forearm leaves the frame.
 * At a ~72 deg webcam, 0.14-0.38 is roughly 25-60 cm from the lens.
 */
const PALM_MIN = 0.14
const PALM_MAX = 0.38
/** How much forearm must be in view, mm below the wrist. */
const FOREARM_VIEW_MM = 70
/** Keep the wrist and that stretch of forearm this far inside the frame. */
const MARGIN = 0.05
/** The wrist itself should sit in the middle of the frame, not at its rim. */
const CENTRE_BOX = { x0: 0.14, x1: 0.86, y0: 0.1, y1: 0.86 }
/** Forearm pointing at the camera: its projected length below this share of full. */
const MIN_IN_PLANE = 0.35
/** Mean skin brightness (0..255) the camera needs for clean edges. */
const LUMA_MIN = 55
const LUMA_MAX = 225
const MIN_POSE_CONFIDENCE = 0.4

/**
 * Judges one camera frame for recording: is the arm framed so the pipeline
 * can see what it needs, and if not, what should the person do about it?
 *
 * Directions are given in DISPLAY terms - the mirrored preview the person is
 * looking at - so "move right" means toward the right of the screen, which is
 * where their hand will appear to go.
 *
 * Returns a plain object; the checks are ordered so that the one instruction
 * shown is the one that unblocks the most (no hand > distance > framing >
 * light).
 */
export class CaptureCoach {
  constructor() {
    /** Per-scenario tolerance overrides, e.g. depth takes need closer framing. */
    this.palmMax = PALM_MAX
    this.palmMin = PALM_MIN
  }

  /**
   * @param {object} sample from VTOEngine._captureSample
   * @returns {{ok:boolean, hand:boolean, checks:Array<{id:string,label:string,ok:boolean,soft?:boolean}>,
   *            instruction:string|null, arrow:string|null, skinLuma:number}}
   */
  evaluate(sample) {
    const { observation: obs, cam } = sample
    const W = cam.width
    const H = cam.height
    const checks = []
    let instruction = null
    let arrow = null
    const fail = (text, dir = null) => {
      if (!instruction) {
        instruction = text
        arrow = dir
      }
    }

    // --- Hand ---------------------------------------------------------------
    const hand = !!obs && obs.poseConfidence >= MIN_POSE_CONFIDENCE
    checks.push({ id: 'hand', label: 'Hand found', ok: hand })
    if (!obs) fail('Show your hand and wrist to the camera')
    else if (!hand) fail('Hold steady - finding your hand')

    if (!hand) {
      for (const [id, label] of [['distance', 'Distance'], ['forearm', 'Forearm in view'], ['light', 'Light']]) {
        checks.push({ id, label, ok: false })
      }
      checks.push({ id: 'outline', label: 'Arm outline', ok: false, soft: true })
      return { ok: false, hand: false, checks, instruction, arrow, skinLuma: NaN }
    }

    // --- Distance -----------------------------------------------------------
    const palmPx = obs.palmLengthMm / obs.mmPerPx
    const palmShare = palmPx / H
    const distanceOk = palmShare >= this.palmMin && palmShare <= this.palmMax
    checks.push({ id: 'distance', label: 'Distance', ok: distanceOk })
    if (palmShare < this.palmMin) fail('Move your hand closer to the camera', 'closer')
    else if (palmShare > this.palmMax) fail('Move your hand a little further away', 'further')

    // --- Wrist position and forearm in view ---------------------------------
    const c = obs.creasePx
    const box = CENTRE_BOX
    let positionOk = true
    if (c.x < box.x0 * W) { positionOk = false; fail('Move your hand to the right', 'right') }
    else if (c.x > box.x1 * W) { positionOk = false; fail('Move your hand to the left', 'left') }
    if (c.y < box.y0 * H) { positionOk = false; fail('Move your hand down', 'down') }
    else if (c.y > box.y1 * H) { positionOk = false; fail('Raise your hand', 'up') }

    // The stretch of forearm the bracelet lives on must be in the picture.
    _tip.copy(obs.creasePoint).addScaledVector(obs.basis.y, FOREARM_VIEW_MM)
    const tip = cam.project(_tip, _px)
    const fullPx = FOREARM_VIEW_MM / obs.mmPerPx
    const inPlane = Math.hypot(tip.x - c.x, tip.y - c.y) / Math.max(1, fullPx)
    let forearmOk = positionOk
    const m = MARGIN
    if (inPlane < MIN_IN_PLANE) {
      forearmOk = false
      fail('Hold your forearm across the view, not pointing at the camera')
    } else if (tip.y > (1 - m) * H) {
      forearmOk = false
      fail('Raise your hand - show more of your forearm', 'up')
    } else if (tip.y < m * H) {
      forearmOk = false
      fail('Lower your hand - show more of your forearm', 'down')
    } else if (tip.x < m * W) {
      forearmOk = false
      fail('Move your hand to the right - show more of your forearm', 'right')
    } else if (tip.x > (1 - m) * W) {
      forearmOk = false
      fail('Move your hand to the left - show more of your forearm', 'left')
    }
    checks.push({ id: 'forearm', label: 'Forearm in view', ok: forearmOk })

    // --- Light, measured on the arm's own skin ------------------------------
    const skinLuma = this._skinLuma(sample)
    const lightOk = !Number.isFinite(skinLuma) || (skinLuma >= LUMA_MIN && skinLuma <= LUMA_MAX)
    checks.push({ id: 'light', label: 'Light', ok: lightOk })
    if (skinLuma < LUMA_MIN) fail('Too dark - turn toward a light or add one')
    else if (skinLuma > LUMA_MAX) fail('Too bright - move out of direct light')

    // --- Arm outline: nice to have, never blocks a take ----------------------
    // A failure here is itself worth recording; it is the case to improve.
    checks.push({ id: 'outline', label: 'Arm outline', ok: !!obs.forearmFromSilhouette, soft: true })

    const ok = hand && distanceOk && forearmOk && lightOk
    return { ok, hand, checks, instruction, arrow, skinLuma }
  }

  /** Mean brightness of confident skin inside the refinement region, or NaN. */
  _skinLuma(sample) {
    const mask = sample.armMask
    const rgba = sample.roiRgba
    if (!mask || !rgba || rgba.length < mask.data.length * 4) return NaN
    let sum = 0
    let n = 0
    const d = mask.data
    for (let i = 0, p = 0; i < d.length; i += 3, p += 12) {
      if (d[i] < 170) continue
      sum += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
      n++
    }
    return n > 40 ? sum / n : NaN
  }
}
