import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialKit } from 'dialkit';
import { generate, type GeneratorKind } from './generators';
import { applyRipple, type RippleKind } from './ripples';
import { buildShape, sampleBoundary, SHAPE_OPTIONS, type ShapeKind } from './shapes';

type RGB = { r: number; g: number; b: number };
function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}
function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

export function Composition() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [seed, setSeed] = useState(1);
  const [phase, setPhase] = useState(0);

  const p = useDialKit(
    'Ripple Dots',
    {
      generator: {
        type: 'select',
        options: [
          { value: 'radial', label: 'Radial' },
          { value: 'concentric', label: 'Concentric' },
          { value: 'spiral', label: 'Spiral' },
          { value: 'phyllotaxis', label: 'Phyllotaxis' },
          { value: 'grid', label: 'Grid' },
          { value: 'dither', label: 'Dither' },
        ],
        default: 'phyllotaxis',
      },
      composition: {
        shape: {
          type: 'select' as const,
          options: SHAPE_OPTIONS,
          default: 'heart' as const,
        },
        customPath: {
          type: 'text' as const,
          default: 'M 0 -80 L 70 60 L -70 60 Z',
          placeholder: 'SVG path d="..." (used when Shape = Custom)',
        },
        radius: [350, 40, 600],
        spacing: [16, 2, 60],
        density: [3, 1, 12],
        rotation: [0, -180, 180],
        tilt: [0, -89, 89],
        perspective: [900, 200, 4000, 10],
      },
      dot: {
        shape: {
          type: 'select' as const,
          options: [
            { value: 'round', label: 'Round' },
            { value: 'square', label: 'Square' },
            { value: 'line', label: 'Line' },
          ],
          default: 'round' as const,
        },
        size: [2.3, 0.5, 20, 0.1],
        lineLength: [6, 1, 40, 0.1],
        lineAngle: [0, -180, 180],
        mode: {
          type: 'select' as const,
          options: [
            { value: 'solid', label: 'Solid' },
            { value: 'heatmap', label: 'Heatmap' },
          ],
          default: 'heatmap',
        },
        color: '#f5f5f5',
        troughColor: '#3d6aff',
        crestColor: '#ff42dc',
        midColor: '#ffd53d',
        background: '#0b0b10',
        opacity: [1, 0, 1],
        depthFade: [0.15, 0, 1],
        crestGlow: [1, 0, 1],
      },
      ripple: {
        kind: {
          type: 'select' as const,
          options: [
            { value: 'off', label: 'Off' },
            { value: 'radial', label: 'Radial' },
            { value: 'concentric-pulse', label: 'Concentric Pulse' },
            { value: 'horizontal', label: 'Horizontal' },
            { value: 'twist', label: 'Twist' },
            { value: 'edge-wave', label: 'Edge Wave (shape)' },
            { value: 'edge-pulse', label: 'Edge Pulse (shape)' },
          ],
          default: 'edge-wave',
        },
        frequency: [1.4, 0.1, 30, 0.1],
        depth: [18, 0, 120],
        decay: [0, 0, 100],
        animate: false,
        speed: [1, 0, 5, 0.01],
      },
      shuffle: { type: 'action' as const },
    },
    {
      onAction: (action) => {
        if (action === 'shuffle') setSeed((s) => s + 1);
      },
      shortcuts: {
        'ripple.frequency': { key: 'f', mode: 'fine' },
        'ripple.depth': { key: 'd' },
        'composition.spacing': { key: 's' },
        'dot.size': { key: 'z', mode: 'fine' },
        'composition.rotation': { key: 'r' },
        'composition.tilt': { key: 't' },
      },
    },
  );

  useEffect(() => {
    if (!p.ripple.animate) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      setPhase((ph) => ph + dt * p.ripple.speed * 2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [p.ripple.animate, p.ripple.speed]);

  const shapeKind = p.composition.shape as ShapeKind;

  const dots = useMemo(
    () =>
      generate(p.generator as GeneratorKind, {
        radius: p.composition.radius,
        spacing: p.composition.spacing,
        dotSize: p.dot.size,
        density: p.composition.density,
        seed,
        bounds: shapeKind === 'circle' ? 'circle' : 'square',
      }),
    [
      p.generator,
      p.composition.radius,
      p.composition.spacing,
      p.composition.density,
      p.dot.size,
      seed,
      shapeKind,
    ],
  );

  // Mask dots to the chosen silhouette using Path2D + isPointInPath. The hit-
  // test context is a tiny offscreen canvas — no rendering happens here.
  const masked = useMemo(() => {
    if (shapeKind === 'circle' && p.composition.radius > 0) return dots;
    const path = buildShape(shapeKind, p.composition.radius, p.composition.customPath);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return dots;
    return dots.filter((d) => ctx.isPointInPath(path, d.x, d.y));
  }, [dots, shapeKind, p.composition.radius, p.composition.customPath]);

  // Sample the silhouette outline once per shape change; reused every frame
  // by edge-driven ripples (no recomputation when only phase changes).
  const boundary = useMemo(
    () => sampleBoundary(shapeKind, p.composition.radius, p.composition.customPath),
    [shapeKind, p.composition.radius, p.composition.customPath],
  );

  const rippled = useMemo(
    () =>
      applyRipple(masked, {
        kind: p.ripple.kind as RippleKind,
        frequency: p.ripple.frequency,
        depth: p.ripple.depth,
        decay: p.ripple.decay,
        phase,
        boundary,
      }),
    [masked, p.ripple.kind, p.ripple.frequency, p.ripple.depth, p.ripple.decay, phase, boundary],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = Math.min(window.innerWidth, window.innerHeight);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = p.dot.background;
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.translate(size / 2, size / 2);

    // 3D camera: yaw around Y, pitch around X, then perspective projection.
    const yaw = (p.composition.rotation * Math.PI) / 180;
    const pitch = (p.composition.tilt * Math.PI) / 180;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const focal = p.composition.perspective;

    // Project a point from shape-space to screen-space using yaw → pitch → perspective.
    const project = (x: number, y: number, z: number) => {
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y2 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      const scale = focal / (focal + z2);
      return { px: x1 * scale, py: y2 * scale, depth: z2, scale };
    };

    const dotShape = p.dot.shape;
    const lineHalfLen = (p.dot.lineLength * p.dot.size) / 2;
    const lineAngleRad = (p.dot.lineAngle * Math.PI) / 180;

    // Project all dots, then z-sort (painter's algorithm) so closer dots draw last.
    type P = {
      px: number;
      py: number;
      pr: number;
      depth: number;
      crest: number;
      // Line endpoints (only populated when shape === 'line')
      ax?: number;
      ay?: number;
      bx?: number;
      by?: number;
    };
    const projected: P[] = [];
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    let maxCrest = 0;
    for (const d of rippled) {
      const center = project(d.x, d.y, d.z);
      if (center.scale <= 0) continue;
      const crest = Math.abs(d.z);
      if (crest > maxCrest) maxCrest = crest;
      if (center.depth < minDepth) minDepth = center.depth;
      if (center.depth > maxDepth) maxDepth = center.depth;

      const out: P = {
        px: center.px,
        py: center.py,
        pr: Math.max(0.1, d.r * center.scale),
        depth: center.depth,
        crest: d.z,
      };

      if (dotShape === 'line') {
        // Orient each line along the radial direction (rotated by lineAngle).
        // Lines lying in the shape's local plane → both endpoints share Z, so
        // they foreshorten correctly under tilt by projecting both ends.
        const r2 = Math.hypot(d.x, d.y);
        const theta = r2 === 0 ? 0 : Math.atan2(d.y, d.x);
        const dx = Math.cos(theta + lineAngleRad) * lineHalfLen;
        const dy = Math.sin(theta + lineAngleRad) * lineHalfLen;
        const a = project(d.x - dx, d.y - dy, d.z);
        const b = project(d.x + dx, d.y + dy, d.z);
        out.ax = a.px;
        out.ay = a.py;
        out.bx = b.px;
        out.by = b.py;
      }

      projected.push(out);
    }
    projected.sort((a, b) => b.depth - a.depth);

    const depthRange = maxDepth - minDepth || 1;
    const fade = p.dot.depthFade;
    const glow = p.dot.crestGlow;
    const baseAlpha = p.dot.opacity;
    const heatmap = p.dot.mode === 'heatmap';

    if (!heatmap) ctx.fillStyle = p.dot.color;
    const trough = hexToRgb(p.dot.troughColor);
    const mid = hexToRgb(p.dot.midColor);
    const crest = hexToRgb(p.dot.crestColor);

    for (const d of projected) {
      const t = (d.depth - minDepth) / depthRange;
      const depthAlpha = 1 - fade * t;
      const crestNorm = maxCrest > 0 ? d.crest / maxCrest : 0;
      const crestAlpha = 1 + glow * crestNorm * 0.8;
      const alpha = Math.max(0, Math.min(1, baseAlpha * depthAlpha * crestAlpha));
      if (alpha <= 0) continue;

      if (heatmap) {
        // crestNorm is in [-1, 1]: -1 → trough, 0 → mid, +1 → crest
        const c =
          crestNorm >= 0
            ? lerpRgb(mid, crest, crestNorm)
            : lerpRgb(mid, trough, -crestNorm);
        const rgb = `rgb(${c.r},${c.g},${c.b})`;
        ctx.fillStyle = rgb;
        ctx.strokeStyle = rgb;
      } else if (dotShape === 'line') {
        ctx.strokeStyle = p.dot.color;
      }
      ctx.globalAlpha = alpha;

      if (dotShape === 'square') {
        const s = d.pr * 2;
        ctx.fillRect(d.px - d.pr, d.py - d.pr, s, s);
      } else if (dotShape === 'line') {
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(0.3, d.pr);
        ctx.beginPath();
        ctx.moveTo(d.ax!, d.ay!);
        ctx.lineTo(d.bx!, d.by!);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(d.px, d.py, d.pr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }, [
    rippled,
    p.dot.color,
    p.dot.background,
    p.dot.opacity,
    p.dot.depthFade,
    p.dot.crestGlow,
    p.dot.mode,
    p.dot.shape,
    p.dot.lineLength,
    p.dot.lineAngle,
    p.dot.troughColor,
    p.dot.midColor,
    p.dot.crestColor,
    p.composition.rotation,
    p.composition.tilt,
    p.composition.perspective,
  ]);

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: p.dot.background,
        transition: 'background 0.2s',
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
