import * as THREE from 'three'

const _delta = new THREE.Quaternion()
const _twist = new THREE.Quaternion()
const _swing = new THREE.Quaternion()
const _inv = new THREE.Quaternion()

/**
 * Fastest believable twist of the forearm about its own axis. Pronation /
 * supination peaks around 1000-1500 deg/s in sport; a try-on is far below
 * that. Per frame this is ~50 deg at 30 fps.
 */
const MAX_TWIST_RATE_DEG_S = 1500
/** Never gate a twist smaller than this, whatever the frame interval. */
const MIN_TWIST_GATE_DEG = 35
/**
 * A twist the gate rejected is believed after all once the evidence has
 * insisted on it for this long: then it is the gate that is wrong (it locked
 * onto a bad frame), not the detector. On the recordings the detector's
 * flipped runs lasted up to ~270 ms, several times a second.
 */
const TWIST_CONFIRM_MS = 300
/**
 * A confirmed re-orientation is turned into at this rate, not in one frame:
 * a 100 deg snap is exactly the spin the gate exists to prevent.
 */
const TWIST_SLEW_DEG_S = 360
/** Consecutive insisting observations must agree with each other this well. */
const TWIST_CONSISTENT_DEG = 30

/**
 * Rejects physically impossible twists of the arm frame about the forearm.
 *
 * MediaPipe's world landmarks have a mirror ambiguity: in a blurred or
 * edge-on frame the palm can come back facing the other way, and the arm
 * frame built from it turns 100-180 deg about the forearm in one frame. On
 * the recordings that happened several times a second during fast motion,
 * and every time the bracelet spun with it.
 *
 * The observation is split into swing (where the forearm points) and twist
 * (roll about it), relative to the last output. The swing is always kept. A
 * twist faster than any wrist can turn is dropped - unless it keeps being
 * reported, consistently, for TWIST_CONFIRM_MS, in which case it is real (or
 * the earlier frames were the wrong ones) and the output turns to it at
 * TWIST_SLEW_DEG_S. Ordinary motion passes untouched and without delay.
 *
 * Both of MediaPipe's readings are self-consistent (2D and 3D landmarks flip
 * together), so no single frame says which is true; persistence is the only
 * evidence there is, and roll is the pose's least visible degree of freedom
 * on a bracelet, so holding it steady is the right trade.
 */
export class TwistGate {
  constructor() {
    this.reference = new THREE.Quaternion()
    this.output = new THREE.Quaternion()
    this.valid = false
    this._pendingTwist = 0
    this._pendingSince = null
    /** A confirmed re-orientation is being turned into (see TWIST_SLEW_DEG_S). */
    this._slewing = false
    this._lastTime = 0
    /** Observations whose twist was dropped (diagnostics). */
    this.rejected = 0
  }

  reset() {
    this.valid = false
    this._pendingSince = null
    this._slewing = false
  }

  /**
   * @param {THREE.Quaternion} q observed arm frame (x radial, y forearm, z dorsal)
   * @param {number} t ms
   * @returns {THREE.Quaternion} the observation with an impossible twist removed
   */
  filter(q, t) {
    if (!this.valid) return this._accept(q, t)
    const dt = Math.max(1e-3, (t - this._lastTime) / 1000)

    // delta = reference^-1 * q, in the reference's own frame; twist about its y.
    _delta.copy(_inv.copy(this.reference).invert()).multiply(q)
    if (_delta.w < 0) _delta.set(-_delta.x, -_delta.y, -_delta.z, -_delta.w)
    const twistDeg = THREE.MathUtils.radToDeg(2 * Math.atan2(_delta.y, _delta.w))
    const gateDeg = Math.max(MIN_TWIST_GATE_DEG, MAX_TWIST_RATE_DEG_S * dt)

    // A confirmed re-orientation keeps its pace to the end: accepting the
    // remainder as soon as it fell under the gate snapped the last ~40 deg.
    const slewDeg = TWIST_SLEW_DEG_S * dt
    if (this._slewing ? Math.abs(twistDeg) <= slewDeg : Math.abs(twistDeg) <= gateDeg) {
      this._pendingSince = null
      this._slewing = false
      return this._accept(q, t)
    }

    // Too fast to be a wrist. Is it insisting?
    let allowDeg = 0
    if (this._slewing) {
      allowDeg = slewDeg
    } else if (this._pendingSince !== null && Math.abs(wrapDeg(twistDeg - this._pendingTwist)) <= TWIST_CONSISTENT_DEG) {
      if (t - this._pendingSince >= TWIST_CONFIRM_MS) {
        this._pendingSince = null
        this._slewing = true
        allowDeg = slewDeg
      }
    } else {
      this._pendingSince = t
    }
    this._pendingTwist = twistDeg
    if (!this._slewing) this.rejected++

    // Keep the swing; of the twist keep only what is allowed this frame.
    // delta = swing * twist, twist being delta's rotation about local y.
    _twist.set(0, _delta.y, 0, _delta.w).normalize()
    _swing.copy(_delta).multiply(_inv.copy(_twist).invert())
    const keepRad = THREE.MathUtils.degToRad(Math.sign(twistDeg) * Math.min(Math.abs(twistDeg), allowDeg))
    _twist.set(0, Math.sin(keepRad / 2), 0, Math.cos(keepRad / 2))
    this.output.copy(this.reference).multiply(_swing).multiply(_twist).normalize()
    this.reference.copy(this.output)
    this._lastTime = t
    return this.output
  }

  _accept(q, t) {
    this.reference.copy(q)
    this.output.copy(q)
    this.valid = true
    this._lastTime = t
    return this.output
  }
}

function wrapDeg(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180
}

/** Sleeve evidence is judged over this many recent observations... */
const SLEEVE_WINDOW = 12
/** ...and only those this recent, ms. */
const SLEEVE_WINDOW_MS = 800
/** Share of recent observations that must see a sleeve before it is believed... */
const SLEEVE_ENTER = 0.6
/** ...and the share below which it is let go again. */
const SLEEVE_EXIT = 0.25
/** Fastest a believed sleeve edge moves along the arm, mm/s. */
const SLEEVE_SLEW_MM_S = 40

/**
 * Where a sleeve covers the forearm, steadied over time.
 *
 * The arm profiler reports a sleeve per frame, and on the recordings that
 * report flickered - no sleeve, 41 mm, 32 mm, none, 25 mm on consecutive
 * frames of a still arm (a shadowed or hairy stretch reads as the arm ending).
 * The fit follows the sleeve with the bracelet's resting station, so every
 * flicker yanked a chain up to 45 mm along the arm in one frame. A real
 * sleeve is there frame after frame: it is believed once most recent frames
 * see it, let go once few do, and its edge glides rather than jumps.
 */
export class SleeveFilter {
  constructor() {
    this.readings = []
    this.active = false
    this.value = Infinity
    this._t = null
  }

  reset() {
    this.readings.length = 0
    this.active = false
    this.value = Infinity
    this._t = null
  }

  /**
   * @param {number} limitMm this frame's sleeve edge (mm along the arm), Infinity for none
   * @param {number} t ms
   * @returns {number} the believed sleeve edge, Infinity for none
   */
  filter(limitMm, t) {
    const dt = this._t === null ? 0 : Math.min(0.1, Math.max(0, (t - this._t) / 1000))
    this._t = t
    const r = this.readings
    r.push({ limit: limitMm, t })
    while (r.length > SLEEVE_WINDOW || (r.length && t - r[0].t > SLEEVE_WINDOW_MS)) r.shift()
    const seen = r.filter((x) => Number.isFinite(x.limit)).map((x) => x.limit).sort((a, b) => a - b)
    const share = seen.length / r.length
    if (!this.active && r.length >= 6 && share >= SLEEVE_ENTER) {
      this.active = true
      this.value = seen[seen.length >> 1]
    } else if (this.active && share <= SLEEVE_EXIT) {
      this.active = false
      this.value = Infinity
    } else if (this.active && seen.length) {
      const target = seen[seen.length >> 1]
      const step = SLEEVE_SLEW_MM_S * dt
      this.value += Math.max(-step, Math.min(step, target - this.value))
    }
    return this.active ? this.value : Infinity
  }
}

/**
 * One-frame outlier rejection for a scalar measurement.
 *
 * A reading that jumps further than `gate` from the last accepted value is
 * held back for one frame. If the next reading agrees with it (within the
 * gate), the jump was real and is accepted at once; if the next reading is
 * back near the old value, the jump was a glitch and never reaches the
 * output. Ordinary readings pass straight through, so there is no lag.
 *
 * The very first reading has nothing to be compared with, so it too waits
 * for the next one to agree: until then filter() returns null ("no reading
 * yet"), and the caller keeps what it had.
 */
export class SpikeGate {
  constructor(gate) {
    this.gate = gate
    this.value = null
    this._pending = null
    /** Readings held back as glitches (diagnostics). */
    this.rejected = 0
  }

  reset() {
    this.value = null
    this._pending = null
  }

  filter(x) {
    if (this.value === null) {
      const confirmed = this._pending !== null && Math.abs(x - this._pending) <= this.gate
      this._pending = confirmed ? null : x
      if (!confirmed) return null
      this.value = x
      return x
    }
    if (Math.abs(x - this.value) <= this.gate) {
      this._pending = null
      this.value = x
      return x
    }
    if (this._pending !== null && Math.abs(x - this._pending) <= this.gate) {
      this._pending = null
      this.value = x
      return x
    }
    this._pending = x
    this.rejected++
    return this.value
  }
}
