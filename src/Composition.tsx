import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Pane } from 'tweakpane';
import { generate, type GeneratorKind } from './generators';
import { applyRipple, type ExtraSource, type RippleKind } from './ripples';
import { buildShape, sampleBoundary, type ShapeKind } from './shapes';
import { generatePath, INK_PATH_OPTIONS, type InkPath } from './placement';

type ImageBuffer = { data: Uint8ClampedArray; w: number; h: number };
type RGB = { r: number; g: number; b: number };

/**
 * Map a shape-space coordinate (origin at center, ±radius bounds) into pixel
 * coordinates within an image whose long edge is fit to 2 × radius. Returns
 * `null` if the point falls outside the image rectangle.
 */
function imagePixel(x: number, y: number, img: ImageBuffer, radius: number): number | null {
  const fit = (2 * radius) / Math.max(img.w, img.h);
  const dispW = img.w * fit;
  const dispH = img.h * fit;
  const u = (x + dispW / 2) / dispW;
  const v = (y + dispH / 2) / dispH;
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const px = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w)));
  const py = Math.min(img.h - 1, Math.max(0, Math.floor(v * img.h)));
  return (py * img.w + px) * 4;
}

// HSL helpers — used by ink mode to derive per-loop color variants from a
// single ink base color (hue ± shift, lightness ± shift).
function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rf:
        h = ((gf - bf) / d + (gf < bf ? 6 : 0)) * 60;
        break;
      case gf:
        h = ((bf - rf) / d + 2) * 60;
        break;
      case bf:
        h = ((rf - gf) / d + 4) * 60;
        break;
    }
  }
  return { h, s: s * 100, l: l * 100 };
}
function hslString(h: number, s: number, l: number, a: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(100, s));
  const ll = Math.max(0, Math.min(100, l));
  return `hsla(${hh.toFixed(1)}, ${ss.toFixed(1)}%, ${ll.toFixed(1)}%, ${a})`;
}

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

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULTS = {
  // Top-level rendering pipeline. 'dots' runs the existing dot system;
  // 'ink' bypasses dots and renders overlapping shape-clipped loop strokes
  // that get multiply-blended into a watercolor / ink-in-water look.
  renderMode: 'dots' as 'dots' | 'ink',
  generator: 'phyllotaxis' as GeneratorKind,
  // composition
  shape: 'heart' as ShapeKind,
  customPath: 'M 0 -80 L 70 60 L -70 60 Z',
  radius: 350,
  spacing: 16,
  density: 3,
  rotation: 0,
  tilt: 0,
  perspective: 900,
  // dot
  dotShape: 'round' as 'round' | 'square' | 'line',
  dotSize: 2.3,
  lineLength: 6,
  lineAngle: 0,
  mode: 'heatmap' as 'solid' | 'heatmap' | 'image',
  color: '#f5f5f5',
  troughColor: '#3d6aff',
  crestColor: '#ff42dc',
  midColor: '#ffd53d',
  background: '#0b0b10',
  opacity: 1,
  depthFade: 0.15,
  crestGlow: 1,
  // primary ripple
  rippleKind: 'edge-wave' as RippleKind,
  rippleFrequency: 1.4,
  rippleDepth: 18,
  rippleDecay: 0,
  rippleAnimate: false,
  rippleSpeed: 1,
  // Extra ripple sources — scattered point sources whose radial waves
  // interfere with the primary ripple to produce asymmetric patterns.
  extraCount: 0,
  extraDepth: 0.8, // relative to primary depth
  extraFreqJitter: 0.6, // ± multiplier on primary frequency
  extraSpread: 0.7, // fraction of radius the sources can wander to
  extraSeed: 1,
  // Ink mode — appearance
  // Defaults now target the reference look: crisp 1px strokes, no blur,
  // low alpha for clean overlap stacking on light backgrounds.
  inkCount: 90,
  inkColor: '#c83a8d',
  inkSizeMin: 60, // innermost circle radius at the end of the path
  inkSizeMax: 360, // outermost circle radius at the start of the path
  inkAspectVariance: 0, // pure circles by default; ramp up for ellipses
  inkAlpha: 0.14,
  inkLineWidth: 1.5,
  inkLineWidthVariance: 0,
  inkHueShift: 6, // tight hue variation matches the magenta reference
  inkLightnessShift: 8,
  inkBlur: 0, // canvas blur kills intersection definition — opt-in only
  inkGlowWidth: 0,
  inkGlowAlpha: 0.04,
  inkBlend: 'multiply' as 'multiply' | 'screen' | 'source-over' | 'lighter',
  inkVertices: 96,
  inkSeed: 1,
  // Ink mode — placement (the math that puts loop centers in space)
  inkPath: 'lissajous' as InkPath,
  inkPathA: 3, // for Lissajous default: 3:2 gives the "two eye" pattern
  inkPathB: 2,
  inkPathC: 0,
  inkPathD: 0,
  inkTurns: 1,
  inkPathPhase: 0,
  inkCenterShrink: 0, // 0 = path fills full bounds; 1 = converges to origin
  // The placement path fits inside a circle of radius = canvas radius ·
  // inkPathScale. Small values keep loop centers tightly clustered near the
  // origin so big circles overlap heavily across the whole canvas (the look
  // in the reference); 1 spreads centers all the way out.
  inkPathScale: 0.35,
  inkRadiusShrink: 0.65,
  // Ink mode — its OWN ripple controls, completely independent from dot ripples
  inkRippleKind: 'twist' as RippleKind,
  inkRippleFrequency: 0.6,
  inkRippleDepth: 30,
  inkRippleDecay: 0,
  inkRippleAnimate: false,
  inkRippleSpeed: 0.6,
  // Height-based ripple modes (radial / horizontal / edge-wave) output Z;
  // ink mode is 2D so we convert that Z to outward radial XY push, scaled
  // by this factor, so those modes still produce visible loop expansion.
  inkRippleZScale: 0.4,
};

export function Composition() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paramsRef = useRef({ ...DEFAULTS });
  // Refs to the per-mode bindings/folders so a separate effect can toggle
  // their visibility when Render Mode changes. Tweakpane exposes a `.hidden`
  // setter on every blade.
  const dotBladesRef = useRef<{ hidden: boolean }[]>([]);
  const inkBladesRef = useRef<{ hidden: boolean }[]>([]);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const [seed, setSeed] = useState(1);
  const [phase, setPhase] = useState(0);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageBuf, setImageBuf] = useState<ImageBuffer | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);

  useEffect(() => {
    if (!imageSrc) {
      setImageBuf(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      const maxEdge = 512;
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d');
      if (!cx) return;
      cx.drawImage(img, 0, 0, w, h);
      try {
        const id = cx.getImageData(0, 0, w, h);
        setImageBuf({ data: id.data, w, h });
      } catch {
        setImageBuf(null);
      }
    };
    img.onerror = () => !cancelled && setImageBuf(null);
    img.src = imageSrc;
    return () => {
      cancelled = true;
    };
  }, [imageSrc]);

  const handleFile = (file: File) => {
    setImageName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageSrc(reader.result);
    };
    reader.readAsDataURL(file);
  };

  // Mount Tweakpane once. All controls bind to paramsRef.current (mutable),
  // and a single 'change' listener forces a React re-render so useMemo deps
  // see the new values.
  useEffect(() => {
    if (!paneContainerRef.current) return;
    // Tweakpane 4 re-exports its API types from `@tweakpane/core`, but that
    // package isn't installed alongside `tweakpane` — so `Pane` only sees the
    // members declared on its own class (constructor, dispose, etc.). Cast to
    // any so the inherited FolderApi methods (addBinding, addFolder, on,
    // refresh, addButton) typecheck. They exist at runtime regardless.
    const pane = new Pane({
      container: paneContainerRef.current,
      title: 'Ripple Dots',
    }) as any;
    const params = paramsRef.current;

    pane.addBinding(params, 'renderMode', {
      label: 'Render Mode',
      options: { Dots: 'dots', Ink: 'ink' },
    });

    // ──────────── SHARED ────────────
    // Shape + Background are shared by both modes (the silhouette and the
    // canvas background colour matter regardless of what's being drawn).
    const shared = pane.addFolder({ title: 'Canvas' });
    shared.addBinding(params, 'shape', {
      options: {
        Circle: 'circle',
        Heart: 'heart',
        Star: 'star',
        Hexagon: 'hexagon',
        Triangle: 'triangle',
        Flower: 'flower',
        'Custom SVG': 'custom',
        Image: 'image',
      },
    });
    shared.addBinding(params, 'customPath', { label: 'Custom Path' });
    shared.addBinding(params, 'radius', { min: 40, max: 600, step: 1 });
    shared.addBinding(params, 'rotation', { min: -180, max: 180, step: 1 });
    shared.addBinding(params, 'background');

    // ──────────── DOT MODE ────────────
    const dotBlades: { hidden: boolean }[] = [];

    const generator = pane.addBinding(params, 'generator', {
      options: {
        Radial: 'radial',
        Concentric: 'concentric',
        Spiral: 'spiral',
        Phyllotaxis: 'phyllotaxis',
        Grid: 'grid',
        Dither: 'dither',
      },
    });
    dotBlades.push(generator);

    const comp = pane.addFolder({ title: 'Composition' });
    dotBlades.push(comp);
    comp.addBinding(params, 'spacing', { min: 2, max: 60, step: 1 });
    comp.addBinding(params, 'density', { min: 1, max: 12, step: 1 });
    comp.addBinding(params, 'tilt', { min: -89, max: 89, step: 1 });
    comp.addBinding(params, 'perspective', { min: 200, max: 4000, step: 10 });

    const dot = pane.addFolder({ title: 'Dot' });
    dotBlades.push(dot);
    dot.addBinding(params, 'dotShape', {
      label: 'Shape',
      options: { Round: 'round', Square: 'square', Line: 'line' },
    });
    dot.addBinding(params, 'dotSize', { label: 'Size', min: 0.5, max: 20, step: 0.1 });
    dot.addBinding(params, 'lineLength', { label: 'Line Length', min: 1, max: 40, step: 0.1 });
    dot.addBinding(params, 'lineAngle', { label: 'Line Angle', min: -180, max: 180, step: 1 });
    dot.addBinding(params, 'mode', {
      options: { Solid: 'solid', Heatmap: 'heatmap', Image: 'image' },
    });
    dot.addBinding(params, 'color');
    dot.addBinding(params, 'troughColor', { label: 'Trough Color' });
    dot.addBinding(params, 'crestColor', { label: 'Crest Color' });
    dot.addBinding(params, 'midColor', { label: 'Mid Color' });
    dot.addBinding(params, 'opacity', { min: 0, max: 1, step: 0.01 });
    dot.addBinding(params, 'depthFade', { label: 'Depth Fade', min: 0, max: 1, step: 0.01 });
    dot.addBinding(params, 'crestGlow', { label: 'Crest Glow', min: 0, max: 1, step: 0.01 });

    const rip = pane.addFolder({ title: 'Ripple' });
    dotBlades.push(rip);
    rip.addBinding(params, 'rippleKind', {
      label: 'Kind',
      options: {
        Off: 'off',
        Radial: 'radial',
        'Concentric Pulse': 'concentric-pulse',
        Horizontal: 'horizontal',
        Twist: 'twist',
        'Edge Wave (shape)': 'edge-wave',
        'Edge Pulse (shape)': 'edge-pulse',
      },
    });
    rip.addBinding(params, 'rippleFrequency', { label: 'Frequency', min: 0.1, max: 30, step: 0.1 });
    rip.addBinding(params, 'rippleDepth', { label: 'Depth', min: 0, max: 120, step: 1 });
    rip.addBinding(params, 'rippleDecay', { label: 'Decay', min: 0, max: 100, step: 1 });
    rip.addBinding(params, 'rippleAnimate', { label: 'Animate' });
    rip.addBinding(params, 'rippleSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });

    const extra = pane.addFolder({ title: 'Extra Ripples', expanded: false });
    dotBlades.push(extra);
    extra.addBinding(params, 'extraCount', { label: 'Count', min: 0, max: 12, step: 1 });
    extra.addBinding(params, 'extraDepth', { label: 'Depth Mix', min: 0, max: 2, step: 0.01 });
    extra.addBinding(params, 'extraFreqJitter', { label: 'Frequency Jitter', min: 0, max: 1, step: 0.01 });
    extra.addBinding(params, 'extraSpread', { label: 'Spread', min: 0.1, max: 1, step: 0.01 });
    extra.addBinding(params, 'extraSeed', { label: 'Seed', min: 0, max: 9999, step: 1 });
    extra.addButton({ title: 'Shuffle Sources' }).on('click', () => {
      params.extraSeed = Math.floor(Math.random() * 9999);
      pane.refresh();
      force();
    });

    const shuffleGen = pane.addButton({ title: 'Shuffle Generator' });
    shuffleGen.on('click', () => setSeed((s) => s + 1));
    dotBlades.push(shuffleGen);

    // ──────────── INK MODE ────────────
    const inkBlades: { hidden: boolean }[] = [];

    const ink = pane.addFolder({ title: 'Ink' });
    inkBlades.push(ink);
    ink.addBinding(params, 'inkCount', { label: 'Count', min: 1, max: 800, step: 1 });
    ink.addBinding(params, 'inkColor', { label: 'Ink Color' });
    ink.addBinding(params, 'inkSizeMin', { label: 'Size Min', min: 0, max: 600, step: 1 });
    ink.addBinding(params, 'inkSizeMax', { label: 'Size Max', min: 10, max: 800, step: 1 });
    ink.addBinding(params, 'inkRadiusShrink', {
      label: 'Radius Shrink',
      min: 0,
      max: 1,
      step: 0.01,
    });
    ink.addBinding(params, 'inkAspectVariance', {
      label: 'Aspect Variance',
      min: 0,
      max: 0.9,
      step: 0.01,
    });
    ink.addBinding(params, 'inkAlpha', { label: 'Stroke Alpha', min: 0.005, max: 0.5, step: 0.005 });
    ink.addBinding(params, 'inkLineWidth', { label: 'Line Width', min: 0.5, max: 30, step: 0.1 });
    ink.addBinding(params, 'inkLineWidthVariance', {
      label: 'Width Variance',
      min: 0,
      max: 1,
      step: 0.01,
    });
    ink.addBinding(params, 'inkGlowWidth', { label: 'Glow Width', min: 0, max: 60, step: 0.5 });
    ink.addBinding(params, 'inkGlowAlpha', { label: 'Glow Alpha', min: 0, max: 0.3, step: 0.005 });
    ink.addBinding(params, 'inkBlur', { label: 'Blur', min: 0, max: 12, step: 0.1 });
    ink.addBinding(params, 'inkHueShift', { label: 'Hue Jitter', min: 0, max: 180, step: 1 });
    ink.addBinding(params, 'inkLightnessShift', {
      label: 'Lightness Jitter',
      min: 0,
      max: 50,
      step: 1,
    });
    ink.addBinding(params, 'inkBlend', {
      label: 'Blend',
      options: {
        Multiply: 'multiply',
        Screen: 'screen',
        Normal: 'source-over',
        Lighter: 'lighter',
      },
    });
    ink.addBinding(params, 'inkVertices', { label: 'Vertices', min: 12, max: 256, step: 1 });
    ink.addBinding(params, 'inkSeed', { label: 'Seed', min: 0, max: 9999, step: 1 });
    ink.addButton({ title: 'Shuffle Ink' }).on('click', () => {
      params.inkSeed = Math.floor(Math.random() * 9999);
      pane.refresh();
      force();
    });

    // ──── Placement sub-folder ────
    // Where loop centers go. Each path mode is a deterministic curve sampled
    // at inkCount points. Param A/B/C/D mean different things per mode (see
    // INK_PATH_PARAM_LABELS in placement.ts and the README).
    const place = ink.addFolder({ title: 'Placement', expanded: true });
    place.addBinding(params, 'inkPath', {
      label: 'Path',
      options: Object.fromEntries(INK_PATH_OPTIONS.map((o) => [o.label, o.value])),
    });
    place.addBinding(params, 'inkPathA', { label: 'Param A', min: -5, max: 8, step: 0.01 });
    place.addBinding(params, 'inkPathB', { label: 'Param B', min: -5, max: 8, step: 0.01 });
    place.addBinding(params, 'inkPathC', { label: 'Param C', min: -3, max: 3, step: 0.01 });
    place.addBinding(params, 'inkPathD', { label: 'Param D', min: -3, max: 3, step: 0.01 });
    place.addBinding(params, 'inkTurns', { label: 'Turns', min: 0.1, max: 12, step: 0.1 });
    place.addBinding(params, 'inkPathPhase', {
      label: 'Phase',
      min: 0,
      max: Math.PI * 2,
      step: 0.01,
    });
    place.addBinding(params, 'inkPathScale', {
      label: 'Path Scale',
      min: 0,
      max: 1,
      step: 0.01,
    });
    place.addBinding(params, 'inkCenterShrink', {
      label: 'Center Shrink',
      min: 0,
      max: 1,
      step: 0.01,
    });

    // Ink-only ripple settings — nested inside the Ink folder so the panel
    // visually reads as a single self-contained section, NOT shared with the
    // dot Ripple/Extra Ripples folders above.
    const inkRip = ink.addFolder({ title: 'Ripple', expanded: false });
    inkRip.addBinding(params, 'inkRippleKind', {
      label: 'Kind',
      options: {
        Off: 'off',
        Radial: 'radial',
        'Concentric Pulse': 'concentric-pulse',
        Horizontal: 'horizontal',
        Twist: 'twist',
        'Edge Wave (shape)': 'edge-wave',
        'Edge Pulse (shape)': 'edge-pulse',
      },
    });
    inkRip.addBinding(params, 'inkRippleFrequency', {
      label: 'Frequency',
      min: 0.05,
      max: 10,
      step: 0.05,
    });
    inkRip.addBinding(params, 'inkRippleDepth', { label: 'Depth', min: 0, max: 200, step: 1 });
    inkRip.addBinding(params, 'inkRippleDecay', { label: 'Decay', min: 0, max: 100, step: 1 });
    inkRip.addBinding(params, 'inkRippleZScale', {
      label: 'Z → Push',
      min: 0,
      max: 2,
      step: 0.01,
    });
    inkRip.addBinding(params, 'inkRippleAnimate', { label: 'Animate' });
    inkRip.addBinding(params, 'inkRippleSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });

    dotBladesRef.current = dotBlades;
    inkBladesRef.current = inkBlades;
    // Initial visibility — set BEFORE wiring change listener so the first
    // render sees the right state.
    const inDots = params.renderMode === 'dots';
    dotBlades.forEach((b) => (b.hidden = !inDots));
    inkBlades.forEach((b) => (b.hidden = inDots));

    pane.on('change', () => force());
    return () => {
      pane.dispose();
    };
  }, []);

  const p = paramsRef.current;

  // Toggle panel visibility when Render Mode flips. Runs after the mount
  // effect has populated the refs.
  useEffect(() => {
    const inDots = p.renderMode === 'dots';
    dotBladesRef.current.forEach((b) => (b.hidden = !inDots));
    inkBladesRef.current.forEach((b) => (b.hidden = inDots));
  }, [p.renderMode]);

  // Phase animation — drives whichever mode's animate toggle is on.
  const animate = p.renderMode === 'ink' ? p.inkRippleAnimate : p.rippleAnimate;
  const speed = p.renderMode === 'ink' ? p.inkRippleSpeed : p.rippleSpeed;
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      setPhase((ph) => ph + dt * speed * 2);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, speed]);

  const shapeKind = p.shape;

  const dots = useMemo(
    () =>
      generate(p.generator, {
        radius: p.radius,
        spacing: p.spacing,
        dotSize: p.dotSize,
        density: p.density,
        seed,
        bounds: shapeKind === 'circle' ? 'circle' : 'square',
      }),
    [p.generator, p.radius, p.spacing, p.density, p.dotSize, seed, shapeKind],
  );

  // Silhouette mask
  const masked = useMemo(() => {
    if (shapeKind === 'image') {
      if (!imageBuf) return dots;
      return dots.filter((d) => {
        const idx = imagePixel(d.x, d.y, imageBuf, p.radius);
        return idx !== null && imageBuf.data[idx + 3] > 128;
      });
    }
    if (shapeKind === 'circle' && p.radius > 0) return dots;
    const path = buildShape(shapeKind, p.radius, p.customPath);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return dots;
    return dots.filter((d) => ctx.isPointInPath(path, d.x, d.y));
  }, [dots, shapeKind, p.radius, p.customPath, imageBuf]);

  // Sample boundary once per shape change
  const boundary = useMemo(
    () => sampleBoundary(shapeKind, p.radius, p.customPath),
    [shapeKind, p.radius, p.customPath],
  );

  // Build extra ripple sources deterministically from seed + count + jitter.
  // Sources are placed inside the shape's bounding circle at radius
  // `extraSpread × shapeRadius`, with their wave depth/frequency varied so
  // they interfere unevenly with the primary wave.
  const extraSources = useMemo<ExtraSource[]>(() => {
    if (p.extraCount === 0) return [];
    const rand = mulberry32(p.extraSeed);
    const arr: ExtraSource[] = [];
    const maxR = p.radius * p.extraSpread;
    for (let i = 0; i < p.extraCount; i++) {
      const a = rand() * Math.PI * 2;
      // sqrt() gives uniform area distribution inside the disk
      const r = Math.sqrt(rand()) * maxR;
      const freqMult = 1 + (rand() - 0.5) * 2 * p.extraFreqJitter;
      const depthMult = 0.5 + rand() * 0.8;
      arr.push({
        x: Math.cos(a) * r,
        y: Math.sin(a) * r,
        frequency: Math.max(0.1, p.rippleFrequency * freqMult),
        depth: p.rippleDepth * p.extraDepth * depthMult,
        phaseOffset: rand() * Math.PI * 2,
      });
    }
    return arr;
  }, [
    p.extraCount,
    p.extraSeed,
    p.extraDepth,
    p.extraFreqJitter,
    p.extraSpread,
    p.radius,
    p.rippleFrequency,
    p.rippleDepth,
  ]);

  const rippled = useMemo(
    () =>
      applyRipple(masked, {
        kind: p.rippleKind,
        frequency: p.rippleFrequency,
        depth: p.rippleDepth,
        decay: p.rippleDecay,
        phase,
        boundary,
        extraSources,
      }),
    [
      masked,
      p.rippleKind,
      p.rippleFrequency,
      p.rippleDepth,
      p.rippleDecay,
      phase,
      boundary,
      extraSources,
    ],
  );

  // Loops: each loop is an ellipse with center, semi-axes, rotation, and a
  // per-loop color shift (hue / lightness) derived deterministically from the
  // seed. Sampled into per-loop vertex Dot[] at render time so ripple/animate
  // distort the contour.
  type Loop = {
    cx: number;
    cy: number;
    a: number;
    b: number;
    rotation: number;
    dh: number;
    dl: number;
  };
  const loops = useMemo<Loop[]>(() => {
    if (p.renderMode !== 'ink') return [];
    // Centers walk a deterministic mathematical path (Lissajous, spiral, rose,
    // trochoid, attractor, …). Path radius is the canvas radius so the outer
    // sweep fills the silhouette.
    const centers = generatePath(p.inkPath, {
      count: p.inkCount,
      // pathScale is the fraction of canvas radius the path actually fills;
      // smaller value = tighter center cluster, bigger overlap density.
      radius: p.radius * p.inkPathScale,
      pathA: p.inkPathA,
      pathB: p.inkPathB,
      pathC: p.inkPathC,
      pathD: p.inkPathD,
      turns: p.inkTurns,
      phase: p.inkPathPhase,
      centerShrink: p.inkCenterShrink,
    });
    // Color jitter is still seeded so Shuffle Ink keeps producing variations
    // without disturbing the placement geometry.
    const colorRand = mulberry32(p.inkSeed);
    const aspectRand = mulberry32(p.inkSeed ^ 0x9e3779b9);
    const sizeMax = Math.max(p.inkSizeMin, p.inkSizeMax);
    const sizeMin = Math.min(p.inkSizeMin, p.inkSizeMax);
    const arr: Loop[] = [];
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i];
      const t = centers.length === 1 ? 0 : i / (centers.length - 1);
      // Linear radius taper along the path: outer → inner.
      const baseR = sizeMax + (sizeMin - sizeMax) * t * p.inkRadiusShrink;
      const aspect =
        p.inkAspectVariance === 0 ? 1 : 1 + (aspectRand() - 0.5) * 2 * p.inkAspectVariance;
      const a = baseR * (aspect >= 1 ? 1 : aspect);
      const b = baseR * (aspect >= 1 ? 1 / aspect : 1);
      const rotation = p.inkAspectVariance === 0 ? 0 : aspectRand() * Math.PI * 2;
      const dh = (colorRand() - 0.5) * 2 * p.inkHueShift;
      const dl = (colorRand() - 0.5) * 2 * p.inkLightnessShift;
      arr.push({ cx: c.x, cy: c.y, a, b, rotation, dh, dl });
    }
    return arr;
  }, [
    p.renderMode,
    p.inkCount,
    p.inkSeed,
    p.inkSizeMin,
    p.inkSizeMax,
    p.inkRadiusShrink,
    p.inkAspectVariance,
    p.inkHueShift,
    p.inkLightnessShift,
    p.inkPath,
    p.inkPathA,
    p.inkPathB,
    p.inkPathC,
    p.inkPathD,
    p.inkTurns,
    p.inkPathPhase,
    p.inkPathScale,
    p.inkCenterShrink,
    p.radius,
  ]);

  // Render
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

    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, size, size);

    // ============================================================
    // INK MODE — overlapping shape-clipped loop strokes
    // ============================================================
    if (p.renderMode === 'ink') {
      ctx.save();
      ctx.translate(size / 2, size / 2);

      // Yaw rotates the whole composition in-plane; tilt is intentionally
      // ignored in ink mode (it's a 2D effect).
      const yaw = (p.rotation * Math.PI) / 180;
      if (yaw !== 0) ctx.rotate(yaw);

      // Clip to the active shape silhouette so loops fade out at the edges.
      const clipPath = buildShape(shapeKind, p.radius, p.customPath);
      ctx.clip(clipPath);

      const baseHsl = rgbToHsl(hexToRgb(p.inkColor));
      ctx.globalCompositeOperation = p.inkBlend;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (p.inkBlur > 0) ctx.filter = `blur(${p.inkBlur}px)`;

      const nVerts = p.inkVertices;
      const lwBase = p.inkLineWidth;
      const lwVar = p.inkLineWidthVariance;
      const zScale = p.inkRippleZScale;
      // Per-loop line-width variance is deterministic by re-seeding from the
      // same ink seed (so it stays stable across renders).
      const widthRand = mulberry32(p.inkSeed ^ 0xa5);

      // The unit circle is identical for every loop, so compute its cos/sin
      // table ONCE here instead of nVerts trig calls per loop. At high counts
      // this removes the dominant redundant cost (e.g. 800 loops × 96 verts =
      // ~153k trig calls collapse to 96).
      const unitCos = new Float64Array(nVerts);
      const unitSin = new Float64Array(nVerts);
      for (let i = 0; i < nVerts; i++) {
        const t = (i / nVerts) * Math.PI * 2;
        unitCos[i] = Math.cos(t);
        unitSin[i] = Math.sin(t);
      }

      for (const L of loops) {
        // 1. Build the loop's vertex polygon (closed ellipse) in shape space.
        const verts = new Array(nVerts);
        const cr = Math.cos(L.rotation);
        const sr = Math.sin(L.rotation);
        for (let i = 0; i < nVerts; i++) {
          const lx = unitCos[i] * L.a;
          const ly = unitSin[i] * L.b;
          verts[i] = {
            x: L.cx + lx * cr - ly * sr,
            y: L.cy + lx * sr + ly * cr,
            r: 0,
          };
        }

        // 2. Warp with the INK-OWN ripple settings (not the dot Ripple).
        const warped = applyRipple(verts, {
          kind: p.inkRippleKind,
          frequency: p.inkRippleFrequency,
          depth: p.inkRippleDepth,
          decay: p.inkRippleDecay,
          phase,
          boundary,
        });

        // 3. Ink is 2D, so any Z output from height-based modes (radial /
        // horizontal / edge-wave) would be invisible. Translate it into an
        // outward radial push from the world origin — wave crests now bulge
        // the loops out, troughs pull them in.
        if (zScale !== 0) {
          for (const w of warped) {
            if (w.z === 0) continue;
            const r = Math.hypot(w.x, w.y);
            if (r === 0) continue;
            const k = (w.z * zScale) / r;
            w.x += w.x * k;
            w.y += w.y * k;
          }
        }

        // 4. Per-loop line width with deterministic ± variance
        const wJitter = (widthRand() - 0.5) * 2 * lwVar;
        const loopWidth = Math.max(0.3, lwBase * (1 + wJitter));

        // 5. Glow halo pass (optional, very wide low-alpha stroke under the
        // main line — adds the "inner shadow" depth where loops overlap).
        if (p.inkGlowWidth > 0) {
          ctx.lineWidth = loopWidth + p.inkGlowWidth;
          ctx.strokeStyle = hslString(
            baseHsl.h + L.dh,
            baseHsl.s,
            baseHsl.l + L.dl,
            p.inkGlowAlpha,
          );
          ctx.beginPath();
          for (let i = 0; i < nVerts; i++) {
            const w = warped[i];
            if (i === 0) ctx.moveTo(w.x, w.y);
            else ctx.lineTo(w.x, w.y);
          }
          ctx.closePath();
          ctx.stroke();
        }

        // 6. Main line pass.
        ctx.lineWidth = loopWidth;
        ctx.strokeStyle = hslString(
          baseHsl.h + L.dh,
          baseHsl.s,
          baseHsl.l + L.dl,
          p.inkAlpha,
        );
        ctx.beginPath();
        for (let i = 0; i < nVerts; i++) {
          const w = warped[i];
          if (i === 0) ctx.moveTo(w.x, w.y);
          else ctx.lineTo(w.x, w.y);
        }
        ctx.closePath();
        ctx.stroke();
      }

      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      return;
    }

    // ============================================================
    // DOT MODE
    // ============================================================
    ctx.save();
    ctx.translate(size / 2, size / 2);

    const yaw = (p.rotation * Math.PI) / 180;
    const pitch = (p.tilt * Math.PI) / 180;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const focal = p.perspective;

    const project = (x: number, y: number, z: number) => {
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y2 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      const scale = focal / (focal + z2);
      return { px: x1 * scale, py: y2 * scale, depth: z2, scale };
    };

    const dotShape = p.dotShape;
    const lineHalfLen = (p.lineLength * p.dotSize) / 2;
    const lineAngleRad = (p.lineAngle * Math.PI) / 180;
    const sampleImage = p.mode === 'image' && imageBuf;

    type P = {
      px: number;
      py: number;
      pr: number;
      depth: number;
      crest: number;
      ax?: number;
      ay?: number;
      bx?: number;
      by?: number;
      ir?: number;
      ig?: number;
      ib?: number;
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

      if (sampleImage) {
        const idx = imagePixel(d.x, d.y, imageBuf!, p.radius);
        if (idx !== null) {
          out.ir = imageBuf!.data[idx];
          out.ig = imageBuf!.data[idx + 1];
          out.ib = imageBuf!.data[idx + 2];
        }
      }

      if (dotShape === 'line') {
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
    const fade = p.depthFade;
    const glow = p.crestGlow;
    const baseAlpha = p.opacity;
    const heatmap = p.mode === 'heatmap';

    if (!heatmap && p.mode !== 'image') ctx.fillStyle = p.color;
    const trough = hexToRgb(p.troughColor);
    const mid = hexToRgb(p.midColor);
    const crest = hexToRgb(p.crestColor);

    for (const d of projected) {
      const t = (d.depth - minDepth) / depthRange;
      const depthAlpha = 1 - fade * t;
      const crestNorm = maxCrest > 0 ? d.crest / maxCrest : 0;
      const crestAlpha = 1 + glow * crestNorm * 0.8;
      const alpha = Math.max(0, Math.min(1, baseAlpha * depthAlpha * crestAlpha));
      if (alpha <= 0) continue;

      if (p.mode === 'image' && d.ir !== undefined) {
        const rgb = `rgb(${d.ir},${d.ig},${d.ib})`;
        ctx.fillStyle = rgb;
        ctx.strokeStyle = rgb;
      } else if (heatmap) {
        const c =
          crestNorm >= 0
            ? lerpRgb(mid, crest, crestNorm)
            : lerpRgb(mid, trough, -crestNorm);
        const rgb = `rgb(${c.r},${c.g},${c.b})`;
        ctx.fillStyle = rgb;
        ctx.strokeStyle = rgb;
      } else if (dotShape === 'line') {
        ctx.strokeStyle = p.color;
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
    p.color,
    p.background,
    p.opacity,
    p.depthFade,
    p.crestGlow,
    p.mode,
    p.troughColor,
    p.midColor,
    p.crestColor,
    p.rotation,
    p.tilt,
    p.perspective,
    p.dotShape,
    p.lineLength,
    p.lineAngle,
    imageBuf,
    p.radius,
    // Ink mode deps
    p.renderMode,
    loops,
    p.inkColor,
    p.inkAlpha,
    p.inkLineWidth,
    p.inkLineWidthVariance,
    p.inkGlowWidth,
    p.inkGlowAlpha,
    p.inkBlur,
    p.inkBlend,
    p.inkVertices,
    p.inkRippleKind,
    p.inkRippleFrequency,
    p.inkRippleDepth,
    p.inkRippleDecay,
    p.inkRippleZScale,
    p.inkSeed,
    p.customPath,
    boundary,
    extraSources,
    p.rippleKind,
    p.rippleFrequency,
    p.rippleDepth,
    p.rippleDecay,
    phase,
    shapeKind,
  ]);

  const needsImage = shapeKind === 'image' || p.mode === 'image';

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: p.background,
        transition: 'background 0.2s',
      }}
    >
      <canvas ref={canvasRef} />
      <div
        ref={paneContainerRef}
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          width: 280,
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
        }}
      />
      {needsImage && (
        <div
          style={{
            position: 'fixed',
            top: 16,
            left: 16,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: '8px 12px',
            background: 'rgba(20, 20, 28, 0.75)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8,
            color: '#e5e5e5',
            fontSize: 12,
            backdropFilter: 'blur(8px)',
          }}
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: '6px 12px',
              background: '#2a2a36',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              color: '#f5f5f5',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {imageBuf ? 'Replace Image' : 'Load Image'}
          </button>
          <span
            style={{
              opacity: 0.7,
              maxWidth: 200,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {imageBuf ? `${imageName ?? 'image'} (${imageBuf.w}×${imageBuf.h})` : 'No image loaded'}
          </span>
          {imageBuf && (
            <button
              type="button"
              onClick={() => {
                setImageSrc(null);
                setImageName(null);
              }}
              style={{
                padding: '4px 8px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6,
                color: '#999',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Clear
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
          />
        </div>
      )}
    </div>
  );
}
