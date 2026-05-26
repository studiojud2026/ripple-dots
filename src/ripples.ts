import type { Dot } from './generators';
import type { Point } from './shapes';

export type Dot3 = { x: number; y: number; z: number; r: number };

export type RippleKind =
  | 'radial'
  | 'horizontal'
  | 'twist'
  | 'concentric-pulse'
  | 'edge-wave'
  | 'edge-pulse'
  | 'off';

export type RippleOptions = {
  kind: RippleKind;
  frequency: number;
  depth: number;
  phase: number;
  decay: number;
  /** Boundary samples of the active shape — required for edge-driven modes. */
  boundary?: Point[];
};

export function applyRipple(dots: Dot[], opts: RippleOptions): Dot3[] {
  if (opts.kind === 'off' || opts.depth === 0) {
    return dots.map((d) => ({ x: d.x, y: d.y, z: 0, r: d.r }));
  }
  // Edge modes need a precomputed per-dot edge distance — fall back to identity
  // if the boundary wasn't provided.
  const needsEdge = opts.kind === 'edge-wave' || opts.kind === 'edge-pulse';
  if (needsEdge && (!opts.boundary || opts.boundary.length === 0)) {
    return dots.map((d) => ({ x: d.x, y: d.y, z: 0, r: d.r }));
  }
  return dots.map((d) => distort(d, opts));
}

function nearestEdgeDistance(d: Dot, boundary: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    const dx = d.x - boundary[i].x;
    const dy = d.y - boundary[i].y;
    const sq = dx * dx + dy * dy;
    if (sq < best) best = sq;
  }
  return Math.sqrt(best);
}

function distort(d: Dot, opts: RippleOptions): Dot3 {
  const { kind, frequency, depth, phase, decay, boundary } = opts;
  const r = Math.sqrt(d.x * d.x + d.y * d.y);
  const theta = Math.atan2(d.y, d.x);
  const attenuation = decay === 0 ? 1 : Math.exp(-r * decay * 0.002);

  switch (kind) {
    case 'radial': {
      // wave height — radiates outward like a stone dropped in water
      const z = Math.sin(r * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z, r: d.r };
    }
    case 'horizontal': {
      // wave along x; height along z
      const z = Math.sin(d.x * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z, r: d.r };
    }
    case 'concentric-pulse': {
      // breathing rings — alternate inward/outward by ring
      const pulse = Math.sin(r * frequency * 0.05 + phase);
      const scale = 1 + pulse * depth * 0.005 * attenuation;
      return { x: d.x * scale, y: d.y * scale, z: 0, r: d.r };
    }
    case 'edge-wave': {
      // Wave parameter is distance to the nearest point on the silhouette
      // outline. Contours of constant phase therefore parallel the shape's
      // edge — a heart ripples in heart-shaped rings.
      const dist = nearestEdgeDistance(d, boundary!);
      const z = Math.sin(dist * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z, r: d.r };
    }
    case 'edge-pulse': {
      // Same edge-distance wave, but applied as XY displacement away from the
      // nearest edge — dots breathe in and out along the shape's contour.
      const dist = nearestEdgeDistance(d, boundary!);
      const wave = Math.sin(dist * frequency * 0.05 + phase) * depth * 0.01 * attenuation;
      const scale = 1 + wave;
      return { x: d.x * scale, y: d.y * scale, z: 0, r: d.r };
    }
    case 'twist': {
      // angular sinusoid — winds dots around the center
      const twist = Math.sin(r * frequency * 0.03 + phase) * depth * 0.02 * attenuation;
      const a = theta + twist;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0, r: d.r };
    }
    default:
      return { x: d.x, y: d.y, z: 0, r: d.r };
  }
}
