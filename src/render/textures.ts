import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { MatId, Palette } from '../sim/map';

// Procedural 64x64 textures drawn pixel by pixel, sampled with nearest
// filtering for a chunky early-2000s look. One texture tile covers 2x2 m.
const SIZE = 64;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A steady random number (-0.5..0.5) for a cell of a pixel grid: the blocky noise of the themed materials. */
function cell(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h) - 0.5;
}

/** Returns a brightness offset for each pixel of the given material. */
function shade(kind: MatId, x: number, y: number, rng: Rng, blot: Float32Array, seed: number): number {
  const grain = (rng.next() - 0.5) * 22;
  switch (kind) {
    // --- themed materials (one texture tile is 2 m, so 32 pixels a metre) ---
    case 'panel': case 'panelAlt': // drawn whole by panelTexture()
      return 0;
    case 'grass': // blocky greens with light speckles
      return cell(x >> 2, y >> 2, seed) * 50 + (cell(x, y, seed + 1) > 0.42 ? 30 : 0);
    case 'dirt': // blocky browns with dark grit
      return cell(x >> 2, y >> 2, seed) * 44 + (cell(x, y, seed + 2) > 0.44 ? -40 : 0);
    case 'stone': { // rough blocks of rock, joints between them
      const row = y >> 4, bx = (x + (row % 2) * 8) % 16;
      let v = cell(x >> 2, y >> 2, seed) * 40;
      if (y % 16 === 0 || bx === 0) v -= 45;
      return v;
    }
    case 'planks': { // boards with seams, grain and staggered ends
      const row = y >> 3;
      let v = cell(row, 0, seed) * 26 + ((x * 3 + row * 17) % 11 === 0 ? -16 : 0) + grain * 0.3;
      if (y % 8 === 0) v -= 55;
      if ((x + row * 23) % 32 === 0) v -= 45;
      return v;
    }
    case 'leaves': // clumps of green with dark gaps
      return cell(x >> 2, y >> 2, seed) > 0.3 ? -70 : cell(x >> 1, y >> 1, seed + 3) * 46;
    case 'sand':
      return grain * 0.35 + Math.sin((x + Math.sin(y * 0.3) * 4) * 0.35) * 6;
    case 'sandstone': { // layered bands, a carved line now and then
      let v = Math.sin(y * 0.8) * 6 + cell(0, y >> 2, seed) * 30 + grain * 0.3;
      if (y % 32 === 0) v -= 50;
      if (y % 32 === 1) v += 18;
      return v;
    }
    case 'glass': { // a tower face at night: dark glass, windows half a metre across, about one in five lit
      const wx = x % 16, wy = y % 16;
      if (wx < 3 || wx > 13 || wy < 4 || wy > 13) return -250; // frames and floor slabs
      const w = blot[(y >> 4) * 8 + (x >> 4)]; // a proper random number per window (-10..10)
      return w < -6 ? w * 4 + 20 - (wy === 13 ? 40 : 0) : -236 + grain * 0.2;
    }
    case 'concrete':
    case 'concreteDark': {
      let v = grain + blot[((y >> 3) << 3) + (x >> 3)]; // blotchy stains
      if (y % 32 === 0) v -= 30; // formwork seams
      if (x === (y < 32 ? 0 : 32)) v -= 22;
      if ((x % 32 === 4 || x % 32 === 27) && (y % 32 === 5 || y % 32 === 26)) v -= 45; // tie holes
      return v;
    }
    case 'tile': {
      const tx = x % 16, ty = y % 16;
      if (tx === 0 || ty === 0) return -55; // grout
      let v = grain * 0.5 + blot[((y >> 4) << 3) + (x >> 4)] * 1.6;
      if (tx === 1 || ty === 1) v += 14; // bevel highlight
      return v;
    }
    case 'metal': {
      const px = x % 32, py = y % 32;
      let v = grain * 0.4 + ((y * 7) % 5) * 3 - 6; // brushed streaks
      if (px === 0 || py === 0) v -= 40;
      if (px === 1 || py === 1) v += 18;
      if ((px === 4 || px === 28) && (py === 4 || py === 28)) v += 40; // rivets
      return v;
    }
    case 'hazard':
      return ((x + y) >> 3) % 2 === 0 ? grain * 0.4 : -170 + grain * 0.3;
    case 'ice':
      return grain * 0.3 + ((x * 3 + y) % 23 === 0 ? 45 : 0) + ((x - y * 2 + 128) % 37 === 0 ? 30 : 0);
    case 'conveyor': {
      // rubber belt: cross ribs and bright edge rails
      let v = grain * 0.3;
      if (y % 8 < 2) v += 38;
      if (x % 32 < 2 || x % 32 > 29) v += 70;
      return v;
    }
    case 'lava': {
      // glowing crust: bright veins between darker plates
      const cell = blot[((y >> 3) << 3) + (x >> 3)];
      return grain * 1.2 + cell * 4 - ((x + (y >> 2)) % 9 === 0 || (y + (x >> 2)) % 11 === 0 ? -60 : 30);
    }
  }
}

/** Anisotropic filtering for every texture: keeps floors sharp far away, seen at a low angle. Set by the renderer. */
let anisotropy = 1;
export function setAnisotropy(n: number): void { anisotropy = Math.max(1, n); }

/**
 * The neon city's floor: dark glossy panels two metres square, a glowing seam
 * between them in the palette's colour, an LED at every joint, and a little
 * detail in each panel (a sheen, a vent grille or a hex grid). Drawn in full
 * colour rather than as shades of one: the seams glow, the panels do not.
 * Chunky pixels like the rest, stored at four times the resolution so the
 * seams stay bright and sharp in the distance instead of averaging away.
 */
const PANEL = 256;
function panelTexture(hex: string, seed: number): HTMLCanvasElement {
  // Designed as 64x64 chunky pixels, like every other material, then blown up
  // 4x with hard edges: crisp up close, and the seams are wide enough not to
  // average away far off.
  const D = 64, q = PANEL / D;
  const [nr, ng, nb] = hexToRgb(hex);
  const rng = new Rng(seed);
  const k = Math.floor(rng.next() * 3); // the panel's detail
  const px: [number, number, number][] = [];
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      // the dark panel, a cold blue-black, a step lighter towards one corner (a sheen)
      const sheen = x + y < 24 ? 10 : x + y < 48 ? 5 : 0;
      const grain = Math.floor(rng.next() * 3) * 3 - 3; // chunky, a few steps only
      let r = 16 + sheen * 0.6 + grain, g = 18 + sheen * 0.7 + grain, b = 30 + sheen + grain;
      if (k === 1 && x > 20 && x < 44 && y > 26 && y < 38 && x % 3 === 0) { r -= 9; g -= 9; b -= 9; } // a vent grille
      if (k === 2 && ((x + (Math.floor(y / 5) % 2) * 3) % 6 === 0 || y % 5 === 0) && x > 8 && x < 56 && y > 8 && y < 56) { r += 6; g += 8; b += 12; } // a hex-ish grid
      if (k === 0 && (x === 32 || y === 32) && x > 6 && x < 58 && y > 6 && y < 58) { r += 7; g += 8; b += 11; } // a cross of joints
      // bevel: a light top-left lip, a dark bottom-right one
      if (x === 1 || y === 1) { r += 24; g += 26; b += 36; }
      if (x === 62 || y === 62) { r -= 8; g -= 8; b -= 10; }
      // the seam in full colour, one step of glow beside it
      const edge = Math.min(x, y, 63 - x, 63 - y);
      if (edge === 0) { r = nr; g = ng; b = nb; } else if (edge === 1) { r = r * 0.55 + nr * 0.3; g = g * 0.55 + ng * 0.3; b = b * 0.55 + nb * 0.3; }
      // an LED at each joint
      if ((x < 1 || x > 62) && (y < 1 || y > 62)) { r = 255; g = 255; b = 255; }
      px.push([r, g, b]);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PANEL;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(PANEL, PANEL);
  for (let y = 0; y < PANEL; y++) {
    for (let x = 0; x < PANEL; x++) {
      const [r, g, b] = px[Math.floor(y / q) * D + Math.floor(x / q)];
      const i = (y * PANEL + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, r));
      img.data[i + 1] = Math.max(0, Math.min(255, g));
      img.data[i + 2] = Math.max(0, Math.min(255, b));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function makeTexture(kind: MatId, hex: string, seed: number): THREE.CanvasTexture {
  if (kind === 'panel' || kind === 'panelAlt') {
    const tex = new THREE.CanvasTexture(panelTexture(hex, seed));
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter; // smooth between sizes far off, no shimmer
    tex.anisotropy = anisotropy;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(SIZE, SIZE);
  const rng = new Rng(seed);
  const [r, g, b] = hexToRgb(hex);
  const blot = new Float32Array(64);
  for (let i = 0; i < 64; i++) blot[i] = (rng.next() - 0.5) * 20;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = shade(kind, x, y, rng, blot, seed);
      const i = (y * SIZE + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, r + v));
      img.data[i + 1] = Math.max(0, Math.min(255, g + v));
      img.data[i + 2] = Math.max(0, Math.min(255, b + v));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.anisotropy = anisotropy;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeMaterials(palette: Palette, seed: number): Record<MatId, THREE.Material> {
  const out = {} as Record<MatId, THREE.Material>;
  (Object.keys(palette.mats) as MatId[]).forEach((id, i) => {
    const map = makeTexture(id, palette.mats[id]!, seed + i * 101);
    // Lava glows: it ignores lighting and darkness. Everything else is lit,
    // and uses vertex colours so dark areas can be baked into the mesh.
    // Lit windows and neon floor seams glow at night too (the floor keeps its baked shading).
    out[id] = id === 'panel' || id === 'panelAlt'
      ? new THREE.MeshBasicMaterial({ map, vertexColors: true })
      : id === 'lava' || id === 'glass'
      ? new THREE.MeshBasicMaterial({ map })
      : new THREE.MeshLambertMaterial({ map, vertexColors: true });
  });
  return out;
}
