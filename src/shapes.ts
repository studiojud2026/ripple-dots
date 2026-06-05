export type ShapeKind =
  | 'circle'
  | 'heart'
  | 'star'
  | 'hexagon'
  | 'triangle'
  | 'flower'
  | 'custom'
  | 'image';

export const SHAPE_OPTIONS: { value: ShapeKind; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'heart', label: 'Heart' },
  { value: 'star', label: 'Star' },
  { value: 'hexagon', label: 'Hexagon' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'flower', label: 'Flower' },
  { value: 'custom', label: 'Custom SVG' },
  { value: 'image', label: 'Image' },
];

export type Point = { x: number; y: number };

/**
 * Build a polar radius lookup from boundary samples: for any direction θ the
 * table gives the silhouette's distance from the origin in that direction.
 * Used to WARP (not mask) a field into a shape — multiply a point's radius by
 * shapeRadius(θ) / boundingRadius to squish the field into the silhouette.
 *
 * We take the MAX radius per angular bucket so concave/star shapes keep their
 * outermost extent (points), and fill any empty buckets from their neighbours.
 *
 * `smoothRadius` (in buckets) applies a circular blur to the table, rounding
 * off sharp jumps so a field warped by it doesn't spike at notches/concavities
 * of complex SVGs.
 */
export function buildPolarRadius(
  boundary: Point[],
  buckets = 240,
  smoothRadius = 0,
): Float64Array {
  const table = new Float64Array(buckets);
  for (const pt of boundary) {
    const ang = Math.atan2(pt.y, pt.x); // -π..π
    const r = Math.hypot(pt.x, pt.y);
    let idx = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    if (r > table[idx]) table[idx] = r;
  }
  // Forward/backward fill empty buckets so lookups never return 0.
  let last = 0;
  for (let i = 0; i < buckets; i++) {
    if (table[i] === 0) table[i] = last;
    else last = table[i];
  }
  // Wrap-around: if the first buckets were empty, fill from the end.
  if (table[0] === 0) table[0] = last;
  for (let i = 0; i < buckets; i++) {
    if (table[i] === 0) table[i] = table[(i - 1 + buckets) % buckets] || last;
  }
  // Circular box-blur to round off sharp angular jumps (anti-spike).
  const r = Math.round(smoothRadius);
  if (r >= 1) {
    const out = new Float64Array(buckets);
    for (let i = 0; i < buckets; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += table[((i + k) % buckets + buckets) % buckets];
      out[i] = sum / (2 * r + 1);
    }
    return out;
  }
  return table;
}

/** Interpolated lookup into a buildPolarRadius table for a given angle. */
export function polarRadiusAt(table: Float64Array, angle: number): number {
  const buckets = table.length;
  const f = ((angle + Math.PI) / (2 * Math.PI)) * buckets;
  const i0 = Math.floor(f) % buckets;
  const i1 = (i0 + 1) % buckets;
  const frac = f - Math.floor(f);
  const a = table[(i0 + buckets) % buckets];
  const b = table[i1];
  return a + (b - a) * frac;
}

/**
 * Sample evenly-spaced points along the shape's outline (centered at origin,
 * same scale as the Path2D from `buildShape`). Used by edge-driven ripples to
 * compute distance-to-nearest-edge per dot.
 */
export function sampleBoundary(
  kind: ShapeKind,
  radius: number,
  customPath: string,
  samples = 256,
): Point[] {
  switch (kind) {
    case 'circle':
      return ring(radius, samples);
    case 'heart':
      return heartPoints(radius, samples);
    case 'star':
      return starPoints(radius, 5, 0.45, samples);
    case 'hexagon':
      return polygonPoints(radius, 6, -Math.PI / 2, samples);
    case 'triangle':
      return polygonPoints(radius, 3, -Math.PI / 2, samples);
    case 'flower':
      return flowerPoints(radius, 6, samples);
    case 'custom':
      return customPoints(customPath, radius, samples);
    case 'image':
      // Image silhouettes are pixel-based; edge-driven ripples use the bounding
      // circle as the fallback boundary so they still produce a wave.
      return ring(radius, samples);
  }
}

function ring(r: number, n: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

function heartPoints(r: number, n: number): Point[] {
  const k = r / 17;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push({ x: x * k, y: y * k });
  }
  return pts;
}

function starPoints(r: number, points: number, innerRatio: number, n: number): Point[] {
  // Walk the star outline and resample to `n` evenly-distributed points by arc length.
  const verts: Point[] = [];
  const inner = r * innerRatio;
  const total = points * 2;
  for (let i = 0; i < total; i++) {
    const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : inner;
    verts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad });
  }
  return resamplePolyline(verts, n, true);
}

function polygonPoints(r: number, sides: number, startAngle: number, n: number): Point[] {
  const verts: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (i / sides) * Math.PI * 2;
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return resamplePolyline(verts, n, true);
}

function flowerPoints(r: number, petals: number, n: number): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rad = r * Math.abs(Math.cos((petals / 2) * t));
    pts.push({ x: Math.cos(t) * rad, y: Math.sin(t) * rad });
  }
  return pts;
}

function customPoints(input: string, r: number, n: number): Point[] {
  const d = extractPathData(input);
  if (!d) return ring(r, n);
  try {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.style.position = 'absolute';
    svg.style.opacity = '0';
    svg.style.pointerEvents = 'none';
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    document.body.appendChild(svg);
    try {
      const bbox = path.getBBox();
      const extent = Math.max(bbox.width, bbox.height) / 2;
      if (!isFinite(extent) || extent === 0) return ring(r, n);
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      const scale = r / extent;
      const total = path.getTotalLength();
      if (total === 0) return ring(r, n);
      const pts: Point[] = [];
      for (let i = 0; i < n; i++) {
        const pt = path.getPointAtLength((total * i) / n);
        pts.push({ x: (pt.x - cx) * scale, y: (pt.y - cy) * scale });
      }
      return pts;
    } finally {
      document.body.removeChild(svg);
    }
  } catch {
    return ring(r, n);
  }
}

// Walk a polyline of vertices and emit n points distributed by arc length.
function resamplePolyline(verts: Point[], n: number, closed: boolean): Point[] {
  const segs: { a: Point; b: Point; len: number }[] = [];
  let total = 0;
  const end = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < end; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len });
    total += len;
  }
  const step = total / n;
  const out: Point[] = [];
  let segIdx = 0;
  let distInto = 0;
  for (let i = 0; i < n; i++) {
    let target = i * step;
    while (segIdx < segs.length && target > distInto + segs[segIdx].len) {
      distInto += segs[segIdx].len;
      segIdx++;
    }
    if (segIdx >= segs.length) {
      out.push(verts[verts.length - 1]);
      continue;
    }
    const s = segs[segIdx];
    const t = s.len === 0 ? 0 : (target - distInto) / s.len;
    out.push({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
  }
  return out;
}

/**
 * Build a Path2D for the given shape, fitted to a bounding circle of `radius`.
 * Shapes are centered at (0, 0). Custom paths are parsed from SVG `d` attribute
 * data, auto-centered, and uniformly scaled to fit within the radius.
 */
export function buildShape(kind: ShapeKind, radius: number, customPath?: string): Path2D {
  switch (kind) {
    case 'circle':
      return circle(radius);
    case 'heart':
      return heart(radius);
    case 'star':
      return star(radius, 5, 0.45);
    case 'hexagon':
      return polygon(radius, 6, -Math.PI / 2);
    case 'triangle':
      return polygon(radius, 3, -Math.PI / 2);
    case 'flower':
      return flower(radius, 6);
    case 'custom':
      return customSvg(customPath ?? '', radius);
    case 'image':
      // Path2D fallback when image isn't loaded yet — the image-mask filter
      // in Composition takes over once data is available.
      return circle(radius);
  }
}

function circle(r: number): Path2D {
  const p = new Path2D();
  p.arc(0, 0, r, 0, Math.PI * 2);
  return p;
}

function polygon(r: number, sides: number, startAngle = 0): Path2D {
  const p = new Path2D();
  for (let i = 0; i <= sides; i++) {
    const a = startAngle + (i / sides) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function star(r: number, points: number, innerRatio: number): Path2D {
  const p = new Path2D();
  const inner = r * innerRatio;
  const total = points * 2;
  for (let i = 0; i <= total; i++) {
    const a = -Math.PI / 2 + (i / total) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : inner;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function heart(r: number): Path2D {
  const p = new Path2D();
  // Classic parametric heart; raw extent is ~17 in x and ~17 in y
  const k = r / 17;
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    // Negate y because canvas y grows downward, but visually we want the cusp at top
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    if (i === 0) p.moveTo(x * k, y * k);
    else p.lineTo(x * k, y * k);
  }
  p.closePath();
  return p;
}

function flower(r: number, petals: number): Path2D {
  const p = new Path2D();
  const steps = 360;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    // rose curve: r * |cos(k*t/2)| keeps it strictly positive
    const rad = r * Math.abs(Math.cos((petals / 2) * t));
    const x = Math.cos(t) * rad;
    const y = Math.sin(t) * rad;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

/**
 * Accept raw path data ("M0 0 L...") OR a full <svg>...</svg> markup pasted
 * from Figma/Illustrator/etc. When markup is given, concatenate every <path>'s
 * `d` so a multi-path icon still renders as one silhouette.
 */
export function extractPathData(input: string): string {
  const s = input.trim();
  if (!s) return '';
  if (!s.startsWith('<')) return s;
  // Match every d="..." (handles single or double quotes).
  const matches = [...s.matchAll(/\sd\s*=\s*"([^"]+)"|\sd\s*=\s*'([^']+)'/g)];
  return matches.map((m) => m[1] ?? m[2]).join(' ');
}

function customSvg(input: string, r: number): Path2D {
  const d = extractPathData(input);
  if (!d) return circle(r);
  try {
    const raw = new Path2D(d);
    // Use the browser's real SVG path measurement — handles every command
    // (H/V/C/S/Q/T/A and relative variants) and excludes Bézier control points
    // from the bounding box.
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.opacity = '0';
    svg.style.pointerEvents = 'none';
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    document.body.appendChild(svg);
    let bbox: { x: number; y: number; width: number; height: number };
    try {
      bbox = path.getBBox();
    } finally {
      document.body.removeChild(svg);
    }
    const extent = Math.max(bbox.width, bbox.height) / 2;
    if (!isFinite(extent) || extent === 0) return raw;
    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const scale = r / extent;
    // Translate the path so its bbox center sits at the origin, then scale.
    // Matrix multiplication is right-to-left: scale * translate.
    const m = new DOMMatrix().scale(scale).translate(-cx, -cy);
    const fitted = new Path2D();
    fitted.addPath(raw, m);
    return fitted;
  } catch {
    return circle(r);
  }
}
