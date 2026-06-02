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

/**
 * Off-center point sources that add ADDITIONAL radial wave height on top of
 * whatever the primary ripple is doing. Multiple sources at different (x, y)
 * positions interfere, producing the asymmetric / discordant patterns you get
 * from dropping several pebbles in a pond at once.
 */
export type ExtraSource = {
  x: number;
  y: number;
  frequency: number;
  depth: number;
  phaseOffset: number;
};

export type RippleOptions = {
  kind: RippleKind;
  frequency: number;
  depth: number;
  phase: number;
  decay: number;
  /** Boundary samples of the active shape — required for edge-driven modes. */
  boundary?: Point[];
  /** Additional point sources whose radial waves stack into Z. */
  extraSources?: ExtraSource[];
};

export function applyRipple(dots: Dot[], opts: RippleOptions): Dot3[] {
  const hasExtras = (opts.extraSources?.length ?? 0) > 0;
  const primaryOff = opts.kind === 'off' || opts.depth === 0;
  if (primaryOff && !hasExtras) {
    return dots.map((d) => ({ x: d.x, y: d.y, z: 0, r: d.r }));
  }
  // Edge modes need a precomputed per-dot edge distance — fall back to no
  // primary contribution if the boundary wasn't provided (extras still apply).
  const needsEdge = opts.kind === 'edge-wave' || opts.kind === 'edge-pulse';
  const edgeMissing = needsEdge && (!opts.boundary || opts.boundary.length === 0);
  const effectiveOpts: RippleOptions = edgeMissing ? { ...opts, kind: 'off' } : opts;
  return dots.map((d) => distort(d, effectiveOpts));
}

/** Sum radial wave contributions from each extra source. */
function extraWave(d: Dot, opts: RippleOptions): number {
  const sources = opts.extraSources;
  if (!sources || sources.length === 0) return 0;
  let sum = 0;
  for (const s of sources) {
    const dx = d.x - s.x;
    const dy = d.y - s.y;
    const r = Math.sqrt(dx * dx + dy * dy);
    const att = opts.decay === 0 ? 1 : Math.exp(-r * opts.decay * 0.002);
    sum += Math.sin(r * s.frequency * 0.05 + opts.phase + s.phaseOffset) * s.depth * att;
  }
  return sum;
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
  const extra = extraWave(d, opts);

  switch (kind) {
    case 'radial': {
      const z = Math.sin(r * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z: z + extra, r: d.r };
    }
    case 'horizontal': {
      const z = Math.sin(d.x * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z: z + extra, r: d.r };
    }
    case 'concentric-pulse': {
      const pulse = Math.sin(r * frequency * 0.05 + phase);
      const scale = 1 + pulse * depth * 0.005 * attenuation;
      return { x: d.x * scale, y: d.y * scale, z: extra, r: d.r };
    }
    case 'edge-wave': {
      const dist = nearestEdgeDistance(d, boundary!);
      const z = Math.sin(dist * frequency * 0.05 + phase) * depth * attenuation;
      return { x: d.x, y: d.y, z: z + extra, r: d.r };
    }
    case 'edge-pulse': {
      const dist = nearestEdgeDistance(d, boundary!);
      const wave = Math.sin(dist * frequency * 0.05 + phase) * depth * 0.01 * attenuation;
      const scale = 1 + wave;
      return { x: d.x * scale, y: d.y * scale, z: extra, r: d.r };
    }
    case 'twist': {
      const twist = Math.sin(r * frequency * 0.03 + phase) * depth * 0.02 * attenuation;
      const a = theta + twist;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, z: extra, r: d.r };
    }
    default:
      return { x: d.x, y: d.y, z: extra, r: d.r };
  }
}
