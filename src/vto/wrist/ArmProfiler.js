import { clamp } from '../core/mathUtils.js'

/**
 * Measures the forearm - its axis in the image, its width along its length
 * and where it ends - from a skin probability map.
 *
 * WHAT WENT WRONG BEFORE
 * Scored against SAM reference masks on recorded clips, the segmentation was
 * accurate to 1-2 px at the wrist. The width error came from further down the
 * arm, where the forearm crosses in front of the neck: arm skin and neck skin
 * merge into one blob, no colour model can split them (it is all skin), and a
 * profile that measures "the skin run across this row" reads a 51 px arm as
 * 60-74 px wide and drags the axis toward the neck.
 *
 * THE MODEL
 * A forearm's two outlines are close to straight lines over the ~10 cm we
 * look at. So the left and right edges are measured separately, to sub-pixel
 * precision, and each is fitted with a ROBUST line (RANSAC seed + Tukey
 * reweighting). Where the arm merges with the neck on one side, that side's
 * edge jumps outward for a stretch; those rows are outliers of that side's
 * line and are ignored, while the other side and the clean rows still pin the
 * arm down. The axis is the mid-line of the two edge lines; the width at any
 * station is the distance between them, or the measured edges where both are
 * inliers.
 *
 * THE REGION OF INTEREST
 * The map is resampled into a grid aligned with the forearm guess (rows down
 * the arm from the wrist, columns across it), so nothing outside that corridor
 * can take part. Only skin connected to the wrist is followed. If the seeded
 * corridor finds no convincing arm - an edge-on palm can point it into the
 * neck - a fan of directions is tried and the best is kept.
 *
 * Input is skin probability only (0..255). Clothing is not segmented: where
 * the arm's skin stops before the frame edge, that is where measurement stops,
 * whatever covers it.
 */

/** Grid resolution in mm, but never finer than a pixel. */
const CELL_MM = 1.5
const MIN_CELL_PX = 1
/** How far down the arm to look, mm from the wrist anchor. */
const REACH_MM = 100
/** Start slightly on the hand side: the anchor sits on the heel of the palm. */
const START_MM = -4
/** Rows closer than this to the wrist sit on the hand's heel; not arm evidence. */
const FIT_FROM_MM = 6
/** Stop following after this many empty rows in a row. */
const MAX_GAP_ROWS = 5
/** Seed search radius around the wrist anchor. */
const SEED_RADIUS_MM = 12
/** Below this confidence the seed direction is doubted and a fan is tried. */
const FAN_BELOW = 0.45
/** Offsets from the seed tried by the fan, degrees - all away from the hand. */
const FAN_DEG = [-60, -40, -20, 20, 40, 60]
/** Edge-line inlier tolerance floor, mm. */
const EDGE_TOL_MM = 1.6
/**
 * Widest believable forearm half-width relative to the prior. The prior
 * (0.6 x wrist-to-knuckle span) runs small: on the SAM reference masks the
 * real ratio was 0.79 face-on and 0.65 edge-on. At a cap of 1.5 real side-on
 * arms were rejected as too wide and the bracelet sat on the wrist landmark -
 * the arm's edge - for the first half-second of a side-on session. 1.9 still
 * rejects an arm fused with the neck (2.5-3x).
 */
const MAX_HALF_OVER_PRIOR = 1.9
/** How far (rad) a candidate may lean from the seed before it must prove itself. */
const SEED_TRUST_RAD = (35 * Math.PI) / 180
/**
 * Largest divergence of each outline from the shared lean (mm per mm). A
 * forearm half-width grows ~0.06 mm per mm toward the elbow; 0.1 allows for
 * that plus perspective, and forbids the 0.3+ wedges a neck edge produces.
 */
const MAX_TAPER = 0.1
const TAPER_PRIOR = 50
/** Largest in-row hole bridged, as a fraction of the prior half-width. */
const GAP_BRIDGE = 0.35
const SKIN_LEVEL = 128
const OUTSIDE = 255 // grid marker for samples outside the frame

export class ArmProfiler {
  constructor() {
    this._grid = new Uint8Array(0)
    this._comp = new Uint8Array(0)
    this._queue = new Int32Array(0)
    this.rows = []
    this._edgeS = new Float64Array(256)
    this._edgeV = new Float64Array(256)
    this._edgeW = new Float64Array(256)
    this.left = null
    this.right = null
    this._reach = REACH_MM
    this._mid = { a: 0, b: 0 }
    /** Output, reused between calls. */
    this.result = {
      dx: 0, dy: 1,
      confidence: 0,
      /** mm along the arm at which the arm's skin ends inside the frame, Infinity = runs out of frame/reach. */
      sleeveLimitMm: Infinity,
      /** Supported extent down the arm, mm. */
      reachMm: 0,
      rows: this.rows,
      cellMm: CELL_MM,
    }
  }

  /**
   * @param {(x:number, y:number) => number} sample display-pixel lookup of skin
   *        probability 0..255, or -1 outside the frame. Bilinear is best.
   * @param {{x:number,y:number}} anchorPx wrist anchor, display pixels
   * @param {number} dx seed direction down the arm, display pixels, unit
   * @param {number} dy
   * @param {number} mmPerPx at the wrist
   * @param {number} priorHalfWidthMm anthropometric wrist half-width
   * @returns {object|null}
   */
  measure(sample, anchorPx, dx, dy, mmPerPx, priorHalfWidthMm, { reachMm = REACH_MM } = {}) {
    this._reach = reachMm
    const cellPx = Math.max(MIN_CELL_PX, CELL_MM / mmPerPx)
    const cellMm = cellPx * mmPerPx
    const halfSpanMm = Math.max(30, priorHalfWidthMm * 2)
    const run = (ax, ay) => this._pass(sample, anchorPx, ax, ay, cellPx, cellMm, halfSpanMm, priorHalfWidthMm)

    // Candidates are ranked on what is known about arms, not just on how
    // straight their edges are: an arm fused with the neck also has straight
    // edges, but it is twice as wide as a wrist, and it leans away from where
    // the tracker expected the arm.
    const score = (p) => {
      if (!p) return 0
      const lean = Math.acos(clamp(p.fitDx * dx + p.fitDy * dy, -1, 1))
      return p.confidence * p.plausibility * Math.exp(-((lean / SEED_TRUST_RAD) ** 2))
    }
    let pass = run(dx, dy)
    let best = score(pass)
    if (best < FAN_BELOW) {
      for (const deg of FAN_DEG) {
        const a = (deg * Math.PI) / 180
        const c = Math.cos(a)
        const s = Math.sin(a)
        const cand = run(dx * c - dy * s, dx * s + dy * c)
        const cs = score(cand)
        if (cs > best) {
          best = cs
          pass = cand
        }
      }
    }
    if (!pass) return null
    // Re-cut the grid along the fitted mid-line: the arm is then sampled
    // square-on, which is what makes its edges and widths honest.
    for (let i = 0; i < 2; i++) {
      const next = run(pass.fitDx, pass.fitDy)
      const ns = score(next)
      if (ns < best * 0.9) break
      pass = next
      best = ns
    }
    // Leave the profiler's rows/lines describing the pass that is returned.
    pass = run(pass.gridDx, pass.gridDy) || pass

    const r = this.result
    r.dx = pass.fitDx
    r.dy = pass.fitDy
    r.confidence = pass.confidence
    r.sleeveLimitMm = pass.endMm
    r.reachMm = pass.reachMm
    r.cellMm = cellMm
    r.mmPerPx = mmPerPx
    // The grid the rows and edge lines are expressed in: from the anchor,
    // s along (gridDx, gridDy), v along (-gridDy, gridDx), both in mm.
    r.gridDx = pass.gridDx
    r.gridDy = pass.gridDy
    r.lines = pass.lines
    r.bothSides = pass.bothSides
    r.lean = this._mid.b
    return r
  }

  _pass(sample, anchor, dx, dy, cellPx, cellMm, halfSpanMm, priorHalf) {
    const px = -dy // across the arm, +v side
    const py = dx
    const nRows = Math.max(4, Math.ceil((this._reach - START_MM) / cellMm) + 1)
    const nCols = 2 * Math.ceil(halfSpanMm / cellMm) + 1
    const mid = (nCols - 1) >> 1
    const n = nRows * nCols
    if (this._grid.length < n) {
      this._grid = new Uint8Array(n)
      this._comp = new Uint8Array(n)
      this._queue = new Int32Array(n)
    }
    const grid = this._grid
    const comp = this._comp

    // --- 1. Corridor resample (skin probability) ----------------------------
    const startPx = START_MM / cellMm
    for (let r = 0; r < nRows; r++) {
      const along = (startPx + r) * cellPx
      const bx = anchor.x + dx * along
      const by = anchor.y + dy * along
      for (let c = 0; c < nCols; c++) {
        const across = (c - mid) * cellPx
        const v = sample(bx + px * across, by + py * across)
        grid[r * nCols + c] = v < 0 ? OUTSIDE : Math.min(254, v)
      }
    }
    const skin = (i) => grid[i] >= SKIN_LEVEL && grid[i] !== OUTSIDE

    // --- 2. Wrist-rooted component -----------------------------------------
    comp.fill(0, 0, n)
    const r0 = Math.round(-startPx)
    const seedR = Math.ceil(SEED_RADIUS_MM / cellMm)
    let seed = -1
    let best = Infinity
    for (let r = Math.max(0, r0 - seedR); r <= Math.min(nRows - 1, r0 + seedR); r++) {
      for (let c = Math.max(0, mid - seedR); c <= Math.min(nCols - 1, mid + seedR); c++) {
        if (!skin(r * nCols + c)) continue
        const d = (r - r0) * (r - r0) + (c - mid) * (c - mid)
        if (d < best) {
          best = d
          seed = r * nCols + c
        }
      }
    }
    if (seed < 0) return null
    const queue = this._queue
    let head = 0
    let tail = 0
    queue[tail++] = seed
    comp[seed] = 1
    while (head < tail) {
      const i = queue[head++]
      const r = (i / nCols) | 0
      const c = i - r * nCols
      if (c > 0 && !comp[i - 1] && skin(i - 1)) { comp[i - 1] = 1; queue[tail++] = i - 1 }
      if (c < nCols - 1 && !comp[i + 1] && skin(i + 1)) { comp[i + 1] = 1; queue[tail++] = i + 1 }
      if (r > 0 && !comp[i - nCols] && skin(i - nCols)) { comp[i - nCols] = 1; queue[tail++] = i - nCols }
      if (r < nRows - 1 && !comp[i + nCols] && skin(i + nCols)) { comp[i + nCols] = 1; queue[tail++] = i + nCols }
    }

    // --- 3. Row edges, sub-pixel -------------------------------------------
    const rows = this.rows
    rows.length = 0
    let centre = seed - ((seed / nCols) | 0) * nCols
    let gap = 0
    let endMm = Infinity
    const gapCells = Math.max(1, Math.round((priorHalf * GAP_BRIDGE) / cellMm))
    // Sub-pixel crossing of the skin level between cells a (outside) and b (inside).
    const crossing = (ia, ib, ca, cb) => {
      const pa = grid[ia] === OUTSIDE ? 0 : grid[ia]
      const pb = grid[ib]
      const t = pb !== pa ? (SKIN_LEVEL - pa) / (pb - pa) : 0.5
      return ca + clamp(t, 0, 1) * (cb - ca)
    }
    for (let r = 0; r < nRows; r++) {
      const s = START_MM + r * cellMm
      const base = r * nCols
      let lo = -1
      let hi = -1
      let bestDist = Infinity
      for (let c = 0; c < nCols; ) {
        if (!comp[base + c]) { c++; continue }
        let e = c
        while (e + 1 < nCols && comp[base + e + 1]) e++
        const d = centre < c ? c - centre : centre > e ? centre - e : 0
        if (d < bestDist) {
          bestDist = d
          lo = c
          hi = e
        }
        c = e + 1
      }
      // Hair and shading punch holes in forearm skin, which split a row into
      // pieces; the nearest piece alone would put an edge in the middle of the
      // arm. Pieces separated by a gap smaller than a fraction of a wrist are
      // one arm - as long as the merged run is still a believable arm width.
      if (lo >= 0) {
        const maxWidthCells = (2 * priorHalf * MAX_HALF_OVER_PRIOR) / cellMm
        for (let grew = true; grew; ) {
          grew = false
          for (let g = 1; g <= gapCells && lo - g - 1 >= 0; g++) {
            if (comp[base + lo - g - 1]) {
              let e = lo - g - 1
              while (e - 1 >= 0 && comp[base + e - 1]) e--
              if (hi - e + 1 <= maxWidthCells) { lo = e; grew = true }
              break
            }
          }
          for (let g = 1; g <= gapCells && hi + g + 1 < nCols; g++) {
            if (comp[base + hi + g + 1]) {
              let e = hi + g + 1
              while (e + 1 < nCols && comp[base + e + 1]) e++
              if (e - lo + 1 <= maxWidthCells) { hi = e; grew = true }
              break
            }
          }
        }
      }
      const row = { s, left: NaN, right: NaN, leftFree: false, rightFree: false, leftIn: false, rightIn: false }
      rows.push(row)
      if (lo < 0 || bestDist * cellMm > priorHalf) {
        if (s > FIT_FROM_MM && ++gap > MAX_GAP_ROWS) {
          // The arm stopped. Inside the frame that is a sleeve (or anything
          // else covering it); at the frame edge it is just out of view.
          const cc = clamp(Math.round(centre), 0, nCols - 1)
          const endRow = r - gap
          if (grid[base + cc] !== OUTSIDE) endMm = START_MM + Math.max(0, endRow) * cellMm
          break
        }
        continue
      }
      gap = 0
      row.leftFree = lo === 0
      row.rightFree = hi === nCols - 1
      row.left = (row.leftFree ? lo : crossing(base + lo - 1, base + lo, lo - 1, lo)) - mid
      row.right = (row.rightFree ? hi : crossing(base + hi + 1, base + hi, hi + 1, hi)) - mid
      row.left *= cellMm
      row.right *= cellMm
      centre = (lo + hi) / 2
    }

    // --- 4. Robust edge lines ------------------------------------------------
    // Both edges together when both have evidence: a forearm's outlines are
    // near-parallel, so a single-side line that wanders onto the neck cannot
    // pull the arm into a wedge. One side only: fit it alone.
    let left = null
    let right = null
    const joint = this._fitArm(rows, priorHalf)
    if (joint) {
      left = joint.left
      right = joint.right
    } else {
      left = this._fitEdge(rows, 'left', 'leftFree', priorHalf)
      right = this._fitEdge(rows, 'right', 'rightFree', priorHalf)
    }
    this.left = left
    this.right = right
    if (!left && !right) return null

    // Mid-line. With one side lost to a merge, the other side plus the width
    // it had where both sides were clean still gives the centre.
    let bMid
    let aMid
    let halfAt
    if (left && right) {
      aMid = (left.a + right.a) / 2
      bMid = (left.b + right.b) / 2
      halfAt = (s) => (right.a + right.b * s - left.a - left.b * s) / 2
    } else {
      const one = left || right
      const sign = left ? 1 : -1
      const halves = []
      for (const row of rows) {
        if (Number.isFinite(row.left) && Number.isFinite(row.right) && !row.leftFree && !row.rightFree) {
          halves.push((row.right - row.left) / 2)
        }
      }
      if (halves.length < 3) return null
      halves.sort((x, y) => x - y)
      const h = halves[halves.length >> 1]
      aMid = one.a + sign * h
      bMid = one.b
      halfAt = () => h
    }

    const sMid = (FIT_FROM_MM + Math.min(this._reach, Math.max(left?.sMax ?? 0, right?.sMax ?? 0))) / 2
    const half = halfAt(sMid)
    if (!(half > priorHalf * 0.45 && half < priorHalf * MAX_HALF_OVER_PRIOR)) return null
    // Anatomical plausibility of the width: ~1 within +-20 % of the prior.
    const plausibility = Math.exp(-((Math.log(half / priorHalf) / 0.35) ** 2))

    this._mid = { a: aMid, b: bMid }
    for (const row of rows) {
      row.centreMm = aMid + bMid * row.s
      row.fitHalfWidthMm = halfAt(row.s)
      row.leftIn = !!left && isIn(left, row.s, row.left, row.leftFree)
      row.rightIn = !!right && isIn(right, row.s, row.right, row.rightFree)
      row.supported = row.leftIn && row.rightIn
      row.halfWidthMm = row.supported ? (row.right - row.left) / 2 : row.fitHalfWidthMm
    }

    // Direction: rotate the grid direction by the mid-line's lean.
    const theta = Math.atan(bMid)
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    const fitDx = dx * c - dy * s
    const fitDy = dx * s + dy * c

    // Confidence: how many rows each edge explains, over how long a baseline,
    // and how tightly.
    const expected = Math.max(1, rows.filter((row) => row.s >= FIT_FROM_MM).length)
    const edgeScore = (e) => (e ? clamp(e.inliers / expected, 0, 1) * clamp((e.sMax - e.sMin) / 50, 0, 1) * clamp(1 - e.rms / 3, 0.2, 1) : 0)
    const both = left && right ? 1 : 0.6
    const confidence = clamp(Math.sqrt(Math.max(edgeScore(left), edgeScore(right)) * Math.min(edgeScore(left) || 0.3, edgeScore(right) || 0.3)) * both, 0, 1)
    const reachMm = Math.max(left?.sMax ?? 0, right?.sMax ?? 0)
    // Both outlines, resolved (a lost side is the mid-line minus the width),
    // in grid mm: v = a + b * s. For overlays and the arm-only mask.
    const hMid = halfAt(sMid)
    const lines = {
      la: left ? left.a : aMid - hMid, lb: left ? left.b : bMid,
      ra: right ? right.a : aMid + hMid, rb: right ? right.b : bMid,
    }
    return { gridDx: dx, gridDy: dy, fitDx, fitDy, confidence, plausibility, reachMm, endMm, lines, bothSides: !!(left && right) }
  }

  /**
   * Joint robust fit of both outlines:
   *   left(s)  = aL + (b - t) s
   *   right(s) = aR + (b + t) s
   * one shared lean b, and a taper t bounded to what forearms do (they widen
   * a little toward the elbow; they do not fan out into a wedge).
   *
   * RANSAC hypotheses come from pairs on either side; the other side's
   * intercept is the densest cluster of its points at a plausible arm width.
   * The winner is refined by Tukey-weighted least squares on all four
   * parameters. On the recordings this is what stops one edge from following
   * the neck while the other follows the arm.
   */
  _fitArm(rows, priorHalf) {
    const L = []
    const R = []
    for (const row of rows) {
      if (row.s < FIT_FROM_MM) continue
      if (Number.isFinite(row.left) && !row.leftFree) L.push(row.s, row.left)
      if (Number.isFinite(row.right) && !row.rightFree) R.push(row.s, row.right)
    }
    const nL = L.length / 2
    const nR = R.length / 2
    if (nL < 5 || nR < 5) return null
    const tol = Math.max(EDGE_TOL_MM, priorHalf * 0.06)
    const minW = priorHalf * 0.9
    const maxW = priorHalf * 2 * MAX_HALF_OVER_PRIOR

    const count = (P, a, b) => {
      let c = 0
      for (let k = 0; k < P.length; k += 2) if (Math.abs(P[k + 1] - a - b * P[k]) < tol) c++
      return c
    }
    // Densest intercept of P under slope b, within [lo, hi].
    const modeIntercept = (P, b, lo, hi) => {
      const c = []
      for (let k = 0; k < P.length; k += 2) {
        const a = P[k + 1] - b * P[k]
        if (a >= lo && a <= hi) c.push(a)
      }
      if (!c.length) return null
      c.sort((x, y) => x - y)
      let best = 0
      let bestA = c[0]
      for (let i = 0, j = 0; i < c.length; i++) {
        while (c[i] - c[j] > 2 * tol) j++
        if (i - j + 1 > best) {
          best = i - j + 1
          bestA = (c[i] + c[j]) / 2
        }
      }
      return bestA
    }

    let best = null
    const tryHypothesis = (P, n, isLeft) => {
      const tries = Math.min(40, (n * (n - 1)) / 2)
      for (let t = 0; t < tries; t++) {
        const i = (t * 7) % n
        const j = (i + 1 + ((t * 13) % (n - 1))) % n
        const si = P[2 * i]
        const sj = P[2 * j]
        if (Math.abs(sj - si) < 8) continue
        const b = (P[2 * j + 1] - P[2 * i + 1]) / (sj - si)
        if (Math.abs(b) > 0.6) continue
        const a = P[2 * i + 1] - b * si
        const other = isLeft
          ? modeIntercept(R, b, a + minW, a + maxW)
          : modeIntercept(L, b, a - maxW, a - minW)
        if (other === null) continue
        const aL = isLeft ? a : other
        const aR = isLeft ? other : a
        const score = count(L, aL, b) + count(R, aR, b)
        if (!best || score > best.score) best = { aL, aR, b, t: 0, score }
      }
    }
    tryHypothesis(L, nL, true)
    tryHypothesis(R, nR, false)
    if (!best || best.score < 8) return null

    // Tukey-weighted refinement of (aL, aR, b, t). Linear in all four.
    let { aL, aR, b, t } = best
    const c = tol * 2.5
    for (let iter = 0; iter < 6; iter++) {
      // Normal equations for x = [aL, aR, b, t].
      const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
      const y = [0, 0, 0, 0]
      let wsum = 0
      const add = (P, isLeft) => {
        for (let k = 0; k < P.length; k += 2) {
          const sk = P[k]
          const vk = P[k + 1]
          const pred = isLeft ? aL + (b - t) * sk : aR + (b + t) * sk
          const r = (vk - pred) / c
          const w = Math.abs(r) < 1 ? (1 - r * r) ** 2 : 0
          if (!w) continue
          wsum += w
          const j = isLeft ? [1, 0, sk, -sk] : [0, 1, sk, sk]
          for (let p = 0; p < 4; p++) {
            y[p] += w * j[p] * vk
            for (let q = 0; q < 4; q++) A[p][q] += w * j[p] * j[q]
          }
        }
      }
      add(L, true)
      add(R, false)
      if (wsum < 6) break
      // Weak prior pulling the taper to zero keeps it defined on short arms.
      A[3][3] += TAPER_PRIOR
      const x = solve4(A, y)
      if (!x) break
      ;[aL, aR, b] = x
      t = Math.min(MAX_TAPER, Math.max(-MAX_TAPER * 0.3, x[3]))
    }

    const side = (P, a, slope) => {
      let inliers = 0
      let sq = 0
      let sMin = Infinity
      let sMax = -Infinity
      for (let k = 0; k < P.length; k += 2) {
        const e = P[k + 1] - a - slope * P[k]
        if (Math.abs(e) >= tol) continue
        inliers++
        sq += e * e
        sMin = Math.min(sMin, P[k])
        sMax = Math.max(sMax, P[k])
      }
      return inliers >= 3 ? { a, b: slope, tol, inliers, rms: Math.sqrt(sq / inliers), sMin, sMax } : null
    }
    const left = side(L, aL, b - t)
    const right = side(R, aR, b + t)
    if (!left && !right) return null
    return { left, right }
  }

  /**
   * Robust line v = a + b*s through one side's edge points: RANSAC over point
   * pairs for a seed that ignores the merged stretch, then Tukey-weighted
   * least squares to settle it.
   */
  _fitEdge(rows, key, freeKey, priorHalf) {
    const S = this._edgeS
    const V = this._edgeV
    const Wt = this._edgeW
    let n = 0
    for (const row of rows) {
      if (row.s < FIT_FROM_MM || !Number.isFinite(row[key]) || row[freeKey]) continue
      if (n >= S.length) break
      S[n] = row.s
      V[n] = row[key]
      n++
    }
    if (n < 5) return null
    const tol = Math.max(EDGE_TOL_MM, priorHalf * 0.06)

    // RANSAC seed: deterministic pairs spread over the sample.
    let bestA = 0
    let bestB = 0
    let bestCount = -1
    const tries = Math.min(60, (n * (n - 1)) / 2)
    for (let t = 0; t < tries; t++) {
      const i = (t * 7) % n
      const j = (i + 1 + ((t * 13) % (n - 1))) % n
      if (Math.abs(S[j] - S[i]) < 8) continue
      const b = (V[j] - V[i]) / (S[j] - S[i])
      if (Math.abs(b) > 0.6) continue // an arm edge does not lean > ~30 deg off its axis
      const a = V[i] - b * S[i]
      let count = 0
      for (let k = 0; k < n; k++) if (Math.abs(V[k] - a - b * S[k]) < tol) count++
      if (count > bestCount) {
        bestCount = count
        bestA = a
        bestB = b
      }
    }
    if (bestCount < 4) return null

    // Tukey-reweighted refinement.
    let a = bestA
    let b = bestB
    const c = tol * 2.5
    for (let iter = 0; iter < 5; iter++) {
      let sw = 0, ss = 0, sv = 0, sss = 0, ssv = 0
      for (let k = 0; k < n; k++) {
        const r = (V[k] - a - b * S[k]) / c
        const w = Math.abs(r) < 1 ? (1 - r * r) ** 2 : 0
        Wt[k] = w
        sw += w
        ss += w * S[k]
        sv += w * V[k]
        sss += w * S[k] * S[k]
        ssv += w * S[k] * V[k]
      }
      if (sw < 3) break
      const ms = ss / sw
      const varS = sss / sw - ms * ms
      if (varS < 1e-6) break
      b = (ssv / sw - ms * (sv / sw)) / varS
      a = sv / sw - b * ms
    }

    let inliers = 0
    let sq = 0
    let sMin = Infinity
    let sMax = -Infinity
    for (let k = 0; k < n; k++) {
      const e = V[k] - a - b * S[k]
      if (Math.abs(e) >= tol) continue
      inliers++
      sq += e * e
      sMin = Math.min(sMin, S[k])
      sMax = Math.max(sMax, S[k])
    }
    if (inliers < 4) return null
    return { a, b, tol, inliers, rms: Math.sqrt(sq / inliers), sMin, sMax }
  }

  /**
   * Profile entry at arc length `s`. Uses the measured edges where both are
   * inliers of their lines, the fitted lines within the stretch they were
   * fitted over, and nothing outside it.
   */
  sectionAt(s, out) {
    let best = null
    let bestD = Infinity
    for (const row of this.rows) {
      if (!Number.isFinite(row.halfWidthMm)) continue
      const d = Math.abs(row.s - s)
      if (d < bestD) {
        bestD = d
        best = row
      }
    }
    if (!best || bestD > this.result.cellMm * 1.5) return false
    const lo = Math.min(this.left?.sMin ?? Infinity, this.right?.sMin ?? Infinity)
    const hi = Math.max(this.left?.sMax ?? -Infinity, this.right?.sMax ?? -Infinity)
    if (!best.supported && (s < lo - 4 || s > hi + 4)) return false
    // Rows and their centres are expressed on the search GRID, which can lean
    // off the arm by the fitted angle. Consumers work in the FITTED arm's
    // frame (the direction measure() returns), so report the arm centre as its
    // perpendicular distance from that axis - a constant along the arm - and
    // widths square-on to it. Passing grid centres straight through counted
    // the lean twice and bent the twin's centreline by ~10 deg side-on.
    const k = 1 / Math.sqrt(1 + this._mid.b * this._mid.b)
    out.halfWidthMm = best.halfWidthMm * k
    out.offsetMm = this._mid.a * k
    return true
  }
}

function isIn(line, s, v, free) {
  return !free && Number.isFinite(v) && Math.abs(v - line.a - line.b * s) < line.tol
}

/** Solve a 4x4 linear system by Gaussian elimination with partial pivoting. */
function solve4(A, y) {
  const M = A.map((row, i) => [...row, y[i]])
  for (let i = 0; i < 4; i++) {
    let p = i
    for (let r = i + 1; r < 4; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r
    if (Math.abs(M[p][i]) < 1e-9) return null
    ;[M[i], M[p]] = [M[p], M[i]]
    for (let r = 0; r < 4; r++) {
      if (r === i) continue
      const k = M[r][i] / M[i][i]
      for (let c = i; c < 5; c++) M[r][c] -= k * M[i][c]
    }
  }
  return M.map((row, i) => row[4] / row[i])
}
