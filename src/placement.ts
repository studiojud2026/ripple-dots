/**
 * Deterministic placement paths for ink mode. Each generator returns N
 * (x, y) positions that become loop centers. The "path" idea is that
 * placement is a continuous curve through the canvas plane, sampled at N
 * uniform parameter values — so the resulting circles have flow, not
 * statistical scatter.
 *
 * All paths are centered on the origin and roughly bounded by ±radius (with
 * the exception of attractors, which we rescale to fit).
 */

import type { Point } from './shapes';

export type InkPath =
  | 'lissajous'
  | 'spiral'
  | 'rose'
  | 'hypotrochoid'
  | 'epitrochoid'
  | 'clifford'
  | 'dejong'
  | 'phyllotaxis';

export const INK_PATH_OPTIONS: { value: InkPath; label: string }[] = [
  { value: 'lissajous', label: 'Lissajous' },
  { value: 'spiral', label: 'Logarithmic Spiral' },
  { value: 'rose', label: 'Rose' },
  { value: 'hypotrochoid', label: 'Hypotrochoid' },
  { value: 'epitrochoid', label: 'Epitrochoid' },
  { value: 'phyllotaxis', label: 'Phyllotaxis' },
  { value: 'clifford', label: 'Clifford Attractor' },
  { value: 'dejong', label: 'De Jong Attractor' },
];

/**
 * What each Param slot drives per path — surface this in the panel so users
 * know which knob does what when they swap modes.
 */
export const INK_PATH_PARAM_LABELS: Record<InkPath, [string, string, string, string]> = {
  // [A label, B label, C label, D label]
  lissajous: ['Freq A', 'Freq B', 'Phase A', '—'],
  spiral: ['—', '—', '—', '—'],
  rose: ['Petals (k)', '—', '—', '—'],
  hypotrochoid: ['R (outer)', 'r (inner)', 'd (pen)', '—'],
  epitrochoid: ['R (outer)', 'r (inner)', 'd (pen)', '—'],
  phyllotaxis: ['Angle (rad)', '—', '—', '—'],
  clifford: ['a', 'b', 'c', 'd'],
  dejong: ['a', 'b', 'c', 'd'],
};

export type PlacementOpts = {
  count: number;
  radius: number; // bounding radius the path is fit to
  pathA: number;
  pathB: number;
  pathC: number;
  pathD: number;
  turns: number; // for parametric curves: how many full cycles to traverse
  phase: number; // global phase offset (radians)
  centerShrink: number; // 0 = full path, 1 = converges to origin along progress
};

export function generatePath(kind: InkPath, opts: PlacementOpts): Point[] {
  switch (kind) {
    case 'lissajous':
      return lissajous(opts);
    case 'spiral':
      return logSpiral(opts);
    case 'rose':
      return rose(opts);
    case 'hypotrochoid':
      return trochoid(opts, 'hypo');
    case 'epitrochoid':
      return trochoid(opts, 'epi');
    case 'phyllotaxis':
      return phyllotaxisPath(opts);
    case 'clifford':
      return cliffordAttractor(opts);
    case 'dejong':
      return dejongAttractor(opts);
  }
}

/* ---------- LISSAJOUS ---------- */
// (R sin(at + δ), R sin(bt)). Integer a:b ratios with gcd 1 trace a stable
// figure with (a-1)·(b-1)/2 self-intersection lobes — 3:2 gives the "two eye"
// look the reference uses. R shrinks with progress if centerShrink > 0.
function lissajous(o: PlacementOpts): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < o.count; i++) {
    const t = (i / o.count) * Math.PI * 2 * o.turns;
    const shrink = 1 - (i / o.count) * o.centerShrink;
    const r = o.radius * shrink;
    pts.push({
      x: r * Math.sin(o.pathA * t + o.pathC + o.phase),
      y: r * Math.sin(o.pathB * t),
    });
  }
  return pts;
}

/* ---------- LOGARITHMIC SPIRAL ---------- */
// r(θ) = R · (1 - centerShrink · progress), θ = progress · turns · 2π.
// With centerShrink > 0 the spiral winds toward the origin (classic shell).
function logSpiral(o: PlacementOpts): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < o.count; i++) {
    const t = i / o.count;
    const theta = t * o.turns * Math.PI * 2 + o.phase;
    const shrink = 1 - t * o.centerShrink;
    const r = o.radius * shrink;
    pts.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return pts;
}

/* ---------- ROSE / RHODONEA ---------- */
// r = R · cos(k · θ) sweeps k petals (or 2k if k is even). pathA = k.
function rose(o: PlacementOpts): Point[] {
  const k = Math.max(1, o.pathA);
  const pts: Point[] = [];
  for (let i = 0; i < o.count; i++) {
    const t = (i / o.count) * Math.PI * 2 * o.turns;
    const shrink = 1 - (i / o.count) * o.centerShrink;
    const r = o.radius * shrink * Math.abs(Math.cos(k * t));
    pts.push({ x: r * Math.cos(t + o.phase), y: r * Math.sin(t + o.phase) });
  }
  return pts;
}

/* ---------- TROCHOIDS ---------- */
// Hypotrochoid: pen on a small circle (r) rolling INSIDE a large (R)
//   x = (R-r) cos t + d cos((R-r)/r · t)
//   y = (R-r) sin t - d sin((R-r)/r · t)
// Epitrochoid: small circle rolling OUTSIDE a large
//   x = (R+r) cos t - d cos((R+r)/r · t)
//   y = (R+r) sin t - d sin((R+r)/r · t)
// d is the pen's offset from the small-circle center — d ≠ r gives "petal"
// loops; d > r gives spiraling cusps. pathA = R, pathB = r, pathC = d-as-
// fraction-of-radius.
function trochoid(o: PlacementOpts, mode: 'hypo' | 'epi'): Point[] {
  const R = Math.max(0.1, o.pathA);
  const r = Math.max(0.1, o.pathB);
  const d = o.pathC * o.radius;
  const sign = mode === 'hypo' ? -1 : 1;
  const sumRad = mode === 'hypo' ? R - r : R + r;
  // The pen orbits at radius ≈ |sumRad| + d, so fit by that magnitude.
  const baseExtent = Math.abs(sumRad) + Math.abs(d);
  const scale = baseExtent > 0 ? o.radius / baseExtent : 1;
  const k = mode === 'hypo' ? (R - r) / r : (R + r) / r;
  const pts: Point[] = [];
  for (let i = 0; i < o.count; i++) {
    const t = (i / o.count) * Math.PI * 2 * o.turns + o.phase;
    const shrink = 1 - (i / o.count) * o.centerShrink;
    const x = sumRad * Math.cos(t) + sign * d * Math.cos(k * t);
    const y = sumRad * Math.sin(t) - d * Math.sin(k * t);
    pts.push({ x: x * scale * shrink, y: y * scale * shrink });
  }
  return pts;
}

/* ---------- PHYLLOTAXIS ---------- */
// Vogel's golden-angle sunflower placement — gives a beautifully even,
// non-overlapping ring structure (loops form concentric "florets").
function phyllotaxisPath(o: PlacementOpts): Point[] {
  const angle = o.pathA || Math.PI * (3 - Math.sqrt(5)); // default to golden
  const pts: Point[] = [];
  for (let i = 0; i < o.count; i++) {
    const r = o.radius * Math.sqrt(i / o.count) * (1 - (i / o.count) * o.centerShrink);
    const t = i * angle + o.phase;
    pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
  }
  return pts;
}

/* ---------- STRANGE ATTRACTORS ---------- */
// Clifford: discrete dynamical system that lives on a fractal in ~[-2, 2]².
//   xₙ₊₁ = sin(a·yₙ) + c·cos(a·xₙ)
//   yₙ₊₁ = sin(b·xₙ) + d·cos(b·yₙ)
// Aesthetically: makes ring-like / lobe-like dense regions, perfect for
// "ink coalescing in pools".
function cliffordAttractor(o: PlacementOpts): Point[] {
  const { pathA: a, pathB: b, pathC: c, pathD: d } = o;
  return iterateAttractor(o.count, o.radius, 2.5, (x, y) => ({
    nx: Math.sin(a * y) + c * Math.cos(a * x),
    ny: Math.sin(b * x) + d * Math.cos(b * y),
  }));
}

// De Jong: similar shape, often denser at the center.
//   xₙ₊₁ = sin(a·yₙ) - cos(b·xₙ)
//   yₙ₊₁ = sin(c·xₙ) - cos(d·yₙ)
function dejongAttractor(o: PlacementOpts): Point[] {
  const { pathA: a, pathB: b, pathC: c, pathD: d } = o;
  return iterateAttractor(o.count, o.radius, 2, (x, y) => ({
    nx: Math.sin(a * y) - Math.cos(b * x),
    ny: Math.sin(c * x) - Math.cos(d * y),
  }));
}

function iterateAttractor(
  count: number,
  targetRadius: number,
  rawExtent: number,
  step: (x: number, y: number) => { nx: number; ny: number },
): Point[] {
  const scale = targetRadius / rawExtent;
  let x = 0.1;
  let y = 0.1;
  // Burn in so we sit on the attractor before sampling.
  for (let i = 0; i < 200; i++) {
    const next = step(x, y);
    x = next.nx;
    y = next.ny;
  }
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const next = step(x, y);
    x = next.nx;
    y = next.ny;
    pts.push({ x: x * scale, y: y * scale });
  }
  return pts;
}
