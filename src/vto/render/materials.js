import * as THREE from 'three'

/**
 * Jewellery materials. Metal is the unforgiving case: viewers cannot tell you
 * what is wrong with a bad gold shader, but they can always tell that it is
 * wrong. Everything here is physically parameterised and driven by the
 * environment, never by a baked highlight.
 */

const PRESETS = {
  gold: { color: 0xf0c268, roughness: 0.13, metalness: 1, envIntensity: 1.35 },
  'rose-gold': { color: 0xe5a184, roughness: 0.12, metalness: 1, envIntensity: 1.3 },
  'white-gold': { color: 0xe8ebee, roughness: 0.09, metalness: 1, envIntensity: 1.45 },
  silver: { color: 0xd9dee2, roughness: 0.15, metalness: 1, envIntensity: 1.4 },
  platinum: { color: 0xd2d6da, roughness: 0.18, metalness: 1, envIntensity: 1.3 },
}

export function createMetalMaterial(spec, quality = 'high') {
  const preset = PRESETS[spec?.type] ?? PRESETS.gold
  const mat = new THREE.MeshPhysicalMaterial({
    color: spec?.color ?? preset.color,
    metalness: spec?.metalness ?? preset.metalness,
    roughness: spec?.roughness ?? preset.roughness,
    envMapIntensity: preset.envIntensity,
    // A thin clearcoat gives polished metal the tight secondary highlight that
    // separates jewellery from a generic metal shader.
    clearcoat: quality === 'high' ? 0.55 : 0,
    clearcoatRoughness: 0.08,
    // Slight anisotropy reads as brushed/drawn stock rather than CG chrome.
    anisotropy: quality === 'high' ? 0.25 : 0,
    anisotropyRotation: Math.PI * 0.25,
  })
  mat.transparent = true
  return mat
}

export function createStoneMaterial(spec, quality = 'high') {
  const mat = new THREE.MeshPhysicalMaterial({
    color: spec?.color ?? 0xffffff,
    metalness: 0,
    roughness: 0.02,
    ior: 2.42,
    envMapIntensity: 2.2,
    specularIntensity: 1,
  })
  if (quality === 'high') {
    mat.transmission = 0.72
    mat.thickness = 2.4
    // Dispersion is what makes a diamond throw colour rather than just sparkle.
    if ('dispersion' in mat) mat.dispersion = 3.2
  } else {
    mat.transmission = 0
    mat.roughness = 0.06
  }
  mat.transparent = true
  return mat
}

/** Applies the confidence-driven fade without touching per-material opacity. */
export function setPresence(material, presence) {
  if (Array.isArray(material)) {
    material.forEach((m) => setPresence(m, presence))
    return
  }
  material.opacity = presence
  material.transparent = presence < 0.999
  material.depthWrite = presence > 0.85
}
