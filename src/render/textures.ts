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
 * Drawn at 256 pixels (four times the other materials) with seams a few pixels
 * wide, so they stay bright and sharp in the distance instead of averaging
 * away into the dark.
 */
const PANEL = 256;
function panelTexture(hex: string, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PANEL;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(PANEL, PANEL);
  const [nr, ng, nb] = hexToRgb(hex);
  const rng = new Rng(seed);
  const k = Math.floor(rng.next() * 3); // the panel's detail
  const q = PANEL / 64; // pixels per unit of the 64-unit design
  for (let y = 0; y < PANEL; y++) {
    for (let x = 0; x < PANEL; x++) {
      const px = x / q, py = y / q, ix = Math.floor(px), iy = Math.floor(py);
      // the dark panel, a cold blue-black, lighter towards one corner (a sheen)
      let r = 16, g = 18, b = 30;
      const sheen = Math.max(0, 1 - (px + py) / 80) * 16;
      r += sheen * 0.6; g += sheen * 0.7; b += sheen;
      const grain = (rng.next() - 0.5) * 4;
      r += grain; g += grain; b += grain;
      if (k === 1 && ix > 20 && ix < 44 && iy > 26 && iy < 38 && ix % 3 === 0) { r -= 8; g -= 8; b -= 8; } // a vent grille
      if (k === 2 && ((ix + (Math.floor(iy / 5) % 2) * 3) % 6 === 0 || iy % 5 === 0) && ix > 8 && ix < 56 && iy > 8 && iy < 56) { r += 5; g += 7; b += 11; } // a hex-ish grid
      if (k === 0 && (ix === 32 || iy === 32) && ix > 6 && ix < 58 && iy > 6 && iy < 58) { r += 6; g += 7; b += 10; } // a faint cross of joints
      // bevel: a light top-left lip, a dark bottom-right one
      const edge = Math.min(px, py, 64 - px, 64 - py);
      if (edge >= 0.9 && edge < 1.6 && (px < 2 || py < 2)) { r += 22; g += 24; b += 34; }
      if (edge >= 0.9 && edge < 1.6 && (px > 62 || py > 62)) { r -= 8; g -= 8; b -= 10; }
      // the glowing seam, and a soft halo fading out from it
      if (edge < 0.9) { r = nr; g = ng; b = nb; } else if (edge < 2.4) {
        const h = 0.3 * (1 - (edge - 0.9) / 1.5);
        r = r * (1 - h) + nr * h; g = g * (1 - h) + ng * h; b = b * (1 - h) + nb * h;
      }
      // an LED at each joint
      if ((px < 1.6 || px > 62.4) && (py < 1.6 || py > 62.4)) { r = 255; g = 255; b = 255; }
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
