export type Dot = { x: number; y: number; r: number };

export type GeneratorKind = 'radial' | 'spiral' | 'grid' | 'dither' | 'phyllotaxis' | 'concentric';

export type GeneratorOptions = {
  radius: number;
  spacing: number;
  dotSize: number;
  density: number;
  seed: number;
  /**
   * When 'square', grid/dither fill the bounding square so downstream shape
   * clipping can carve out non-circular silhouettes. Defaults to 'circle'.
   */
  bounds?: 'circle' | 'square';
};

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

export function generate(kind: GeneratorKind, opts: GeneratorOptions): Dot[] {
  switch (kind) {
    case 'radial':
      return radial(opts);
    case 'spiral':
      return spiral(opts);
    case 'grid':
      return grid(opts);
    case 'dither':
      return dither(opts);
    case 'phyllotaxis':
      return phyllotaxis(opts);
    case 'concentric':
      return concentric(opts);
  }
}

function radial({ radius, spacing, dotSize }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [{ x: 0, y: 0, r: dotSize }];
  const ringStep = Math.max(spacing, 2);
  for (let r = ringStep; r <= radius; r += ringStep) {
    const circumference = 2 * Math.PI * r;
    const count = Math.max(6, Math.floor(circumference / ringStep));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      dots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: dotSize });
    }
  }
  return dots;
}

function concentric({ radius, spacing, dotSize, density }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [];
  const ringStep = Math.max(spacing, 2);
  const offsetEvery = Math.PI / Math.max(2, density);
  let ringIdx = 0;
  for (let r = 0; r <= radius; r += ringStep) {
    if (r === 0) {
      dots.push({ x: 0, y: 0, r: dotSize });
      ringIdx++;
      continue;
    }
    const circumference = 2 * Math.PI * r;
    const count = Math.max(6, Math.floor(circumference / ringStep));
    const phase = ringIdx * offsetEvery;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + phase;
      dots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: dotSize });
    }
    ringIdx++;
  }
  return dots;
}

function spiral({ radius, spacing, dotSize, density }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [];
  const b = spacing / (2 * Math.PI);
  const arms = Math.max(1, Math.round(density));
  for (let arm = 0; arm < arms; arm++) {
    const armOffset = (arm / arms) * Math.PI * 2;
    let theta = 0;
    while (true) {
      const r = b * theta;
      if (r > radius) break;
      const x = Math.cos(theta + armOffset) * r;
      const y = Math.sin(theta + armOffset) * r;
      dots.push({ x, y, r: dotSize });
      const step = spacing / Math.max(b, 0.5);
      theta += step / Math.max(theta, 1);
      if (theta > 400) break;
    }
  }
  return dots;
}

function phyllotaxis({ radius, spacing, dotSize }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const c = spacing * 0.6;
  for (let i = 0; i < 5000; i++) {
    const r = c * Math.sqrt(i);
    if (r > radius) break;
    const a = i * golden;
    dots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: dotSize });
  }
  return dots;
}

function grid({ radius, spacing, dotSize, bounds }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [];
  const step = Math.max(spacing, 2);
  const square = bounds === 'square';
  for (let y = -radius; y <= radius; y += step) {
    for (let x = -radius; x <= radius; x += step) {
      if (square || x * x + y * y <= radius * radius) {
        dots.push({ x, y, r: dotSize });
      }
    }
  }
  return dots;
}

function dither({ radius, spacing, dotSize, density, seed, bounds }: GeneratorOptions): Dot[] {
  const dots: Dot[] = [];
  const rand = mulberry32(seed);
  const step = Math.max(spacing, 2);
  const square = bounds === 'square';
  for (let y = -radius; y <= radius; y += step) {
    for (let x = -radius; x <= radius; x += step) {
      const d = Math.sqrt(x * x + y * y) / radius;
      if (!square && d > 1) continue;
      // Falloff is still radial so density decays from center, regardless of bounds
      const probability = Math.pow(Math.max(0, 1 - d), density * 0.6);
      if (rand() < probability) {
        const jx = (rand() - 0.5) * step * 0.4;
        const jy = (rand() - 0.5) * step * 0.4;
        dots.push({ x: x + jx, y: y + jy, r: dotSize });
      }
    }
  }
  return dots;
}
