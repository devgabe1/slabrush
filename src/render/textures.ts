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

/** Returns a brightness offset for each pixel of the given material. */
function shade(kind: MatId, x: number, y: number, rng: Rng, blot: Float32Array): number {
  const grain = (rng.next() - 0.5) * 22;
  switch (kind) {
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

export function makeTexture(kind: MatId, hex: string, seed: number): THREE.CanvasTexture {
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
      const v = shade(kind, x, y, rng, blot);
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
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeMaterials(palette: Palette, seed: number): Record<MatId, THREE.Material> {
  const out = {} as Record<MatId, THREE.Material>;
  (Object.keys(palette.mats) as MatId[]).forEach((id, i) => {
    const map = makeTexture(id, palette.mats[id], seed + i * 101);
    // Lava glows: it ignores lighting and darkness. Everything else is lit,
    // and uses vertex colours so dark areas can be baked into the mesh.
    out[id] = id === 'lava'
      ? new THREE.MeshBasicMaterial({ map })
      : new THREE.MeshLambertMaterial({ map, vertexColors: true });
  });
  return out;
}
