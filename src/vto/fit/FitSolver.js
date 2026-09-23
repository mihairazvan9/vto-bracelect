import { BraceletCategory } from '../assets/schema.js'
import { clamp, ellipseCircumference, ellipseFromCircumference } from '../core/mathUtils.js'

export const FitVerdict = {
  TOO_SMALL: 'too_small',
  SNUG: 'snug',
  COMFORTABLE: 'comfortable',
  LOOSE: 'loose',
  TOO_LOOSE: 'too_loose',
  WILL_NOT_PASS_HAND: 'will_not_pass_hand',
}

const VERDICT_COPY = {
  [FitVerdict.TOO_SMALL]: 'Too small — it will not close around your wrist.',
  [FitVerdict.SNUG]: 'Snug fit — sits tight against the wrist.',
  [FitVerdict.COMFORTABLE]: 'Comfortable fit — moves a little, stays put.',
  [FitVerdict.LOOSE]: 'Loose fit — will slide toward your hand.',
  [FitVerdict.TOO_LOOSE]: 'Too loose — likely to slip over your hand.',
  [FitVerdict.WILL_NOT_PASS_HAND]: 'Will not pass over your hand — choose a larger size or a clasped style.',
}

/** Knuckle circumference with the thumb tucked, relative to metacarpal breadth. */
const HAND_PASS_RATIO = 2.15

/**
 * Turns the wrist twin plus a product spec into a real fit answer.
 *
 * The rule that matters: the bracelet keeps its manufactured size. We never
 * scale the product to the wrist. A 180 mm bangle on a 160 mm wrist has a
 * genuine 20 mm of slack, and the user should see that slack.
 */
export class FitSolver {
  /**
   * @param {object} asset
   * @param {import('../wrist/WristDigitalTwin.js').WristDigitalTwin} twin
   */
  evaluate(asset, twin, offsetBiasMm = 0) {
    const clasped = asset.category !== BraceletCategory.RIGID_BANGLE

    // Where does this piece come to rest? A ring larger than the wrist slides
    // up the forearm until the arm is wide enough to hold it. `offsetBiasMm`
    // is how the stack manager gives each piece its own band of forearm.
    const preferred = asset.fit.preferredOffsetMm + offsetBiasMm
    const minS = asset.fit.offsetRangeMm[0] + offsetBiasMm
    const maxS = asset.fit.offsetRangeMm[1] + offsetBiasMm
    let restingOffsetMm = preferred
    if (asset.fit.slide) {
      restingOffsetMm = clamp(twin.restingPositionFor(asset.innerCircumferenceMm, minS), minS, maxS)
      // Never let it rest further up than a sleeve allows.
      if (twin.sleeveLimitMm < restingOffsetMm) {
        restingOffsetMm = clamp(twin.sleeveLimitMm - 4, minS, maxS)
      }
    }

    const section = twin.sectionAt(restingOffsetMm)
    const wristCircumferenceMm = ellipseCircumference(section.a, section.b)

    // The oval the bracelet actually forms. A rigid piece keeps its own shape;
    // a flexible one takes the wrist's aspect ratio.
    const aspect = clasped
      ? section.a / Math.max(1e-3, section.b)
      : asset.restDiameterXMm / Math.max(1e-3, asset.restDiameterYMm)
    const ring = ellipseFromCircumference(asset.innerCircumferenceMm, aspect)

    const slackMm = asset.innerCircumferenceMm - wristCircumferenceMm
    // Average radial air gap implied by the slack.
    const gapMm = slackMm / (2 * Math.PI)

    let verdict
    if (!clasped && asset.innerCircumferenceMm < twin.handBreadthMm * HAND_PASS_RATIO) {
      verdict = FitVerdict.WILL_NOT_PASS_HAND
    } else if (slackMm < 0) {
      verdict = FitVerdict.TOO_SMALL
    } else if (slackMm < 7) {
      verdict = FitVerdict.SNUG
    } else if (slackMm < 20) {
      verdict = FitVerdict.COMFORTABLE
    } else if (slackMm < 34) {
      verdict = FitVerdict.LOOSE
    } else {
      verdict = FitVerdict.TOO_LOOSE
    }

    return {
      assetId: asset.id,
      clasped,
      restingOffsetMm,
      offsetRangeMm: [minS, maxS],
      wristCircumferenceMm,
      braceletCircumferenceMm: asset.innerCircumferenceMm,
      slackMm,
      gapMm,
      ringA: ring.a,
      ringB: ring.b,
      verdict,
      message: VERDICT_COPY[verdict],
      recommendedCircumferenceMm: this.recommendSize(wristCircumferenceMm, asset, twin),
      /** Honest separation: looks right vs. is the right size. */
      visualFitConfidence: clamp(twin.poseConfidence * 0.6 + twin.geometryConfidence * 0.4, 0, 1),
      physicalSizeConfidence: twin.sizingConfidence,
    }
  }

  /** The circumference we would actually sell this customer. */
  recommendSize(wristCircumferenceMm, asset, twin) {
    const clasped = asset.category !== BraceletCategory.RIGID_BANGLE
    // Clasped pieces want a small comfort allowance; rigid bangles are driven by
    // having to clear the hand at all.
    const target = clasped
      ? wristCircumferenceMm + 14
      : Math.max(wristCircumferenceMm + 18, twin.handBreadthMm * HAND_PASS_RATIO + 4)
    return Math.round(target)
  }
}

export const FIT_COPY = VERDICT_COPY
