import { defineBracelet, BraceletCategory } from './schema.js'

/**
 * Demo catalogue. Dimensions are the kind a real jeweller would publish, which
 * is exactly the point: the fit engine consumes product specs, not art
 * direction. Swap `model` in for a GLB and nothing else changes.
 */
export const CATALOG = [
  defineBracelet({
    id: 'bangle-classic-18k',
    name: 'Classic Bangle 18K',
    category: BraceletCategory.RIGID_BANGLE,
    innerCircumferenceMm: 180,
    restDiameterXMm: 62,
    restDiameterYMm: 53,
    stockRadiusMm: 3.2,
    massG: 24,
    fit: { clearanceMm: 1.5, stiffness: 1, slide: true, preferredOffsetMm: 20 },
    material: { type: 'gold', color: 0xf3c66a, roughness: 0.12 },
  }),

  defineBracelet({
    id: 'bangle-slim-rose',
    name: 'Slim Bangle, Rose',
    category: BraceletCategory.RIGID_BANGLE,
    innerCircumferenceMm: 168,
    restDiameterXMm: 58,
    restDiameterYMm: 49,
    stockRadiusMm: 1.9,
    massG: 11,
    fit: { clearanceMm: 1.0, stiffness: 1, slide: true, preferredOffsetMm: 24 },
    material: { type: 'rose-gold', color: 0xe6a58a, roughness: 0.1 },
  }),

  defineBracelet({
    id: 'cuff-wide-silver',
    name: 'Wide Cuff, Silver',
    category: BraceletCategory.OPEN_CUFF,
    innerCircumferenceMm: 158,
    restDiameterXMm: 57,
    restDiameterYMm: 47,
    stockRadiusMm: 4.6,
    massG: 32,
    opening: { gapMm: 26, bearingDeg: 180 },
    fit: { clearanceMm: 0.6, stiffness: 0.92, slide: false, preferredOffsetMm: 26 },
    material: { type: 'silver', color: 0xd8dce0, roughness: 0.16 },
  }),

  defineBracelet({
    id: 'tennis-brilliant',
    name: 'Tennis Bracelet, Brilliant',
    category: BraceletCategory.TENNIS,
    innerCircumferenceMm: 178,
    stockRadiusMm: 1.5,
    massG: 14,
    links: { count: 38, lengthMm: 4.7, widthMm: 3.8, bendStiffness: 0.72 },
    fit: { clearanceMm: 0.8, stiffness: 0.72, slide: true, preferredOffsetMm: 18 },
    material: { type: 'white-gold', color: 0xe9ecef, roughness: 0.1 },
    stones: { sizeMm: 3.1, color: 0xffffff, perLink: 1 },
  }),

  defineBracelet({
    id: 'chain-rope-14k',
    name: 'Rope Chain 14K',
    category: BraceletCategory.CHAIN,
    innerCircumferenceMm: 196,
    stockRadiusMm: 1.8,
    massG: 9,
    links: { count: 46, lengthMm: 4.2, widthMm: 3.0, bendStiffness: 0.12 },
    fit: { clearanceMm: 0.4, stiffness: 0.25, slide: true, preferredOffsetMm: 16 },
    material: { type: 'gold', color: 0xeec26a, roughness: 0.18 },
  }),

  defineBracelet({
    id: 'charm-heirloom',
    name: 'Heirloom Charm Bracelet',
    category: BraceletCategory.CHARM,
    innerCircumferenceMm: 188,
    stockRadiusMm: 1.9,
    massG: 16,
    links: { count: 40, lengthMm: 4.6, widthMm: 3.4, bendStiffness: 0.22 },
    fit: { clearanceMm: 0.5, stiffness: 0.3, slide: true, preferredOffsetMm: 18 },
    material: { type: 'gold', color: 0xefc069, roughness: 0.16 },
    charms: [
      { linkIndex: 6, shape: 'heart', sizeMm: 8.5, massG: 1.6, dropMm: 6 },
      { linkIndex: 14, shape: 'disc', sizeMm: 9.5, massG: 2.1, dropMm: 6.5 },
      { linkIndex: 22, shape: 'star', sizeMm: 8.0, massG: 1.4, dropMm: 6 },
      { linkIndex: 30, shape: 'disc', sizeMm: 7.5, massG: 1.2, dropMm: 5.5 },
    ],
  }),
]

export function getBracelet(id) {
  return CATALOG.find((b) => b.id === id) ?? null
}
