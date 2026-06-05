import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Pane } from 'tweakpane';
import { generate, type GeneratorKind } from './generators';
import { applyRipple, type ExtraSource, type RippleKind } from './ripples';
import {
  buildShape,
  buildPolarRadius,
  polarRadiusAt,
  sampleBoundary,
  type ShapeKind,
} from './shapes';
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
  // Camera zoom — uniform scale of the rendered composition around the canvas
  // centre (shared by both modes). 1 = no zoom.
  zoom: 1,
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
  // Color mode: 'solid' uses Ink Color (+ jitter); 'gradient' colours each
  // element by its depth across 2–3 stops (near → far).
  inkColorMode: 'solid' as 'solid' | 'gradient',
  inkGradStops: 3,
  inkGradColor1: '#ff42dc',
  inkGradColor2: '#7d3cff',
  inkGradColor3: '#3d6aff',
  // Cull — keep only every Nth stroke (1 = all). Thins the dense cloud down
  // to a representative few REAL strokes: loops for Loops, strands for
  // Ribbons, rings for Ripples.
  inkCull: 1,
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
  // Ink camera. rotation (shared Canvas folder) spins the artwork in-plane;
  // tilt pitches it back into the screen; perspective is the focal length.
  // Ripple wave-height (Z) becomes real relief once tilted.
  inkTilt: 0,
  inkYaw: 0,
  inkPerspective: 900,
  // Depth. Spread offsets each loop along Z by its path progress so the
  // composition becomes a 3D stack/vortex instead of a flat disc. Fade is
  // atmospheric fog — loops farther from the camera lose alpha and recede.
  inkDepthSpread: 0,
  inkDepthFade: 0.4,
  // Ink sub-style. 'loops' = centered mathematical loops (default);
  // 'ribbons' = wide twirling horizontal bands; 'ripples' = concentric water
  // rings from drop sources placed on the math path, with true wave
  // superposition between sources.
  inkStyle: 'loops' as 'loops' | 'ribbons' | 'ripples' | 'plane',
  // Ripples (water) style. Drop sources are sampled from the Placement path;
  // each emits expanding concentric rings that ride on the combined wave
  // height field of all sources (superposition), so where two ripple sets
  // cross they interfere and bend.
  inkWaterSources: 3,
  inkWaterRings: 16,
  inkWaterSpacing: 26, // base radial gap between rings (px)
  inkWaterDecay: 1.3, // outward alpha falloff exponent (rings weaken as they spread)
  inkWaterAmp: 12, // superposition wave height → Z relief (visible under tilt)
  inkWaterFreq: 1, // wave number relative to ring spacing
  inkWaterBend: 9, // in-plane displacement from crossing waves (the interference bend)
  inkWaterAnimate: false,
  inkWaterSpeed: 0.5,
  // Plane style — a flat grid surface facing the camera. Droplets land on it
  // and emanate concentric ripples that displace the grid both in-plane (so
  // the rings read head-on) and in Z (real relief once the camera tilts).
  inkPlaneLines: 46, // grid lines per axis
  inkPlaneSize: 1.3, // plane half-extent as a fraction of radius
  inkPlaneGrid: 'both' as 'both' | 'rows',
  inkPlaneDrops: 3,
  inkPlaneSpread: 0.6, // how far drops scatter from centre
  inkPlaneRingFreq: 6, // rings from a drop out to the plane edge
  inkPlaneAmp: 26, // Z wave height (relief under tilt)
  inkPlaneBend: 10, // in-plane displacement (makes rings visible facing camera)
  inkPlaneFalloff: 1, // droplet energy fade outward
  // Spiral winds the wavefronts around each drop (0 = concentric rings; ± =
  // arms spiralling in/out). Wobble domain-warps the surface so the bands
  // undulate and flow organically instead of being perfect arcs — the
  // warping look from the reference. Scale = wobble frequency.
  inkPlaneSpiral: 0,
  inkPlaneWobble: 0,
  inkPlaneWobbleScale: 2,
  inkPlaneAnimate: false,
  inkPlaneSpeed: 0.6,
  // Ribbon style. Each ribbon is a horizontal band rendered as `strands`
  // parallel lines; the band twists about its length axis (into Z) so it
  // reads as a twirling streamer, and the wave phase animates the flow.
  // Defaults favour few wide ribbons (1–6): each ribbon is a dense strand
  // sheet spanning the canvas, so the droplet ripple reads from just 1–2.
  inkRibbonCount: 2,
  inkRibbonWidth: 560, // wide enough that one ribbon ≈ the whole surface
  inkRibbonAmplitude: 28, // gentle base undulation of the sheet
  inkRibbonWaveFreq: 1, // vertical wave cycles across the span
  inkRibbonTwist: 0.6, // mild twist (crank up for the twirling-streamer look)
  inkRibbonStrands: 110, // dense strands = the ripple contour lines
  inkRibbonSpan: 1.2, // total horizontal field as a fraction of 2·radius
  inkRibbonLength: 1, // each ribbon's length as a fraction of the span (1 = full width)
  inkRibbonSpread: 0.3, // keep the few ribbons near centre so they overlap
  inkRibbonAnimate: false,
  inkRibbonSpeed: 0.6,
  // Droplet ripple — concentric waves emanating from the canvas centre that
  // expand outward (and animate). Distance-from-centre based, so it ripples
  // symmetrically to every side. Rides mostly in Z so tilt shows the relief.
  // 0 amp = off.
  inkRibbonRippleAmp: 30,
  inkRibbonRippleFreq: 6, // ring count from the drop point outward
  inkRibbonRippleFalloff: 1.1, // how fast the droplet energy fades outward (0 = none)
  // Where the droplet rings emanate from. 'canvas' = concentric circles in the
  // flat canvas (screen-centred). 'ribbon' = rings spread across the ribbon's
  // own surface — along its length + across its width — so they follow the
  // band's undulating, twisting path through 3D space.
  inkRibbonRippleSource: 'ribbon' as 'canvas' | 'ribbon',
  // Additional droplets — extra drop points whose rings superpose/interfere
  // with the first. Drop 0 stays at the centre (count 1 = single droplet);
  // extras are seeded. Spread = how far the extras scatter from centre.
  inkRibbonDropCount: 1,
  inkRibbonDropSpread: 0.6,
  // Spiral winds each droplet's rings around its centre; Wobble domain-warps
  // the ring radius by angle so the bands undulate organically (ported from
  // the Plane style). Scale = wobble lobes.
  inkRibbonRippleSpiral: 0,
  inkRibbonRippleWobble: 0,
  inkRibbonRippleWobbleScale: 2,
  // How strongly the Canvas → Shape silhouette DEFORMS the ink field.
  // 0 = ignore shape (pure circular field); 1 = fully squish the ink into the
  // silhouette outline. This warps geometry rather than masking, so strokes
  // are never clipped — they bend to follow the shape.
  inkShapeInfluence: 1,
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
  // Ink sub-style blades toggled by inkStyle. Each entry lists which styles it
  // applies to; a blade is shown only when the current style is in its set.
  const inkStyleBladesRef = useRef<{ blade: { hidden: boolean }; styles: string[] }[]>([]);
  // The Tweakpane instance, so mode/style switches can refresh stale displays
  // (e.g. the two rotation bindings that share one param across modes).
  const paneRef = useRef<{ refresh: () => void } | null>(null);
  // The render effect stores its drawing closure here so PNG export can replay
  // it onto an offscreen canvas at a higher resolution.
  const drawSceneRef = useRef<
    ((ctx: CanvasRenderingContext2D, w: number, h: number) => void) | null
  >(null);
  const [, force] = useReducer((n: number) => n + 1, 0);
  // Bumped on window resize so the render effect re-reads viewport dimensions.
  const [resizeTick, bumpResize] = useReducer((n: number) => n + 1, 0);
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

  // Export the current composition as a PNG at an ABSOLUTE pixel resolution by
  // replaying the render closure onto an offscreen canvas. Using an absolute
  // target (rather than a multiple of the window) keeps it predictable and
  // independent of devicePixelRatio — on a retina screen the on-screen canvas
  // is already 2× the CSS size, which made the old "4×" only ~2× the visible
  // pixels. The artwork is drawn in the same logical `size` coordinate space
  // as the live view (so framing is identical); `scale` just multiplies the
  // pixel density.
  const exportPng = (targetPx: number) => {
    const draw = drawSceneRef.current;
    if (!draw) return;
    // Match the viewport aspect ratio; the long edge is targetPx.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = targetPx / Math.max(vw, vh);
    const off = document.createElement('canvas');
    off.width = Math.round(vw * scale);
    off.height = Math.round(vh * scale);
    const ctx = off.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    draw(ctx, vw, vh);
    off.toBlob((blob) => {
      if (!blob) {
        // Browsers cap canvas area (Safari especially). Fall back gracefully.
        // eslint-disable-next-line no-alert
        alert(`Export failed at ${targetPx}px — try a smaller size (your browser caps canvas area).`);
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ripple-${off.width}x${off.height}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
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

    // ──────────── CANVAS (shared) ────────────
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
    shared.addBinding(params, 'background');
    // Quick theme presets — Light = white bg + multiply; Dark = black bg +
    // screen. Refresh so the background/blend bindings reflect the change.
    const setTheme = (bg: string, blend: 'multiply' | 'screen') => {
      params.background = bg;
      params.inkBlend = blend;
      pane.refresh();
      force();
    };
    shared.addButton({ title: 'Light Mode' }).on('click', () => setTheme('#ffffff', 'multiply'));
    shared.addButton({ title: 'Dark Mode' }).on('click', () => setTheme('#000000', 'screen'));

    // ════════════ DOT MODE ════════════
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
    comp.addBinding(params, 'rotation', { label: 'Rotation', min: -180, max: 180, step: 1 });
    comp.addBinding(params, 'tilt', { min: -89, max: 89, step: 1 });
    comp.addBinding(params, 'perspective', { min: 200, max: 4000, step: 10 });
    comp.addBinding(params, 'zoom', { label: 'Zoom', min: 0.1, max: 5, step: 0.01 });

    const dot = pane.addFolder({ title: 'Dots' });
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

    const extra = pane.addFolder({ title: 'Extra Ripples' });
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

    // ════════════ INK MODE ════════════
    const inkBlades: { hidden: boolean }[] = [];
    // Style-tagged blades — shown only when the current inkStyle is listed.
    const styleBlades: { blade: { hidden: boolean }; styles: string[] }[] = [];
    const tag = (blade: { hidden: boolean }, styles: string[]) => {
      styleBlades.push({ blade, styles });
      return blade;
    };
    const LOOPS = ['loops'];
    const RIBBONS = ['ribbons'];
    const RIPPLES = ['ripples'];
    const PLANE = ['plane'];
    const LOOPS_RIPPLES = ['loops', 'ripples']; // Placement positions both

    const ink = pane.addFolder({ title: 'Ink' });
    inkBlades.push(ink);
    ink.addBinding(params, 'inkStyle', {
      label: 'Style',
      options: { Loops: 'loops', Ribbons: 'ribbons', Ripples: 'ripples', Plane: 'plane' },
    });

    // ──── Appearance (shared by all ink styles) ────
    const appear = ink.addFolder({ title: 'Appearance' });
    appear.addBinding(params, 'inkColor', { label: 'Ink Color' });
    appear.addBinding(params, 'inkColorMode', {
      label: 'Color Mode',
      options: { Solid: 'solid', 'Depth Gradient': 'gradient' },
    });
    appear.addBinding(params, 'inkGradStops', { label: 'Gradient Stops', min: 2, max: 3, step: 1 });
    appear.addBinding(params, 'inkGradColor1', { label: 'Grad Near' });
    appear.addBinding(params, 'inkGradColor2', { label: 'Grad Mid' });
    appear.addBinding(params, 'inkGradColor3', { label: 'Grad Far' });
    appear.addBinding(params, 'inkAlpha', { label: 'Stroke Alpha', min: 0.005, max: 1, step: 0.005 });
    appear.addBinding(params, 'inkLineWidth', { label: 'Line Width', min: 0.5, max: 30, step: 0.1 });
    appear.addBinding(params, 'inkLineWidthVariance', {
      label: 'Width Variance',
      min: 0,
      max: 1,
      step: 0.01,
    });
    appear.addBinding(params, 'inkBlur', { label: 'Blur', min: 0, max: 12, step: 0.1 });
    appear.addBinding(params, 'inkHueShift', { label: 'Hue Jitter', min: 0, max: 180, step: 1 });
    appear.addBinding(params, 'inkLightnessShift', {
      label: 'Lightness Jitter',
      min: 0,
      max: 50,
      step: 1,
    });
    appear.addBinding(params, 'inkBlend', {
      label: 'Blend',
      options: { Multiply: 'multiply', Screen: 'screen', Normal: 'source-over', Lighter: 'lighter' },
    });
    appear.addBinding(params, 'inkCull', { label: 'Cull (keep 1/N)', min: 1, max: 50, step: 1 });
    appear.addBinding(params, 'inkVertices', { label: 'Vertices', min: 12, max: 256, step: 1 });
    appear.addBinding(params, 'inkSeed', { label: 'Seed', min: 0, max: 9999, step: 1 });
    appear.addButton({ title: 'Shuffle Ink' }).on('click', () => {
      params.inkSeed = Math.floor(Math.random() * 9999);
      pane.refresh();
      force();
    });

    // ──── Placement (loops + ripples) ────
    const place = ink.addFolder({ title: 'Placement' });
    tag(place, LOOPS_RIPPLES);
    place.addBinding(params, 'inkPath', {
      label: 'Path',
      options: Object.fromEntries(INK_PATH_OPTIONS.map((o) => [o.label, o.value])),
    });
    place.addBinding(params, 'inkPathA', { label: 'Param A', min: -5, max: 8, step: 0.01 });
    place.addBinding(params, 'inkPathB', { label: 'Param B', min: -5, max: 8, step: 0.01 });
    place.addBinding(params, 'inkPathC', { label: 'Param C', min: -3, max: 3, step: 0.01 });
    place.addBinding(params, 'inkPathD', { label: 'Param D', min: -3, max: 3, step: 0.01 });
    place.addBinding(params, 'inkTurns', { label: 'Turns', min: 0.1, max: 12, step: 0.1 });
    place.addBinding(params, 'inkPathPhase', { label: 'Phase', min: 0, max: Math.PI * 2, step: 0.01 });
    place.addBinding(params, 'inkPathScale', { label: 'Path Scale', min: 0, max: 1, step: 0.01 });
    place.addBinding(params, 'inkCenterShrink', { label: 'Center Shrink', min: 0, max: 1, step: 0.01 });
    place.addBinding(params, 'inkShapeInfluence', {
      label: 'Shape Influence',
      min: 0,
      max: 1,
      step: 0.01,
    });

    // ──── Loops (loops only) ────
    const loops = ink.addFolder({ title: 'Loops' });
    tag(loops, LOOPS);
    loops.addBinding(params, 'inkCount', { label: 'Count', min: 1, max: 2500, step: 1 });
    loops.addBinding(params, 'inkSizeMin', { label: 'Size Min', min: 0, max: 600, step: 1 });
    loops.addBinding(params, 'inkSizeMax', { label: 'Size Max', min: 10, max: 800, step: 1 });
    loops.addBinding(params, 'inkRadiusShrink', { label: 'Radius Shrink', min: 0, max: 1, step: 0.01 });
    loops.addBinding(params, 'inkAspectVariance', {
      label: 'Aspect Variance',
      min: 0,
      max: 0.9,
      step: 0.01,
    });
    const loopRip = loops.addFolder({ title: 'Ripple' });
    loopRip.addBinding(params, 'inkRippleKind', {
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
    loopRip.addBinding(params, 'inkRippleFrequency', { label: 'Frequency', min: 0.05, max: 10, step: 0.05 });
    loopRip.addBinding(params, 'inkRippleDepth', { label: 'Depth', min: 0, max: 200, step: 1 });
    loopRip.addBinding(params, 'inkRippleDecay', { label: 'Decay', min: 0, max: 100, step: 1 });
    loopRip.addBinding(params, 'inkRippleZScale', { label: 'Z → Push', min: 0, max: 2, step: 0.01 });
    loopRip.addBinding(params, 'inkRippleAnimate', { label: 'Animate' });
    loopRip.addBinding(params, 'inkRippleSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });
    const loopGlow = loops.addFolder({ title: 'Glow' });
    loopGlow.addBinding(params, 'inkGlowWidth', { label: 'Glow Width', min: 0, max: 60, step: 0.5 });
    loopGlow.addBinding(params, 'inkGlowAlpha', { label: 'Glow Alpha', min: 0, max: 0.3, step: 0.005 });

    // ──── Ribbons (ribbons only) ────
    const rib = ink.addFolder({ title: 'Ribbons' });
    tag(rib, RIBBONS);
    rib.addBinding(params, 'inkRibbonCount', { label: 'Count', min: 1, max: 80, step: 1 });
    rib.addBinding(params, 'inkRibbonWidth', { label: 'Width', min: 4, max: 1400, step: 1 });
    rib.addBinding(params, 'inkRibbonStrands', { label: 'Strands', min: 1, max: 300, step: 1 });
    rib.addBinding(params, 'inkRibbonAmplitude', { label: 'Amplitude', min: 0, max: 400, step: 1 });
    rib.addBinding(params, 'inkRibbonWaveFreq', { label: 'Wave Freq', min: 0, max: 8, step: 0.05 });
    rib.addBinding(params, 'inkRibbonTwist', { label: 'Twist', min: 0, max: 10, step: 0.05 });
    rib.addBinding(params, 'inkRibbonSpan', { label: 'Span', min: 0.5, max: 6, step: 0.01 });
    rib.addBinding(params, 'inkRibbonLength', { label: 'Length', min: 0.05, max: 1, step: 0.01 });
    rib.addBinding(params, 'inkRibbonSpread', { label: 'Spread', min: 0, max: 1, step: 0.01 });
    const ribDrop = rib.addFolder({ title: 'Droplet' });
    ribDrop.addBinding(params, 'inkRibbonRippleAmp', { label: 'Droplet Amp', min: 0, max: 80, step: 0.5 });
    ribDrop.addBinding(params, 'inkRibbonRippleFreq', { label: 'Droplet Rings', min: 0, max: 16, step: 0.1 });
    ribDrop.addBinding(params, 'inkRibbonRippleFalloff', { label: 'Droplet Falloff', min: 0, max: 4, step: 0.05 });
    ribDrop.addBinding(params, 'inkRibbonRippleSource', {
      label: 'Droplet From',
      options: { 'Ribbon Surface': 'ribbon', Canvas: 'canvas' },
    });
    ribDrop.addBinding(params, 'inkRibbonDropCount', { label: 'Droplets', min: 1, max: 8, step: 1 });
    ribDrop.addBinding(params, 'inkRibbonDropSpread', { label: 'Drop Spread', min: 0, max: 1, step: 0.01 });
    ribDrop.addBinding(params, 'inkRibbonRippleSpiral', { label: 'Spiral', min: -6, max: 6, step: 0.05 });
    ribDrop.addBinding(params, 'inkRibbonRippleWobble', { label: 'Wobble', min: 0, max: 200, step: 1 });
    ribDrop.addBinding(params, 'inkRibbonRippleWobbleScale', {
      label: 'Wobble Scale',
      min: 0.2,
      max: 8,
      step: 0.05,
    });
    rib.addBinding(params, 'inkRibbonAnimate', { label: 'Animate (L→R)' });
    rib.addBinding(params, 'inkRibbonSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });

    // ──── Water Rings (ripples only) ────
    const water = ink.addFolder({ title: 'Water Rings' });
    tag(water, RIPPLES);
    water.addBinding(params, 'inkWaterSources', { label: 'Sources', min: 1, max: 12, step: 1 });
    water.addBinding(params, 'inkWaterRings', { label: 'Rings', min: 1, max: 60, step: 1 });
    water.addBinding(params, 'inkWaterSpacing', { label: 'Ring Spacing', min: 4, max: 80, step: 1 });
    water.addBinding(params, 'inkWaterDecay', { label: 'Outward Fade', min: 0, max: 4, step: 0.05 });
    water.addBinding(params, 'inkWaterAmp', { label: 'Wave Height', min: 0, max: 80, step: 0.5 });
    water.addBinding(params, 'inkWaterFreq', { label: 'Wave Freq', min: 0.1, max: 4, step: 0.05 });
    water.addBinding(params, 'inkWaterBend', { label: 'Interference', min: 0, max: 40, step: 0.5 });
    water.addBinding(params, 'inkWaterAnimate', { label: 'Animate (expand)' });
    water.addBinding(params, 'inkWaterSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });

    // ──── Plane (plane only) ────
    const plane = ink.addFolder({ title: 'Plane' });
    tag(plane, PLANE);
    plane.addBinding(params, 'inkPlaneLines', { label: 'Grid Lines', min: 4, max: 750, step: 1 });
    plane.addBinding(params, 'inkPlaneSize', { label: 'Plane Size', min: 0.4, max: 2, step: 0.01 });
    plane.addBinding(params, 'inkPlaneGrid', {
      label: 'Grid',
      options: { 'Rows + Cols': 'both', 'Rows only': 'rows' },
    });
    const planeDrop = plane.addFolder({ title: 'Droplet' });
    planeDrop.addBinding(params, 'inkPlaneDrops', { label: 'Droplets', min: 1, max: 12, step: 1 });
    planeDrop.addBinding(params, 'inkPlaneSpread', { label: 'Drop Spread', min: 0, max: 1, step: 0.01 });
    planeDrop.addBinding(params, 'inkPlaneRingFreq', { label: 'Ring Freq', min: 0.5, max: 20, step: 0.1 });
    planeDrop.addBinding(params, 'inkPlaneAmp', { label: 'Wave Height', min: 0, max: 120, step: 1 });
    planeDrop.addBinding(params, 'inkPlaneBend', { label: 'Surface Bend', min: 0, max: 40, step: 0.5 });
    planeDrop.addBinding(params, 'inkPlaneFalloff', { label: 'Falloff', min: 0, max: 4, step: 0.05 });
    planeDrop.addBinding(params, 'inkPlaneAnimate', { label: 'Animate (expand)' });
    planeDrop.addBinding(params, 'inkPlaneSpeed', { label: 'Speed', min: 0, max: 5, step: 0.01 });
    const planePat = plane.addFolder({ title: 'Pattern' });
    planePat.addBinding(params, 'inkPlaneSpiral', { label: 'Spiral', min: -6, max: 6, step: 0.05 });
    planePat.addBinding(params, 'inkPlaneWobble', { label: 'Wobble', min: 0, max: 200, step: 1 });
    planePat.addBinding(params, 'inkPlaneWobbleScale', { label: 'Wobble Scale', min: 0.2, max: 8, step: 0.05 });

    // ──────────── CAMERA (ink, top level) ────────────
    // Top-level folder between Ink and Export. Ink-only, so it hides in Dots
    // mode (Dots has its own camera controls in Composition).
    const cam = pane.addFolder({ title: 'Camera' });
    inkBlades.push(cam);
    cam.addBinding(params, 'rotation', { label: 'Roll (Z)', min: -180, max: 180, step: 1 });
    cam.addBinding(params, 'inkTilt', { label: 'Pitch / Tilt (X)', min: -180, max: 180, step: 1 });
    cam.addBinding(params, 'inkYaw', { label: 'Yaw (Y)', min: -180, max: 180, step: 1 });
    cam.addBinding(params, 'inkPerspective', { label: 'Perspective', min: 200, max: 4000, step: 10 });
    cam.addBinding(params, 'zoom', { label: 'Zoom', min: 0.1, max: 5, step: 0.01 });
    cam.addBinding(params, 'inkDepthSpread', { label: 'Depth Spread', min: 0, max: 6, step: 0.01 });
    cam.addBinding(params, 'inkDepthFade', { label: 'Depth Fade', min: 0, max: 1, step: 0.01 });

    // ──────────── EXPORT (shared) ────────────
    const exp = pane.addFolder({ title: 'Export', expanded: false });
    exp.addButton({ title: 'PNG 2048px' }).on('click', () => exportPng(2048));
    exp.addButton({ title: 'PNG 4096px' }).on('click', () => exportPng(4096));
    exp.addButton({ title: 'PNG 8192px' }).on('click', () => exportPng(8192));

    paneRef.current = pane;
    dotBladesRef.current = dotBlades;
    inkBladesRef.current = inkBlades;
    inkStyleBladesRef.current = styleBlades;
    // Initial visibility — set BEFORE wiring change listener so the first
    // render sees the right state.
    const inDots = params.renderMode === 'dots';
    dotBlades.forEach((b) => (b.hidden = !inDots));
    inkBlades.forEach((b) => (b.hidden = inDots));
    styleBlades.forEach(({ blade, styles }) => (blade.hidden = !styles.includes(params.inkStyle)));

    pane.on('change', () => force());
    return () => {
      pane.dispose();
    };
  }, []);

  const p = paramsRef.current;
  const prevModeRef = useRef(p.renderMode);

  // Redraw on window resize (canvas fills the viewport).
  useEffect(() => {
    const onResize = () => bumpResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Toggle panel visibility when Render Mode flips. Runs after the mount
  // effect has populated the refs.
  useEffect(() => {
    // Entering ink mode: start from a clean ink-friendly state — Light theme
    // (white bg + multiply) and a Circle canvas — rather than the dark/heart
    // dot defaults. Only on the dots→ink transition so it doesn't clobber
    // tweaks made within an ink session.
    if (p.renderMode === 'ink' && prevModeRef.current !== 'ink') {
      p.background = '#ffffff';
      p.inkBlend = 'multiply';
      p.shape = 'circle';
      paneRef.current?.refresh();
      force();
    }
    prevModeRef.current = p.renderMode;

    const inDots = p.renderMode === 'dots';
    dotBladesRef.current.forEach((b) => (b.hidden = !inDots));
    inkBladesRef.current.forEach((b) => (b.hidden = inDots));
    // Within ink mode, show only the blades tagged for the active sub-style.
    inkStyleBladesRef.current.forEach(
      ({ blade, styles }) => (blade.hidden = !styles.includes(p.inkStyle)),
    );
    // Sync any bindings that share a param across modes (e.g. rotation).
    paneRef.current?.refresh();
  }, [p.renderMode, p.inkStyle]);

  // Phase animation — drives whichever mode's animate toggle is on.
  let animate: boolean;
  let speed: number;
  if (p.renderMode === 'ink') {
    if (p.inkStyle === 'ribbons') {
      animate = p.inkRibbonAnimate;
      speed = p.inkRibbonSpeed;
    } else if (p.inkStyle === 'ripples') {
      animate = p.inkWaterAnimate;
      speed = p.inkWaterSpeed;
    } else if (p.inkStyle === 'plane') {
      animate = p.inkPlaneAnimate;
      speed = p.inkPlaneSpeed;
    } else {
      animate = p.inkRippleAnimate;
      speed = p.inkRippleSpeed;
    }
  } else {
    animate = p.rippleAnimate;
    speed = p.rippleSpeed;
  }
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
    cz: number; // center depth — offsets the loop along Z for 3D stacking
    a: number;
    b: number;
    rotation: number;
    dh: number;
    dl: number;
  };
  const loops = useMemo<Loop[]>(() => {
    if (p.renderMode !== 'ink' || p.inkStyle !== 'loops') return [];
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
      // Stack along Z by path progress, centered so the composition straddles
      // z = 0. Combined with radius taper this makes a 3D winding vortex.
      const cz = (t - 0.5) * p.inkDepthSpread * p.radius;
      arr.push({ cx: c.x, cy: c.y, cz, a, b, rotation, dh, dl });
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
    p.inkDepthSpread,
    p.inkStyle,
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

  // Water ripple drop sources — sampled from the same Placement path as loops,
  // with per-source color/phase jitter. Positions are static (don't depend on
  // animation phase); the rings expand at render time.
  type WaterSource = { x: number; y: number; dh: number; dl: number; phaseOff: number };
  const waterSources = useMemo<WaterSource[]>(() => {
    if (p.renderMode !== 'ink' || p.inkStyle !== 'ripples') return [];
    const pts = generatePath(p.inkPath, {
      count: p.inkWaterSources,
      radius: p.radius * p.inkPathScale,
      pathA: p.inkPathA,
      pathB: p.inkPathB,
      pathC: p.inkPathC,
      pathD: p.inkPathD,
      turns: p.inkTurns,
      phase: p.inkPathPhase,
      centerShrink: p.inkCenterShrink,
    });
    const rand = mulberry32(p.inkSeed);
    return pts.map((c) => ({
      x: c.x,
      y: c.y,
      dh: (rand() - 0.5) * 2 * p.inkHueShift,
      dl: (rand() - 0.5) * 2 * p.inkLightnessShift,
      phaseOff: rand() * Math.PI * 2,
    }));
  }, [
    p.renderMode,
    p.inkStyle,
    p.inkWaterSources,
    p.inkPath,
    p.inkPathA,
    p.inkPathB,
    p.inkPathC,
    p.inkPathD,
    p.inkTurns,
    p.inkPathPhase,
    p.inkPathScale,
    p.inkCenterShrink,
    p.inkHueShift,
    p.inkLightnessShift,
    p.inkSeed,
    p.radius,
  ]);

  // Render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // Canvas fills the full viewport (was a centered square).
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // All drawing lives in paint() so PNG export can replay it onto an
    // offscreen canvas. ctx/w/h are params (shadow the outer canvas refs);
    // the function is hoisted, so the call + ref assignment above it work.
    drawSceneRef.current = paint;
    paint(ctx, w, h);

    function paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, w, h);

    // ============================================================
    // INK MODE — overlapping shape-clipped loop strokes
    // ============================================================
    if (p.renderMode === 'ink') {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      if (p.zoom !== 1) ctx.scale(p.zoom, p.zoom);

      // 3D camera. Rotation spins the artwork in-plane (around the viewing
      // axis); tilt pitches it back around the horizontal axis; perspective
      // foreshortens. Applied per-vertex below so ripple wave-height (Z)
      // shows as real relief once tilted.
      // Full 3-axis camera: roll (Z / viewing axis, in-plane spin), pitch
      // (X axis), yaw (Y axis). Projection order: yaw → pitch → roll → divide.
      const roll = (p.rotation * Math.PI) / 180;
      const cosR = Math.cos(roll);
      const sinR = Math.sin(roll);
      const pitch = (p.inkTilt * Math.PI) / 180;
      const cosP = Math.cos(pitch);
      const sinP = Math.sin(pitch);
      const yaw = (p.inkYaw * Math.PI) / 180;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const focal = p.inkPerspective;
      const depthSpread = p.inkDepthSpread;
      const depthFade = p.inkDepthFade;
      // Project whenever spin / tilt / depth is in play. Flat default stays a
      // no-op (and cheap) when all three are zero.
      const cameraActive = roll !== 0 || pitch !== 0 || yaw !== 0 || depthSpread > 0;

      // Fog pre-pass: project each loop's center to a camera-space depth, then
      // find the range so we can fade far loops. Cheap (≤800 centers). We use
      // the loop center (pre-ripple/warp) as a stable per-loop depth proxy.
      const loopDepth = new Float64Array(loops.length);
      let minDepth = Infinity;
      let maxDepth = -Infinity;
      // Run when fog needs it (camera active) OR gradient is on — gradient
      // needs a valid depth range even on a flat view, else t = NaN and nothing
      // draws.
      if ((cameraActive && depthFade > 0) || p.inkColorMode === 'gradient') {
        for (let li = 0; li < loops.length; li++) {
          const L = loops[li];
          // Camera-space depth of the loop centre (yaw then pitch; roll doesn't
          // change depth).
          const zy = -L.cx * sinY + L.cz * cosY;
          const d = L.cy * sinP + zy * cosP;
          loopDepth[li] = d;
          if (d < minDepth) minDepth = d;
          if (d > maxDepth) maxDepth = d;
        }
      }
      // Guard against a degenerate/empty range (flat view → all equal depths).
      const depthRange = maxDepth > minDepth ? maxDepth - minDepth : 1;
      const fogActive = depthFade > 0 && cameraActive;

      // Shape DEFORMS the ink field instead of masking it. Build a polar
      // radius table from the silhouette; each point's distance-from-origin is
      // scaled by mix(1, shapeRadius(θ)/radius, influence) so the whole field
      // is squished into the shape outline — no clipping, strokes bend to
      // follow the contour. A circle gives factor 1 everywhere (no-op).
      const influence = p.inkShapeInfluence;
      const useShapeWarp = influence > 0 && shapeKind !== 'circle' && shapeKind !== 'image';
      const polar = useShapeWarp ? buildPolarRadius(boundary) : null;
      const invRadius = p.radius > 0 ? 1 / p.radius : 0;

      const baseHsl = rgbToHsl(hexToRgb(p.inkColor));
      ctx.globalCompositeOperation = p.inkBlend;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (p.inkBlur > 0) ctx.filter = `blur(${p.inkBlur}px)`;

      // Depth gradient — when on, each element is coloured by its normalised
      // depth t∈[0,1] (near→far) across 2 or 3 stops instead of the ink colour.
      const gradOn = p.inkColorMode === 'gradient';
      const gA = hexToRgb(p.inkGradColor1);
      const gB = hexToRgb(p.inkGradColor2);
      const gC = hexToRgb(p.inkGradColor3);
      const gStops = p.inkGradStops;
      const gradColor = (t: number, alpha: number) => {
        const tt = !Number.isFinite(t) ? 0 : t < 0 ? 0 : t > 1 ? 1 : t;
        const c =
          gStops <= 2
            ? lerpRgb(gA, gB, tt)
            : tt < 0.5
              ? lerpRgb(gA, gB, tt * 2)
              : lerpRgb(gB, gC, (tt - 0.5) * 2);
        return `rgba(${c.r},${c.g},${c.b},${alpha})`;
      };

      // ──────────── PLANE STYLE ────────────
      // A flat grid surface facing the camera. Droplets land on it and emanate
      // concentric ripples that displace the grid in-plane (rings read head-on)
      // and in Z (relief once the camera tilts). The grid lines are the strokes.
      if (p.inkStyle === 'plane') {
        const project = (x: number, y: number, z: number) => {
          const xy = x * cosY + z * sinY; // yaw (Y)
          const zy = -x * sinY + z * cosY;
          const yp = y * cosP - zy * sinP; // pitch (X)
          const zp = y * sinP + zy * cosP;
          const sx = xy * cosR - yp * sinR; // roll (Z, screen)
          const sy = xy * sinR + yp * cosR;
          const scale = focal / Math.max(1, focal + zp);
          return { x: sx * scale, y: sy * scale, depth: zp };
        };

        const half = p.radius * p.inkPlaneSize;
        const lines = Math.max(1, p.inkPlaneLines);
        const nSamp = Math.max(2, p.inkVertices);
        const ringK = half > 0 ? (p.inkPlaneRingFreq * Math.PI * 2) / half : 0;
        const amp = p.inkPlaneAmp;
        const bend = p.inkPlaneBend;
        const falloff = p.inkPlaneFalloff;
        const maxR = half * 1.5;
        const fade = p.inkDepthFade;
        const cull = Math.max(1, p.inkCull);
        const spiral = p.inkPlaneSpiral;
        const wobble = p.inkPlaneWobble;
        const wobbleLobes = p.inkPlaneWobbleScale; // angular lobes of the band wobble

        // Drop points on the plane — drop 0 centred, extras seeded.
        const dr = mulberry32(p.inkSeed ^ 0x2f);
        const drops = [{ x: 0, y: 0, ph: 0 }];
        for (let j = 1; j < p.inkPlaneDrops; j++) {
          drops.push({
            x: (dr() * 2 - 1) * half * p.inkPlaneSpread,
            y: (dr() * 2 - 1) * half * p.inkPlaneSpread,
            ph: dr() * Math.PI * 2,
          });
        }

        // Per grid point: sum each drop's expanding/fading wave into Z relief
        // plus an in-plane radial push so the rings show when viewed head-on.
        const surface = (x: number, y: number) => {
          let z = 0;
          let bx = 0;
          let by = 0;
          for (const d of drops) {
            const dx = x - d.x;
            const dy = y - d.y;
            const theta = Math.atan2(dy, dx);
            const dist0 = Math.sqrt(dx * dx + dy * dy); // TRUE distance (stable)
            // Wobble: perturb the ring RADIUS as a smooth function of angle (and
            // a little of radius) so the bands undulate organically. This only
            // shifts the wave phase/attenuation — NOT the bend normalisation —
            // so it can't pull the radius to zero and blow up the bend.
            let dist = dist0;
            if (wobble > 0) {
              dist +=
                wobble *
                (Math.sin(theta * wobbleLobes + dist0 * 0.012 - phase) +
                  0.5 * Math.sin(theta * wobbleLobes * 1.9 - dist0 * 0.017 + phase * 1.2));
              if (dist < 0) dist = 0;
            }
            const att = falloff > 0 ? Math.pow(Math.max(0, Math.min(1, 1 - dist / maxR)), falloff) : 1;
            if (att <= 0) continue;
            // Spiral: add an angular term so wavefronts wind around the drop.
            const ang = spiral !== 0 ? spiral * theta : 0;
            const wave = Math.sin(dist * ringK + ang - phase + d.ph);
            z += amp * wave * att;
            // Bend normalises by the TRUE distance so the unit direction is
            // always valid — magnitude is bounded by `bend`, no singularity.
            if (bend > 0 && dist0 > 0.001) {
              const b = (bend * wave * att) / dist0;
              bx += dx * b;
              by += dy * b;
            }
          }
          return project(x + bx, y + by, z);
        };

        const lineRand = mulberry32(p.inkSeed ^ 0x7c);
        type GLine = { pts: { x: number; y: number }[]; depth: number; dh: number; dl: number };
        const built: GLine[] = [];
        let minD = Infinity;
        let maxD = -Infinity;
        const buildAxis = (rows: boolean) => {
          for (let li = 0; li < lines; li++) {
            if (li % cull !== 0) continue;
            const t = lines === 1 ? 0.5 : li / (lines - 1);
            const fixed = -half + t * 2 * half;
            const dh = (lineRand() - 0.5) * 2 * p.inkHueShift;
            const dl = (lineRand() - 0.5) * 2 * p.inkLightnessShift;
            const pts = new Array(nSamp);
            let dsum = 0;
            for (let i = 0; i < nSamp; i++) {
              const u = nSamp === 1 ? 0 : i / (nSamp - 1);
              const moving = -half + u * 2 * half;
              const pr = rows ? surface(moving, fixed) : surface(fixed, moving);
              pts[i] = pr;
              dsum += pr.depth;
            }
            const dm = dsum / nSamp;
            if (dm < minD) minD = dm;
            if (dm > maxD) maxD = dm;
            built.push({ pts, depth: dm, dh, dl });
          }
        };
        buildAxis(true);
        if (p.inkPlaneGrid === 'both') buildAxis(false);

        const dRange = maxD - minD || 1;
        ctx.lineWidth = p.inkLineWidth;
        for (const b of built) {
          const gt = (b.depth - minD) / dRange;
          const fog = fade > 0 ? 1 - fade * gt : 1;
          ctx.strokeStyle = gradOn
            ? gradColor(gt, p.inkAlpha * fog)
            : hslString(baseHsl.h + b.dh, baseHsl.s, baseHsl.l + b.dl, p.inkAlpha * fog);
          ctx.beginPath();
          for (let i = 0; i < b.pts.length; i++) {
            const pt = b.pts[i];
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          }
          ctx.stroke();
        }

        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
        return;
      }

      // ──────────── RIPPLES (WATER) STYLE ────────────
      // Concentric rings from each drop source, expanding outward. Every ring
      // vertex rides on the combined wave HEIGHT FIELD of all sources (true
      // superposition → Z relief under tilt) and is bent in-plane where other
      // sources' waves cross it (the interference look).
      if (p.inkStyle === 'ripples') {
        const project = (x: number, y: number, z: number) => {
          const xy = x * cosY + z * sinY; // yaw (Y)
          const zy = -x * sinY + z * cosY;
          const yp = y * cosP - zy * sinP; // pitch (X)
          const zp = y * sinP + zy * cosP;
          const sx = xy * cosR - yp * sinR; // roll (Z, screen)
          const sy = xy * sinR + yp * cosR;
          const scale = focal / Math.max(1, focal + zp);
          return { x: sx * scale, y: sy * scale, depth: zp };
        };

        const nSamp = Math.max(8, p.inkVertices);
        const uc = new Float64Array(nSamp);
        const us = new Float64Array(nSamp);
        for (let i = 0; i < nSamp; i++) {
          const t = (i / nSamp) * Math.PI * 2;
          uc[i] = Math.cos(t);
          us[i] = Math.sin(t);
        }

        const spacing = p.inkWaterSpacing;
        const rings = p.inkWaterRings;
        const maxR = rings * spacing;
        const decay = p.inkWaterDecay;
        const amp = p.inkWaterAmp;
        const kWave = ((Math.PI * 2) / spacing) * p.inkWaterFreq;
        const bend = p.inkWaterBend;
        const fade = p.inkDepthFade;
        // phase already includes speed (set in the animation effect). frac
        // expands the ring radii; the same phase travels the wave field.
        const frac = p.inkWaterAnimate ? ((phase % 1) + 1) % 1 : 0;
        const omega = phase;

        type Ring = { pts: { x: number; y: number }[]; depth: number; alpha: number; dh: number; dl: number };
        const built: Ring[] = [];
        let minD = Infinity;
        let maxD = -Infinity;

        const cull = Math.max(1, p.inkCull);
        for (const src of waterSources) {
          for (let k = 0; k < rings; k++) {
            if (k % cull !== 0) continue; // keep every Nth ring
            const ringR = (k + frac) * spacing;
            if (ringR < 0.5 || ringR > maxR) continue;
            const tNorm = ringR / maxR;
            const aFadeIn = Math.min(1, ringR / spacing); // ease the newborn ring in
            const aDecay = Math.pow(Math.max(0, 1 - tNorm), decay);
            const ringAlpha = aFadeIn * aDecay;
            if (ringAlpha <= 0.01) continue;

            const pts = new Array(nSamp);
            for (let i = 0; i < nSamp; i++) {
              let px = src.x + uc[i] * ringR;
              let py = src.y + us[i] * ringR;
              let z = 0;
              // Superposition over every source.
              for (const s2 of waterSources) {
                const dx = px - s2.x;
                const dy = py - s2.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const att = Math.max(0, 1 - dist / (maxR * 1.5));
                if (att <= 0) continue;
                const wave = Math.sin(kWave * dist - omega + s2.phaseOff);
                z += amp * wave * att;
                if (bend > 0 && s2 !== src && dist > 0.001) {
                  const b = (bend * wave * att) / dist;
                  px += dx * b;
                  py += dy * b;
                }
              }
              pts[i] = project(px, py, z);
            }
            const cd = project(src.x, src.y, 0).depth;
            if (cd < minD) minD = cd;
            if (cd > maxD) maxD = cd;
            built.push({ pts, depth: cd, alpha: ringAlpha, dh: src.dh, dl: src.dl });
          }
        }

        const dRange = maxD - minD || 1;
        ctx.lineWidth = p.inkLineWidth;
        for (const b of built) {
          const gt = (b.depth - minD) / dRange;
          const fog = fade > 0 ? 1 - fade * gt : 1;
          ctx.strokeStyle = gradOn
            ? gradColor(gt, p.inkAlpha * b.alpha * fog)
            : hslString(baseHsl.h + b.dh, baseHsl.s, baseHsl.l + b.dl, p.inkAlpha * b.alpha * fog);
          ctx.beginPath();
          for (let i = 0; i < b.pts.length; i++) {
            const pt = b.pts[i];
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          }
          ctx.closePath();
          ctx.stroke();
        }

        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
        return;
      }

      // ──────────── RIBBON STYLE ────────────
      // Horizontal bands that span the canvas and twist about their length
      // axis. Each ribbon is drawn as `strands` parallel lines; the cross-
      // section twists into Z so the band reads as a twirling streamer, and
      // the wave phase animates the left↔right flow.
      if (p.inkStyle === 'ribbons') {
        const rand = mulberry32(p.inkSeed);
        const span = p.radius * 2 * p.inkRibbonSpan;
        const ribLen = span * p.inkRibbonLength; // each ribbon's actual length
        // Scatter each shorter ribbon's start across the span (own RNG so it
        // doesn't disturb the baseY/colour seed). At Length 1 this is a no-op.
        const xRand = mulberry32(p.inkSeed ^ 0x3c);
        const nSamp = Math.max(2, p.inkVertices);
        const strands = Math.max(1, p.inkRibbonStrands);
        const ribbonCull = Math.max(1, p.inkCull);
        const halfW = p.inkRibbonWidth / 2;
        const amp = p.inkRibbonAmplitude;
        const waveK = span > 0 ? (p.inkRibbonWaveFreq * Math.PI * 2) / span : 0;
        const twistK = span > 0 ? (p.inkRibbonTwist * Math.PI * 2) / span : 0;
        // Droplet ripple — concentric waves from the canvas centre. ripK is
        // scaled so Droplet Rings = number of rings from centre to the canvas
        // edge; energy fades outward by ripFalloff and expands with phase.
        const ripK = p.radius > 0 ? (p.inkRibbonRippleFreq * Math.PI * 2) / p.radius : 0;
        const ripAmp = p.inkRibbonRippleAmp;
        const ripFalloff = p.inkRibbonRippleFalloff;
        const ripMaxR = p.radius * 1.4;
        const ripSpiral = p.inkRibbonRippleSpiral;
        const ripWobble = p.inkRibbonRippleWobble;
        const ripWobbleLobes = p.inkRibbonRippleWobbleScale;
        const pathMode = p.inkRibbonRippleSource === 'ribbon';
        const vSpread = p.radius * p.inkRibbonSpread;
        const fade = p.inkDepthFade;

        // Drop points whose rings superpose. Drop 0 is always centred so
        // Droplets=1 reproduces the single droplet; extras are seeded. `u` is
        // the normalised along-length position (ribbon mode); cx/cy are canvas
        // positions; ph is a per-drop phase offset for organic interference.
        const dropSpread = p.inkRibbonDropSpread;
        const dropRand = mulberry32(p.inkSeed ^ 0x1d);
        const drops = [{ u: 0, cx: 0, cy: 0, ph: 0 }];
        for (let j = 1; j < p.inkRibbonDropCount; j++) {
          drops.push({
            u: dropRand() * 2 - 1,
            cx: (dropRand() * 2 - 1) * p.radius * dropSpread,
            cy: (dropRand() * 2 - 1) * p.radius * dropSpread,
            ph: dropRand() * Math.PI * 2,
          });
        }

        const project = (x: number, y: number, z: number) => {
          const xy = x * cosY + z * sinY; // yaw (Y)
          const zy = -x * sinY + z * cosY;
          const yp = y * cosP - zy * sinP; // pitch (X)
          const zp = y * sinP + zy * cosP;
          const sx = xy * cosR - yp * sinR; // roll (Z, screen)
          const sy = xy * sinR + yp * cosR;
          const scale = focal / Math.max(1, focal + zp);
          return { x: sx * scale, y: sy * scale, depth: zp };
        };

        // Pass 1: build every strand polyline and its mid-depth for fog.
        type Strand = { pts: { x: number; y: number }[]; mid: number; dh: number; dl: number };
        const built: Strand[] = [];
        let minD = Infinity;
        let maxD = -Infinity;
        const midIdx = nSamp >> 1;
        for (let ri = 0; ri < p.inkRibbonCount; ri++) {
          const baseY = (rand() * 2 - 1) * vSpread;
          const phaseOff = rand() * Math.PI * 2;
          const dh = (rand() - 0.5) * 2 * p.inkHueShift;
          const dl = (rand() - 0.5) * 2 * p.inkLightnessShift;
          // Start x for this ribbon: scattered within the span (no-op at Length 1).
          const xStart = -span / 2 + xRand() * (span - ribLen);

          // Per-ribbon precompute: the centerline (x, cy) shared by all strands,
          // and — for ribbon-surface mode — the arc length ALONG that centerline
          // relative to the ribbon's midpoint (the drop point). The ripple then
          // spreads across the ribbon surface (along-length + across-width) so
          // its rings follow the band's undulating, twisting path through space.
          const xArr = new Float64Array(nSamp);
          const cyArr = new Float64Array(nSamp);
          for (let i = 0; i < nSamp; i++) {
            const x = xStart + (i / (nSamp - 1)) * ribLen;
            xArr[i] = x;
            cyArr[i] = baseY + amp * Math.sin(x * waveK - phase + phaseOff);
          }
          let sRel: Float64Array | null = null;
          let Lhalf = 0;
          if (pathMode && ripAmp !== 0) {
            const s = new Float64Array(nSamp);
            for (let i = 1; i < nSamp; i++) {
              const dx = xArr[i] - xArr[i - 1];
              const dcy = cyArr[i] - cyArr[i - 1];
              s[i] = s[i - 1] + Math.sqrt(dx * dx + dcy * dcy);
            }
            const sMid = s[midIdx];
            for (let i = 0; i < nSamp; i++) s[i] -= sMid;
            sRel = s;
            Lhalf = (s[nSamp - 1] - s[0]) / 2;
          }

          for (let st = 0; st < strands; st++) {
            if (st % ribbonCull !== 0) continue; // keep every Nth strand
            const v = strands === 1 ? 0 : (st / (strands - 1)) * 2 - 1; // -1..1 across width
            const pts = new Array(nSamp);
            let mid = 0;
            for (let i = 0; i < nSamp; i++) {
              const x = xArr[i];
              const cy = cyArr[i];
              const tw = x * twistK - phase * 0.6 + phaseOff;
              let yy = cy + v * halfW * Math.cos(tw);
              let zz = v * halfW * Math.sin(tw);
              // Droplet ripple — sum the expanding/fading wave from every drop
              // so multiple droplets interfere. ribbon-surface measures over the
              // strip (along-length sRel, across-width v·halfW); canvas measures
              // flat distance in screen space.
              if (ripAmp !== 0) {
                const w = v * halfW;
                let rip = 0;
                for (const dp of drops) {
                  let d;
                  let ang;
                  if (pathMode) {
                    const ds = sRel![i] - dp.u * Lhalf * dropSpread;
                    d = Math.sqrt(ds * ds + w * w);
                    ang = Math.atan2(w, ds);
                  } else {
                    const dx = x - dp.cx;
                    const dy = yy - dp.cy;
                    d = Math.sqrt(dx * dx + dy * dy);
                    ang = Math.atan2(dy, dx);
                  }
                  // Wobble: warp the ring radius by angle (organic undulation).
                  if (ripWobble > 0) {
                    d +=
                      ripWobble *
                      (Math.sin(ang * ripWobbleLobes + d * 0.012 - phase) +
                        0.5 * Math.sin(ang * ripWobbleLobes * 1.9 - d * 0.017 + phase * 1.2));
                    if (d < 0) d = 0;
                  }
                  const att =
                    ripFalloff > 0
                      ? Math.pow(Math.max(0, Math.min(1, 1 - d / ripMaxR)), ripFalloff)
                      : 1;
                  // Spiral: wind the wavefronts around the drop.
                  const spin = ripSpiral !== 0 ? ripSpiral * ang : 0;
                  rip += ripAmp * Math.sin(d * ripK + spin - phase + dp.ph) * att;
                }
                yy += rip * 0.3;
                zz += rip;
              }
              const pr = project(x, yy, zz);
              pts[i] = pr;
              if (i === midIdx) mid = pr.depth;
            }
            if (mid < minD) minD = mid;
            if (mid > maxD) maxD = mid;
            built.push({ pts, mid, dh, dl });
          }
        }
        const dRange = maxD - minD || 1;

        // Pass 2: stroke, fading far strands toward the background.
        const lwBaseR = p.inkLineWidth;
        const widthRandR = mulberry32(p.inkSeed ^ 0x5b);
        for (const b of built) {
          const gt = (b.mid - minD) / dRange;
          const fog = fade > 0 ? 1 - fade * gt : 1;
          const wJitter = (widthRandR() - 0.5) * 2 * p.inkLineWidthVariance;
          ctx.lineWidth = Math.max(0.3, lwBaseR * (1 + wJitter));
          ctx.strokeStyle = gradOn
            ? gradColor(gt, p.inkAlpha * fog)
            : hslString(baseHsl.h + b.dh, baseHsl.s, baseHsl.l + b.dl, p.inkAlpha * fog);
          ctx.beginPath();
          for (let i = 0; i < b.pts.length; i++) {
            const pt = b.pts[i];
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          }
          ctx.stroke();
        }

        ctx.filter = 'none';
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
        return;
      }

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

      const loopCull = Math.max(1, p.inkCull);
      for (let li = 0; li < loops.length; li++) {
        if (li % loopCull !== 0) continue; // keep every Nth loop
        const L = loops[li];
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

        // 3b. Shape influence — radially squish each vertex toward the
        // silhouette outline. factor blends 1 (circle) → shapeR(θ)/radius.
        if (polar) {
          for (const w of warped) {
            const theta = Math.atan2(w.y, w.x);
            const shapeR = polarRadiusAt(polar, theta);
            const factor = 1 + (shapeR * invRadius - 1) * influence;
            w.x *= factor;
            w.y *= factor;
          }
        }

        // 3c. Camera — in-plane spin, pitch (tilt), then perspective divide.
        // Mutates x/y in place to projected screen coords; z is consumed here.
        // Multiply/screen blends are commutative so no depth sort is needed.
        if (cameraActive) {
          // Each vertex's total depth = ripple wave-height (w.z) + the loop's
          // structural stacking offset (L.cz).
          for (const w of warped) {
            const vz = w.z + L.cz;
            const xy = w.x * cosY + vz * sinY; // yaw (Y)
            const zy = -w.x * sinY + vz * cosY;
            const yp = w.y * cosP - zy * sinP; // pitch (X)
            const zp = w.y * sinP + zy * cosP;
            const scale = focal / Math.max(1, focal + zp);
            w.x = (xy * cosR - yp * sinR) * scale; // roll (Z, screen)
            w.y = (xy * sinR + yp * cosR) * scale;
          }
        }

        // 3d. Atmospheric depth fog — far loops fade toward the background.
        // 0 = nearest, 1 = farthest; multiplies into stroke alpha.
        let fog = 1;
        if (fogActive) {
          const t = (loopDepth[li] - minDepth) / depthRange;
          fog = 1 - depthFade * t;
        }
        const gt = (loopDepth[li] - minDepth) / depthRange; // gradient depth t

        // 4. Per-loop line width with deterministic ± variance
        const wJitter = (widthRand() - 0.5) * 2 * lwVar;
        const loopWidth = Math.max(0.3, lwBase * (1 + wJitter));

        // 5. Glow halo pass (optional, very wide low-alpha stroke under the
        // main line — adds the "inner shadow" depth where loops overlap).
        if (p.inkGlowWidth > 0) {
          ctx.lineWidth = loopWidth + p.inkGlowWidth;
          ctx.strokeStyle = gradOn
            ? gradColor(gt, p.inkGlowAlpha * fog)
            : hslString(baseHsl.h + L.dh, baseHsl.s, baseHsl.l + L.dl, p.inkGlowAlpha * fog);
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
        ctx.strokeStyle = gradOn
          ? gradColor(gt, p.inkAlpha * fog)
          : hslString(baseHsl.h + L.dh, baseHsl.s, baseHsl.l + L.dl, p.inkAlpha * fog);
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
    ctx.translate(w / 2, h / 2);
    if (p.zoom !== 1) ctx.scale(p.zoom, p.zoom);

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
    }
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
    p.inkColorMode,
    p.inkGradStops,
    p.inkGradColor1,
    p.inkGradColor2,
    p.inkGradColor3,
    p.inkCull,
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
    p.inkShapeInfluence,
    p.inkTilt,
    p.inkYaw,
    p.inkPerspective,
    p.inkDepthSpread,
    p.inkDepthFade,
    p.inkStyle,
    p.inkRibbonCount,
    p.inkRibbonWidth,
    p.inkRibbonStrands,
    p.inkRibbonAmplitude,
    p.inkRibbonWaveFreq,
    p.inkRibbonTwist,
    p.inkRibbonSpan,
    p.inkRibbonLength,
    p.inkRibbonRippleSpiral,
    p.inkRibbonRippleWobble,
    p.inkRibbonRippleWobbleScale,
    p.inkRibbonSpread,
    p.inkRibbonRippleAmp,
    p.inkRibbonRippleFreq,
    p.inkRibbonRippleFalloff,
    p.inkRibbonRippleSource,
    p.inkRibbonDropCount,
    p.inkRibbonDropSpread,
    p.inkPlaneLines,
    p.inkPlaneSize,
    p.inkPlaneGrid,
    p.inkPlaneDrops,
    p.inkPlaneSpread,
    p.inkPlaneRingFreq,
    p.inkPlaneAmp,
    p.inkPlaneBend,
    p.inkPlaneFalloff,
    p.inkPlaneSpiral,
    p.inkPlaneWobble,
    p.inkPlaneWobbleScale,
    waterSources,
    p.inkWaterRings,
    p.inkWaterSpacing,
    p.inkWaterDecay,
    p.inkWaterAmp,
    p.inkWaterFreq,
    p.inkWaterBend,
    p.inkWaterAnimate,
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
    resizeTick,
    p.zoom,
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
