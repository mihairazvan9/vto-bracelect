/**
 * Standardised bracelet asset descriptor.
 *
 * The point of this file is that no bracelet ever needs bespoke code. A product
 * is data: real millimetre dimensions plus the behaviour class it belongs to.
 * The runtime picks the solver, the fit and the placement from these fields,
 * which is what turns the VTO from a demo into something a catalogue can be
 * poured into.
 */

export const BraceletCategory = {
  /** Closed rigid ring. Cannot deform; slides and tilts under gravity. */
  RIGID_BANGLE: 'rigid_bangle',
  /** Open C-shaped band with a defined opening orientation. */
  OPEN_CUFF: 'open_cuff',
  /** Articulated links, low sag, holds its curve. */
  TENNIS: 'tennis_bracelet',
  /** Freely hanging chain: high sag, slides around the wrist. */
  CHAIN: 'chain',
  /** Chain plus independently swinging charms. */
  CHARM: 'charm_bracelet',
}

/** Every solver-relevant field, with the defaults the runtime assumes. */
export const ASSET_DEFAULTS = {
  id: '',
  name: '',
  category: BraceletCategory.RIGID_BANGLE,
  units: 'mm',

  /** Inner circumference of the piece as manufactured. The single most
   *  important number: it is what decides whether it fits, and it must NOT be
   *  rescaled to match the wrist. */
  innerCircumferenceMm: 175,

  /** Rest shape of a rigid piece, before contact. */
  restDiameterXMm: 60,
  restDiameterYMm: 52,

  /** Cross-section of the band/link stock. */
  stockRadiusMm: 2.6,

  fit: {
    /** Target air gap between stock and skin, mm. */
    clearanceMm: 2.0,
    /** 0 = fully floppy, 1 = perfectly rigid. */
    stiffness: 0.85,
    gravity: true,
    /** May the piece slide along the forearm to where it is held up? */
    slide: true,
    /** Where on the forearm the piece prefers to sit, mm from the crease. */
    preferredOffsetMm: 22,
    offsetRangeMm: [10, 48],
  },

  orientation: {
    /** Local axis of the ring hole. */
    axis: 'Y',
    front: 'Z',
  },

  /** Open-cuff geometry. */
  opening: {
    gapMm: 24,
    /** Where the gap points in the wrist frame, degrees around the forearm
     *  axis measured from the dorsal direction. */
    bearingDeg: 180,
  },

  links: {
    count: 34,
    lengthMm: 5.2,
    widthMm: 4.0,
    /** 0 = rope-loose, 1 = rigid. Drives the XPBD bend constraint. */
    bendStiffness: 0.5,
  },

  charms: [],

  material: {
    type: 'gold',
    color: 0xf2c46a,
    roughness: 0.14,
    metalness: 1.0,
  },

  stones: null,

  /** Optional GLB. When present it replaces the procedural mesh but keeps every
   *  number above, so fit and physics are unchanged. */
  model: null,

  massG: 18,
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [k, v] of Object.entries(override ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base?.[k])) {
      out[k] = deepMerge(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function defineBracelet(spec) {
  const asset = deepMerge(ASSET_DEFAULTS, spec)
  if (asset.units !== 'mm') {
    throw new Error(`[VTO] asset ${asset.id}: only millimetre assets are supported`)
  }
  return asset
}
