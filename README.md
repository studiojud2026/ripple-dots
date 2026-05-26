# Ripple Dots

A generator for circular geometric dot compositions with real 3D ripple distortion. Built with React, Vite, and [Dialkit](https://www.npmjs.com/package/dialkit) for live parameter tweaking.

## Generators

Six ways to lay out the dot field:

- **Radial** — concentric rings, even angular spacing
- **Concentric** — rings with per-ring phase offset
- **Spiral** — multi-arm Archimedean spirals
- **Phyllotaxis** — golden-angle sunflower packing
- **Grid** — square grid clipped to the silhouette
- **Dither** — stochastic packing with radial falloff

## Shapes

The dot field can be masked to any silhouette via Path2D hit-testing. Built-in shapes: Circle, Heart, Star, Hexagon, Triangle, Flower. **Custom SVG** accepts either a raw `d` attribute or a full `<svg>` pasted from Figma/Illustrator — multiple paths in the markup are combined into one silhouette.

## Ripples

Six distortion modes. Frequency, depth, decay (distance-based attenuation), and animated phase are exposed per-ripple.

- **Radial** — sinusoidal wave height radiating from center
- **Concentric Pulse** — breathing rings (XY scale)
- **Horizontal** — wave along the X axis (height in Z)
- **Twist** — angular sinusoid winding dots around center
- **Edge Wave (shape)** — wave height = `sin(distanceFromNearestEdge × freq)`. Wave contours hug the silhouette outline
- **Edge Pulse (shape)** — same edge-distance wave applied as XY breathing

## 3D rendering

Dots have a Z coordinate (wave height for radial/horizontal/edge-wave modes). Each frame:

1. Yaw rotation around Y axis (Composition → Rotation)
2. Pitch rotation around X axis (Composition → Tilt)
3. Perspective projection with adjustable focal length
4. Z-sort for proper occlusion
5. Per-dot alpha from depth fog (`Depth Fade`) and wave-height glow (`Crest Glow`)
6. Optional heatmap coloring — `Trough Color` → `Mid Color` → `Crest Color` interpolated from wave height

## Run it

```bash
npm install
npm run dev
```

## Keyboard shortcuts

- `F + scroll` — ripple frequency (fine mode)
- `D + scroll` — ripple depth
- `S + scroll` — composition spacing
- `Z + scroll` — dot size (fine mode)
- `R + scroll` — rotation
- `T + scroll` — tilt

Hold the key and scroll over the canvas — no need to grab the panel slider.
