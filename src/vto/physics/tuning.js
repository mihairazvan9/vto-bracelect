/**
 * One knob for how alive the jewellery is: LIVELINESS, 0 (calm) .. 1 (lively).
 *
 * It replaces the old "stable" / "realistic" switch. Both ends are real
 * physics now - mass, contact, skin friction, gravity - and they differ only in
 * how much of the arm's motion reaches the piece and how quickly that motion
 * dies away. Calm is for a product page (a piece that sits and shines, still
 * settling like metal would); lively is for the "feel the weight" moment.
 */

export const DEFAULT_LIVELINESS = 0.4

const lerp = (a, b, t) => a + (b - a) * t
const DEG = Math.PI / 180

/**
 * @param {number} liveliness 0..1
 * @returns physics parameters shared by the rigid and the chain solvers
 */
export function physicsTuning(liveliness = DEFAULT_LIVELINESS) {
  const L = Math.min(1, Math.max(0, liveliness))
  return {
    liveliness: L,
    /** How much of the (filtered) arm motion the piece feels, and its caps (see ArmInertia). */
    inertia: {
      gain: lerp(0.3, 1, L),
      maxLinear: lerp(12000, 40000, L),
      maxAngularVel: lerp(6, 14, L),
      maxAngularAcc: lerp(40, 120, L),
      // While the arm is clearly moving (a shake, a swing), how much opens up:
      // the follower's bandwidth, the gain and the cap (see ArmInertia).
      shakeHz: lerp(6, 9, L),
      shakeGain: lerp(0.8, 1, L),
      shakeMaxLinear: lerp(30000, 60000, L),
    },
    /** Metal on skin. Static holds a piece on a gently sloped arm (tan 35 deg ~ 0.7). */
    frictionStatic: lerp(0.85, 0.6, L),
    frictionKinetic: lerp(0.65, 0.42, L),
    /** Bounce off the arm: a soft knock, never a rubber ball. */
    restitution: lerp(0.05, 0.18, L),
    /** Air and internal damping, 1/s: velocity halves in ln2/c seconds. */
    linearDamping: lerp(4.5, 1.4, L),
    angularDamping: lerp(6, 2.2, L),
    /**
     * How quickly the jewellery's frame follows the arm's twist, Hz (see
     * JewelleryFrame). Below the detector's roll noise (5-15 Hz), above a
     * real turn of the forearm, so turns come through and twitches do not.
     */
    twistFollowHz: lerp(1.6, 3.2, L),
    /** Largest tilt of a rigid piece off the arm's cross-section: tasteful, not floppy. */
    maxTiltRad: lerp(4, 10, L) * DEG,
    /**
     * Pull of a piece toward its resting station along the arm, 1/s. None: a
     * piece slides freely along the arm, held only by what holds a real one -
     * skin friction, gravity, the arm's motion, and the flares at the hand and
     * elbow (walls.js). The pull (3 /s calm, 0.4 lively) made every piece feel
     * parked at one spot. The station is still where a piece is first seated.
     */
    axialHold: 0,
  }
}

/** Liveliness from the solvers' options: explicit value, the old `realistic` flag, or the default. */
export function livelinessFrom(options = {}) {
  if (Number.isFinite(options.liveliness)) return options.liveliness
  if (options.realistic === true) return 1
  return DEFAULT_LIVELINESS
}

/**
 * The solvers' parameters from their options. `pinned` (diagnostic, the
 * engine's raw pose) keeps the piece's own dynamics - gravity, contact with
 * the arm - but takes away everything that makes it lag the arm: its frame
 * follows the arm's twist at once, and the arm's motion pushes it no more.
 */
export function tuningFrom(options = {}) {
  const tune = physicsTuning(livelinessFrom(options))
  if (options.pinned) {
    tune.twistFollowHz = Infinity
    tune.inertia = { ...tune.inertia, gain: 0, shakeGain: 0 }
  }
  return tune
}
