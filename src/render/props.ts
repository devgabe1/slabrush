import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../core/vec';
import type { PropKind } from '../maps/props';

// The map lab's decorations, drawn: each kind built from simple shapes (merged
// into one mesh for the whole map, so hundreds of them cost little), the glowing
// parts in a second unlit mesh, and paintings with pictures painted on canvas.
// Front of a decoration: its local -z. Its origin: where it stands (floor), or
// the middle of where it hangs (wall); `yaw` turns it the way the game does.

export interface PlacedProp { kind: PropKind; pos: Vec3; yaw: number; variant: number }

const STONE = 0xb8a27e, DARK = 0x4a3d30, GOLD = 0xd9a920, WOOD = 0x7a4a26, METAL = 0x6b6f78, WHITE = 0xeee8dc;
const GREEN = 0x3f8a3a, GREEN_DARK = 0x2c6a2e, TRUNK = 0x6a4424, SOIL = 0x3a2a1a, POT = 0xb5673a;
const CLOTH = [0xb8322a, 0x2a5fa8, 0x3a8a4a, 0x7a3aa8];
const VASE = [0xc0492b, 0x2b6cb0, 0xe0b040, 0x3a8a5a];
const GLOW_GOLD = 0xffd060, GLOW_FIRE = 0xff8a2a, GLOW_CORE = 0xffe9a0, GLOW_LAMP = 0xffc860, WATER = 0x3aa6d8;
// Egypt: sandstone, lapis, turquoise and linen, black glaze, reed green
const LAPIS = 0x2a5fb0, LAPIS_DARK = 0x1a3a7a, LINEN = 0xf2ead2, SAND_STONE = 0xd9b77a, SAND = 0xe8c98e, SAND_DARK = 0xa67c4b;
const STONE_BLUE = 0x3a6aa8, TURQUOISE = 0x3ab5a0, BREAD = 0xc9873a, STEM = 0x7a9a4a, WOOD_DARK = 0x4a2e16, BLACK_GLAZE = 0x1a1a22, LOTUS_PINK = 0xf0a8c0;

// ---------------------------------------------------------------- geometry

/** Collects one decoration's parts, already placed in the world (its own position and turn). */
class Parts {
  solid: THREE.BufferGeometry[] = [];
  glow: THREE.BufferGeometry[] = [];
  /** paintings: the canvas on a frame, its place and its picture */
  canvases: { x: number; y: number; z: number; w: number; h: number; variant: number; big: boolean }[] = [];
  constructor(private world: THREE.Matrix4) {}

  private add(geo: THREE.BufferGeometry, color: number, p: [number, number, number], r: [number, number, number], s: [number, number, number], glow: boolean): void {
    const local = new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)), new THREE.Vector3(...s));
    const g = geo.toNonIndexed();
    geo.dispose();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.world, local));
    const n = g.attributes.position.count, c = new THREE.Color(color), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (glow ? this.glow : this.solid).push(g);
  }
  box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, r: [number, number, number] = [0, 0, 0], glow = false): void {
    this.add(new THREE.BoxGeometry(w, h, d), color, [x, y, z], r, [1, 1, 1], glow);
  }
  cyl(rTop: number, rBottom: number, h: number, seg: number, color: number, x = 0, y = 0, z = 0, r: [number, number, number] = [0, 0, 0], glow = false): void {
    this.add(new THREE.CylinderGeometry(rTop, rBottom, h, seg), color, [x, y, z], r, [1, 1, 1], glow);
  }
  sph(radius: number, color: number, x = 0, y = 0, z = 0, sy = 1, glow = false): void {
    this.add(new THREE.SphereGeometry(radius, 10, 7), color, [x, y, z], [0, 0, 0], [1, sy, 1], glow);
  }
  cone(radius: number, h: number, seg: number, color: number, x = 0, y = 0, z = 0, r: [number, number, number] = [0, 0, 0], glow = false): void {
    this.add(new THREE.ConeGeometry(radius, h, seg), color, [x, y, z], r, [1, 1, 1], glow);
  }
}

type Builder = (p: Parts, variant: number) => void;

const BUILD: Record<PropKind, Builder> = {
  painting: (p) => {
    p.box(1.7, 1.3, 0.08, GOLD);
    p.canvases.push({ x: 0, y: 0, z: -0.045, w: 1.42, h: 1.02, variant: 0, big: false });
  },
  torch: (p) => {
    p.box(0.1, 0.1, 0.4, METAL, 0, 0, -0.2);
    p.cyl(0.12, 0.09, 0.18, 8, METAL, 0, 0.1, -0.4);
    p.sph(0.1, GLOW_FIRE, 0, 0.26, -0.4, 1.3, true);
    p.sph(0.05, GLOW_CORE, 0, 0.27, -0.4, 1.2, true);
  },
  lantern: (p) => {
    p.box(0.06, 1.1, 0.06, DARK, 0, 0.55, 0);
    p.box(0.4, 0.08, 0.4, DARK, 0, 1.14, 0);
    p.box(0.28, 0.36, 0.28, GLOW_LAMP, 0, 0.8, 0, [0, 0, 0], true);
    p.cone(0.26, 0.2, 4, DARK, 0, 1.3, 0, [0, Math.PI / 4, 0]);
  },
  vase: (p, v) => {
    p.sph(0.22, VASE[v], 0, 0.3, 0, 1.4);
    p.cyl(0.1, 0.16, 0.3, 10, VASE[v], 0, 0.78, 0);
    p.cyl(0.14, 0.14, 0.05, 10, DARK, 0, 0.95, 0);
    p.cyl(0.25, 0.25, 0.06, 12, GOLD, 0, 0.45, 0);
  },
  plant: (p) => {
    p.cyl(0.4, 0.3, 0.6, 10, POT, 0, 0.3, 0);
    p.cyl(0.38, 0.38, 0.05, 10, SOIL, 0, 0.6, 0);
    p.sph(0.36, GREEN, 0, 1.05, 0, 1.2);
    for (const [x, z] of [[0.3, 0.1], [-0.25, 0.2], [0.05, -0.3], [-0.2, -0.2]]) p.sph(0.22, GREEN_DARK, x, 1.35, z);
  },
  banner: (p, v) => {
    p.box(1.2, 0.06, 0.06, METAL, 0, 1.05, -0.05);
    p.box(0.95, 1.7, 0.03, CLOTH[v], 0, 0.1, -0.05);
    p.box(0.2, 0.9, 0.035, GOLD, 0, 0.1, -0.07);
    p.box(0.7, 0.12, 0.035, GOLD, 0, -0.7, -0.07, [0, 0, Math.PI / 4]);
  },
  rug: (p, v) => {
    p.box(2.4, 0.03, 1.6, CLOTH[v], 0, 0.015, 0);
    p.box(2.0, 0.035, 1.2, GOLD, 0, 0.02, 0);
    p.box(1.6, 0.04, 0.8, CLOTH[(v + 2) % 4], 0, 0.025, 0);
    p.box(0.25, 0.045, 1.0, WHITE, 0, 0.03, 0);
  },
  flag: (p, v) => {
    p.cyl(0.035, 0.035, 2.8, 6, METAL, 0, 1.4, 0);
    p.box(0.9, 0.6, 0.02, CLOTH[v], 0.45, 2.3, 0);
    p.sph(0.07, GOLD, 0, 2.85, 0);
  },
  clock: (p) => {
    p.cyl(0.56, 0.56, 0.06, 20, DARK, 0, 0, -0.05, [Math.PI / 2, 0, 0]);
    p.cyl(0.46, 0.46, 0.04, 20, WHITE, 0, 0, -0.09, [Math.PI / 2, 0, 0]);
    p.box(0.04, 0.4, 0.03, DARK, 0, 0.2, -0.12);
    p.box(0.03, 0.28, 0.03, DARK, 0.1, 0, -0.12, [0, 0, -0.6]);
  },
  statue: (p) => {
    p.box(1.1, 0.9, 1.1, STONE, 0, 0.45, 0);
    p.box(0.6, 1.1, 0.4, STONE, 0, 1.45, 0);
    p.sph(0.2, STONE, 0, 2.2, 0);
    p.box(0.18, 0.8, 0.18, STONE, -0.45, 1.45, 0);
    p.box(0.16, 0.7, 0.16, STONE, 0.45, 1.85, -0.2, [-0.7, 0, 0]);
    p.sph(0.1, GLOW_GOLD, 0.45, 2.3, -0.55, 1, true);
  },
  column: (p) => {
    p.box(1.1, 0.3, 1.1, STONE, 0, 0.15, 0);
    p.cyl(0.38, 0.42, 3.6, 16, STONE, 0, 2.1, 0);
    p.cyl(0.42, 0.42, 0.12, 16, GOLD, 0, 2.0, 0);
    p.box(0.95, 0.3, 0.95, STONE, 0, 4.05, 0);
    p.box(1.1, 0.15, 1.1, GOLD, 0, 4.25, 0);
  },
  fountain: (p) => {
    p.cyl(1.8, 1.9, 0.5, 24, STONE, 0, 0.25, 0);
    p.cyl(1.65, 1.65, 0.04, 24, WATER, 0, 0.5, 0);
    p.cyl(0.25, 0.3, 1.2, 12, STONE, 0, 1.1, 0);
    p.cyl(0.6, 0.4, 0.2, 16, STONE, 0, 1.8, 0);
    p.sph(0.12, 0x9ee0ff, 0, 2.05, 0);
    p.cyl(0.7, 0.7, 0.02, 16, 0x9ee0ff, 0, 1.7, 0);
  },
  tapestry: (p, v) => {
    p.box(2.6, 3.2, 0.06, CLOTH[v], 0, 0, -0.03);
    p.box(2.4, 0.12, 0.08, GOLD, 0, 1.5, -0.05);
    p.box(2.4, 0.12, 0.08, GOLD, 0, -1.5, -0.05);
    p.box(0.12, 3.0, 0.08, GOLD, -1.2, 0, -0.05);
    p.box(0.12, 3.0, 0.08, GOLD, 1.2, 0, -0.05);
    for (const y of [0.9, 0, -0.9]) p.box(0.45, 0.45, 0.04, GOLD, 0, y, -0.07, [0, 0, Math.PI / 4]);
  },
  brazier: (p) => {
    p.cyl(0.5, 0.6, 0.1, 12, METAL, 0, 0.05, 0);
    p.cyl(0.08, 0.12, 2.0, 8, METAL, 0, 1.0, 0);
    p.cyl(0.7, 0.4, 0.5, 16, METAL, 0, 2.0, 0);
    for (const a of [0, 2.09, 4.19]) p.box(0.08, 1.2, 0.08, METAL, Math.sin(a) * 0.35, 0.6, Math.cos(a) * 0.35, [Math.cos(a) * 0.25, 0, -Math.sin(a) * 0.25]);
    p.sph(0.45, GLOW_FIRE, 0, 2.45, 0, 0.9, true);
    p.sph(0.25, GLOW_GOLD, 0, 2.5, 0, 1, true);
  },
  bench: (p) => {
    p.box(2.4, 0.12, 0.8, WOOD, 0, 0.55, 0);
    p.box(0.14, 0.55, 0.7, DARK, -1.0, 0.275, 0);
    p.box(0.14, 0.55, 0.7, DARK, 1.0, 0.275, 0);
    p.box(2.4, 0.6, 0.1, WOOD, 0, 0.95, 0.35);
  },
  palm: (p) => {
    p.cyl(0.18, 0.25, 4.0, 8, TRUNK, 0, 2.0, 0);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      p.box(0.4, 0.06, 2.0, GREEN, Math.sin(a) * 0.9, 4.1, Math.cos(a) * 0.9, [-0.4, a, 0]);
    }
    for (const [x, z] of [[0.15, 0.1], [-0.12, 0.14]]) p.sph(0.14, TRUNK, x, 3.9, z);
  },
  obelisk: (p) => {
    p.box(2.2, 0.6, 2.2, DARK, 0, 0.3, 0);
    p.box(1.3, 7.0, 1.3, STONE, 0, 4.1, 0);
    p.cone(0.92, 1.0, 4, GOLD, 0, 8.6, 0, [0, Math.PI / 4, 0]);
    for (let k = 0; k < 4; k++) p.box(0.05, 0.6 + k * 0.3, 0.02, GLOW_GOLD, -0.3 + k * 0.2, 2.5 + k * 1.4, -0.66, [0, 0, 0], true);
    p.sph(0.12, GLOW_GOLD, 0, 9.2, 0, 1, true);
  },
  arch: (p) => {
    p.box(0.9, 5.0, 0.9, STONE, -2.0, 2.5, 0);
    p.box(0.9, 5.0, 0.9, STONE, 2.0, 2.5, 0);
    p.box(5.0, 0.8, 0.9, STONE, 0, 5.4, 0);
    p.box(0.7, 0.9, 1.0, GOLD, 0, 5.4, 0);
    p.box(5.0, 0.3, 0.3, GLOW_GOLD, 0, 5.1, 0, [0, 0, 0], true);
  },
  mural: (p) => {
    p.box(6.0, 4.0, 0.12, DARK, 0, 0, 0);
    p.canvases.push({ x: 0, y: 0, z: -0.07, w: 5.6, h: 3.6, variant: 0, big: true });
  },
  totem: (p, v) => {
    p.box(1.2, 1.0, 1.2, CLOTH[v], 0, 0.5, 0);
    p.box(1.0, 1.2, 1.0, CLOTH[(v + 1) % 4], 0, 1.6, 0);
    p.box(1.2, 1.2, 1.2, CLOTH[(v + 2) % 4], 0, 2.8, 0);
    p.sph(0.1, GLOW_GOLD, -0.3, 2.95, -0.62, 1, true);
    p.sph(0.1, GLOW_GOLD, 0.3, 2.95, -0.62, 1, true);
    p.box(1.0, 1.0, 1.0, CLOTH[(v + 1) % 4], 0, 4.0, 0);
    p.box(0.8, 1.2, 0.8, CLOTH[v], 0, 5.6, 0);
    p.cone(0.5, 0.7, 4, GOLD, 0, 6.85, 0, [0, Math.PI / 4, 0]);
  },
  oak: (p) => {
    p.cyl(0.45, 0.7, 4.0, 10, TRUNK, 0, 2.0, 0);
    p.sph(2.2, GREEN_DARK, 0, 5.6, 0);
    for (const [x, y, z] of [[1.4, 5.0, 0.6], [-1.3, 5.3, -0.7], [0.4, 6.6, -1.2], [-0.6, 6.9, 0.9]]) p.sph(1.5, GREEN, x, y, z);
    p.sph(1.6, GREEN, 0, 6.9, 0);
  },
  // ---- Egypt: small
  scarab: (p) => {
    p.box(1.5, 1.1, 0.1, 0x8a6a40, 0, 0, 0.02);
    p.sph(0.34, LAPIS, 0, 0, -0.08, 0.6);
    p.box(0.6, 0.2, 0.04, GOLD, -0.42, 0.02, -0.1, [0, 0, 0.5]);
    p.box(0.6, 0.2, 0.04, GOLD, 0.42, 0.02, -0.1, [0, 0, -0.5]);
    p.sph(0.1, DARK, 0, 0.3, -0.14);
    for (let k = 0; k < 3; k++) for (const s of [-1, 1]) p.box(0.4, 0.04, 0.04, DARK, s * 0.45, -0.1 + k * 0.16, -0.1, [0, 0, s * 0.4]);
  },
  ankh: (p) => {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      p.box(0.13, 0.13, 0.1, GOLD, Math.cos(a) * 0.3, 0.55 + Math.sin(a) * 0.3, -0.05);
    }
    p.box(0.14, 0.85, 0.1, GOLD, 0, -0.175, -0.05);
    p.box(0.5, 0.13, 0.1, GOLD, 0, -0.1, -0.05);
    p.box(0.6, 1.2, 0.06, 0x8a6a40, 0, 0.1, 0.02);
  },
  eyeOfHorus: (p) => {
    p.box(1.2, 0.9, 0.08, LAPIS, 0, 0, 0.02);
    p.sph(0.28, LINEN, 0, 0, -0.07, 0.55);
    p.sph(0.13, LAPIS_DARK, 0, 0, -0.11, 1);
    p.sph(0.06, GLOW_GOLD, 0, 0, -0.14, 1, true);
    p.box(0.6, 0.07, 0.05, GOLD, 0, 0.24, -0.08);
    p.cyl(0.06, 0.06, 0.34, 6, GOLD, 0.3, -0.22, -0.07, [0, 0, 0.7]);
  },
  stele: (p) => {
    p.box(0.9, 0.15, 0.9, SAND_STONE, 0, 0.075, 0);
    p.box(0.8, 1.4, 0.18, SAND_STONE, 0, 0.85, 0);
    p.cone(0.56, 0.3, 4, SAND_STONE, 0, 1.7, 0, [0, Math.PI / 4, 0]);
    for (let row = 0; row < 7; row++) {
      for (let c = 0; c < 3; c++) p.box(0.14, 0.07, 0.02, DARK, -0.22 + c * 0.22 + (row % 2) * 0.05, 0.35 + row * 0.16, -0.1);
    }
    p.box(0.55, 0.05, 0.02, GOLD, 0, 1.5, -0.1);
  },
  canopicJars: (p) => {
    p.box(1.0, 0.1, 0.4, SAND_DARK, 0, 0.05, 0);
    const heads = [GOLD, DARK, LINEN, LAPIS];
    for (let k = 0; k < 4; k++) {
      const x = -0.3 + k * 0.2;
      p.cyl(0.1, 0.13, 0.5, 10, STONE_BLUE, x, 0.35, 0);
      p.sph(0.085, heads[k], x, 0.7, 0, 1.2);
      p.box(0.12, 0.05, 0.04, heads[k], x, 0.78, -0.06);
    }
  },
  papyrusReeds: (p) => {
    p.cyl(0.35, 0.28, 0.5, 10, LAPIS, 0, 0.25, 0);
    p.cyl(0.36, 0.36, 0.04, 10, GOLD, 0, 0.5, 0);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2, rr = 0.12 + (k % 2) * 0.08, x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const h = 1.8 + (k % 3) * 0.35;
      p.cyl(0.025, 0.02, h, 5, GREEN, x, 0.5 + h / 2, z, [Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12]);
      p.cone(0.13, 0.34, 7, GREEN_DARK, x, 0.5 + h + 0.12, z);
    }
  },
  lotusBowl: (p) => {
    p.cyl(0.5, 0.3, 0.35, 16, LAPIS, 0, 0.18, 0);
    p.cyl(0.52, 0.5, 0.06, 16, GOLD, 0, 0.36, 0);
    p.cyl(0.45, 0.45, 0.02, 16, WATER, 0, 0.3, 0);
    for (const [x, z, h] of [[0, 0, 0.5], [0.22, 0.12, 0.42], [-0.2, 0.1, 0.4]]) {
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        p.cone(0.09, 0.3, 6, LOTUS_PINK, x + Math.cos(a) * 0.05, 0.36 + h / 2, z + Math.sin(a) * 0.05, [Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35]);
      }
      p.sph(0.05, GOLD, x, 0.5 + h * 0.4, z, 1);
    }
  },
  ushabti: (p) => {
    p.box(0.4, 0.06, 0.3, SAND_DARK, 0, 0.03, 0);
    p.box(0.2, 0.45, 0.12, TURQUOISE, 0, 0.3, 0);
    p.sph(0.1, TURQUOISE, 0, 0.62, 0);
    p.box(0.26, 0.1, 0.14, TURQUOISE, 0, 0.44, -0.05);
    p.box(0.2, 0.04, 0.14, GOLD, 0, 0.53, -0.03);
    p.box(0.04, 0.4, 0.04, WOOD, 0.13, 0.3, -0.08, [0.2, 0, 0]);
  },
  offeringTable: (p) => {
    p.box(1.2, 0.1, 0.8, SAND_STONE, 0, 0.65, 0);
    for (const [x, z] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]]) p.cyl(0.08, 0.1, 0.6, 8, SAND_DARK, x, 0.3, z);
    p.cyl(0.25, 0.25, 0.04, 14, GOLD, 0, 0.72, 0.15);
    for (const x of [-0.3, 0, 0.3]) p.sph(0.13, BREAD, x, 0.85, -0.05, 0.6);
    p.cone(0.09, 0.3, 6, LOTUS_PINK, 0.4, 0.9, 0.2);
  },
  // ---- Egypt: medium
  pharaoh: (p) => {
    p.box(1.0, 0.5, 0.8, SAND_DARK, 0, 0.25, 0);
    p.box(0.9, 0.45, 0.7, SAND_STONE, 0, 0.72, 0);
    p.box(0.9, 1.2, 0.12, SAND_STONE, 0, 1.5, 0.3);
    p.box(0.18, 0.1, 0.5, GOLD, -0.42, 1.0, -0.1);
    p.box(0.18, 0.1, 0.5, GOLD, 0.42, 1.0, -0.1);
    p.box(0.5, 0.8, 0.35, SAND_STONE, 0, 1.5, -0.05);
    p.sph(0.2, SAND_STONE, 0, 2.2, -0.02);
    p.box(0.5, 0.4, 0.45, LAPIS, 0, 2.25, 0);
    p.box(0.52, 0.05, 0.47, GOLD, 0, 2.1, 0);
    for (const s of [-1, 1]) p.box(0.14, 0.6, 0.1, LAPIS, s * 0.3, 1.85, 0.05);
    p.box(0.05, 0.2, 0.04, GOLD, 0, 2.0, -0.2);
    p.box(0.5, 0.1, 0.05, GOLD, 0, 1.9, -0.2);
  },
  anubis: (p) => {
    p.box(1.0, 0.4, 0.9, SAND_DARK, 0, 0.2, 0);
    p.box(0.45, 0.9, 0.35, BLACK_GLAZE, 0, 0.85, 0);
    p.box(0.4, 0.35, 0.5, BLACK_GLAZE, 0, 1.6, -0.05);
    p.box(0.18, 0.2, 0.3, BLACK_GLAZE, 0, 1.55, -0.35);
    for (const s of [-1, 1]) {
      p.cone(0.09, 0.3, 4, BLACK_GLAZE, s * 0.13, 1.95, 0);
      p.sph(0.04, GLOW_GOLD, s * 0.09, 1.65, -0.27, 1, true);
    }
    p.box(0.5, 0.08, 0.4, GOLD, 0, 1.3, 0);
    p.box(0.05, 1.2, 0.05, GOLD, 0.35, 0.9, -0.2);
  },
  papyrusColumn: (p) => {
    p.box(1.0, 0.3, 1.0, SAND_STONE, 0, 0.15, 0);
    p.cyl(0.3, 0.36, 3.2, 12, STEM, 0, 1.9, 0);
    for (let k = 0; k < 3; k++) p.cyl(0.37, 0.37, 0.08, 12, GREEN_DARK, 0, 0.9 + k * 1.0, 0);
    p.cyl(0.6, 0.3, 0.6, 12, GREEN, 0, 3.9, 0);
    p.cyl(0.7, 0.7, 0.1, 12, GOLD, 0, 4.25, 0);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      p.cone(0.12, 0.9, 5, GREEN_DARK, Math.cos(a) * 0.4, 4.55, Math.sin(a) * 0.4, [Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35]);
    }
  },
  lotusColumn: (p) => {
    p.box(1.0, 0.3, 1.0, SAND_STONE, 0, 0.15, 0);
    p.cyl(0.3, 0.34, 3.0, 12, SAND_STONE, 0, 1.8, 0);
    for (let k = 0; k < 3; k++) p.cyl(0.36, 0.36, 0.08, 12, GOLD, 0, 0.9 + k * 0.9, 0);
    p.cyl(0.5, 0.3, 0.6, 12, SAND_STONE, 0, 3.6, 0);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      p.cone(0.14, 0.7, 4, LOTUS_PINK, Math.cos(a) * 0.38, 4.0, Math.sin(a) * 0.38, [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3]);
    }
    p.box(1.0, 0.14, 1.0, GOLD, 0, 4.1, 0);
  },
  chariot: (p) => {
    for (const x of [-0.75, 0.75]) {
      p.cyl(0.45, 0.45, 0.1, 14, WOOD_DARK, x, 0.45, 0, [0, 0, Math.PI / 2]);
      p.cyl(0.36, 0.36, 0.12, 14, GOLD, x, 0.45, 0, [0, 0, Math.PI / 2]);
      for (const a of [0, Math.PI / 2]) p.box(0.06, 0.82, 0.06, WOOD, x, 0.45, 0, [a, 0, 0]);
    }
    p.box(1.2, 0.35, 1.0, WOOD, 0, 0.9, 0);
    p.box(1.3, 0.6, 0.08, GOLD, 0, 1.1, -0.5);
    for (const s of [-1, 1]) p.box(0.08, 0.7, 1.0, CLOTH[0], s * 0.6, 1.0, 0);
    p.box(0.08, 0.08, 1.4, WOOD, 0, 0.7, -1.4);
    p.box(1.0, 0.06, 0.06, GOLD, 0, 1.0, -1.9);
  },
  sarcophagus: (p) => {
    p.box(1.0, 0.2, 0.7, SAND_DARK, 0, 0.1, 0);
    p.box(0.9, 1.6, 0.6, LAPIS, 0, 1.0, 0);
    p.box(0.8, 0.3, 0.05, GOLD, 0, 1.9, -0.3);
    p.sph(0.22, GOLD, 0, 1.95, -0.02, 1.1);
    for (const s of [-1, 1]) p.box(0.12, 0.5, 0.08, LAPIS, s * 0.3, 1.55, 0);
    p.box(0.04, 0.22, 0.03, GOLD, 0, 1.5, -0.25);
    p.box(0.5, 0.08, 0.35, GOLD, 0, 1.3, -0.2);
    for (let k = 0; k < 4; k++) p.box(0.8, 0.04, 0.02, GOLD, 0, 0.5 + k * 0.3, -0.31);
  },
  // ---- Egypt: large
  sphinx: (p) => {
    p.box(3.4, 1.5, 1.7, SAND, 0, 0.75, 0.3);
    p.box(0.9, 1.1, 0.9, SAND, 0, 2.0, -1.9);
    p.box(1.2, 0.6, 1.1, LAPIS, 0, 2.5, -1.9);
    for (const s of [-1, 1]) p.box(0.3, 1.2, 0.4, LAPIS, s * 0.65, 1.7, -1.9);
    for (const s of [-1, 1]) p.box(0.7, 0.5, 1.3, SAND, s * 0.5, 0.25, -1.6);
    p.box(0.12, 0.5, 0.1, GOLD, 0, 1.2, -2.2);
    p.box(3.8, 0.3, 2.4, SAND_DARK, 0, 0.15, 0.1);
    for (const s of [-1, 1]) p.sph(0.05, GLOW_GOLD, s * 0.2, 2.2, -2.37, 1, true);
  },
  pylon: (p) => {
    for (const s of [-1, 1]) {
      const x = s * 2.4;
      p.box(2.2, 1.5, 1.8, SAND_STONE, x, 0.75, 0);
      p.box(1.9, 2.0, 1.6, SAND, x, 2.5, 0);
      p.box(1.6, 2.0, 1.4, SAND_STONE, x, 4.5, 0);
      p.box(1.9, 0.12, 1.6, GOLD, x, 6.06, 0);
      p.box(0.06, 1.6, 0.06, WOOD, x + s * 0.4, 6.8, 0);
      p.box(0.9, 0.6, 0.03, CLOTH[0], x + s * 0.85, 7.0, 0);
    }
    p.box(3.4, 0.8, 1.2, SAND, 0, 5.6, 0);
    p.box(5.0, 0.2, 1.8, GOLD, 0, 6.1, 0);
    p.box(0.8, 0.8, 0.02, DARK, 0, 0.6, -0.91);
    for (let k = 0; k < 4; k++) p.box(0.1, 0.1, 0.02, GLOW_GOLD, -2.4 + k * 0.2, 2.4, -0.82, [0, 0, 0], true);
  },
  stepPyramid: (p) => {
    [5.6, 4.6, 3.6, 2.6, 1.6].forEach((w, k) => p.box(w, 1.0, w, k % 2 ? SAND_STONE : SAND, 0, 0.5 + k, 0));
    p.box(0.6, 0.5, 0.6, GOLD, 0, 5.25, 0);
    p.sph(0.2, GLOW_GOLD, 0, 5.7, 0, 1, true);
    p.box(0.9, 0.9, 0.1, DARK, 0, 0.5, -2.85);
  },
  solarBarque: (p) => {
    p.box(3.6, 0.6, 1.3, WOOD, 0, 0.5, 0);
    p.box(0.8, 0.9, 1.0, WOOD, -1.6, 0.9, 0);
    p.box(0.6, 0.9, 0.9, WOOD, 1.6, 0.9, 0);
    p.box(1.4, 0.9, 1.0, GOLD, 0, 1.35, 0);
    p.box(1.6, 0.14, 1.2, LAPIS, 0, 1.9, 0);
    for (const s of [-1, 1]) p.box(3.2, 0.06, 0.06, GOLD, 0, 0.3, s * 0.9);
    p.cyl(0.06, 0.06, 3.0, 6, GOLD, 0, 3.4, 0);
    p.sph(0.45, GLOW_GOLD, 0, 4.4, 0, 1, true);
  },
  colossus: (p) => {
    p.box(2.4, 1.0, 2.0, SAND_DARK, 0, 0.5, 0);
    for (const s of [-1, 1]) {
      p.box(0.8, 0.8, 1.6, SAND, s * 0.7, 1.4, -0.6);
      p.box(0.4, 0.3, 0.4, SAND, s * 0.75, 1.9, -0.7);
      p.box(0.5, 1.2, 0.5, SAND, s * 1.1, 2.6, -0.2);
    }
    p.box(1.6, 2.0, 1.2, SAND, 0, 2.5, 0);
    p.box(0.9, 0.95, 0.9, SAND, 0, 4.5, -0.05);
    p.box(1.2, 1.0, 1.1, LAPIS, 0, 4.6, 0);
    for (const s of [-1, 1]) p.box(0.28, 1.3, 0.3, LAPIS, s * 0.7, 4.0, 0);
    p.box(0.14, 0.5, 0.1, GOLD, 0, 4.0, -0.5);
    for (const s of [-1, 1]) p.sph(0.05, GLOW_GOLD, s * 0.15, 4.6, -0.5, 1, true);
  },
};

// ---------------------------------------------------------------- pictures

const canvasTextures = new Map<string, THREE.CanvasTexture>();

/** A picture, painted on canvas: four kinds of scene (a sunset over dunes, a starry night, shapes, a sea and a boat). */
function paint(variant: number, big: boolean): THREE.CanvasTexture {
  const key = `${variant}-${big}`;
  const hit = canvasTextures.get(key);
  if (hit) return hit;
  const W = big ? 560 : 256, H = big ? 360 : 180;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  let seed = 7 + variant * 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (variant === 0) { // sunset over dunes
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#f6a85b'); sky.addColorStop(1, '#ffe2a4');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff3c4'; g.beginPath(); g.arc(W * 0.7, H * 0.45, H * 0.16, 0, Math.PI * 2); g.fill();
    const dune = (y: number, col: string, amp: number) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) g.lineTo(x, H * y + Math.sin(x * 0.02 + y * 9) * H * amp);
      g.lineTo(W, H); g.fill();
    };
    dune(0.6, '#d9893f', 0.05); dune(0.75, '#b86a2e', 0.06); dune(0.9, '#7a3f1c', 0.04);
  } else if (variant === 1) { // starry night over hills
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0d1b3d'); sky.addColorStop(1, '#2a4f8a');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#fff8d8';
    for (let i = 0; i < (big ? 140 : 60); i++) { g.beginPath(); g.arc(rnd() * W, rnd() * H * 0.7, rnd() * 1.6 + 0.4, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#ffe9a0'; g.beginPath(); g.arc(W * 0.78, H * 0.22, H * 0.11, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0d1b3d'; g.beginPath(); g.arc(W * 0.8, H * 0.2, H * 0.1, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#132a2a'; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, H * 0.8 + Math.sin(x * 0.015) * H * 0.08);
    g.lineTo(W, H); g.fill();
  } else if (variant === 2) { // shapes, bold
    g.fillStyle = '#f2e6c9'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#e4572e'; g.beginPath(); g.arc(W * 0.3, H * 0.5, H * 0.32, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#29335c'; g.fillRect(W * 0.55, H * 0.15, W * 0.3, H * 0.7);
    g.fillStyle = '#f3a712'; g.beginPath(); g.moveTo(W * 0.1, H); g.lineTo(W * 0.45, H * 0.7); g.lineTo(W * 0.8, H); g.fill();
    g.fillStyle = '#00a6a6'; g.beginPath(); g.arc(W * 0.9, H * 0.15, H * 0.1, 0, Math.PI * 2); g.fill();
  } else { // a sea and a boat
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#7ccbe9'); sky.addColorStop(1, '#e9f8ff');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1d6fa3'; g.fillRect(0, H * 0.6, W, H * 0.4);
    g.strokeStyle = '#e8f7ff'; g.lineWidth = 2;
    for (let y = H * 0.66; y < H; y += H * 0.08) { g.beginPath(); for (let x = 0; x <= W; x += 10) g.lineTo(x, y + Math.sin(x * 0.05 + y) * 2); g.stroke(); }
    g.fillStyle = '#f4f1e8'; g.beginPath(); g.moveTo(W * 0.42, H * 0.25); g.lineTo(W * 0.42, H * 0.6); g.lineTo(W * 0.22, H * 0.6); g.fill();
    g.beginPath(); g.moveTo(W * 0.46, H * 0.3); g.lineTo(W * 0.46, H * 0.6); g.lineTo(W * 0.66, H * 0.6); g.fill();
    g.fillStyle = '#b8322a'; g.beginPath(); g.moveTo(W * 0.18, H * 0.6); g.lineTo(W * 0.7, H * 0.6); g.lineTo(W * 0.62, H * 0.7); g.lineTo(W * 0.26, H * 0.7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  canvasTextures.set(key, t);
  return t;
}

// ---------------------------------------------------------------- the map's decorations

/**
 * Every decoration of a map, as meshes: one for the solid parts, one unlit for
 * the glowing parts, and a plane per painting. Returns what to dispose with them.
 */
export function buildProps(props: PlacedProp[]): { group: THREE.Group; owned: (THREE.BufferGeometry | THREE.Material)[] } {
  const group = new THREE.Group();
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const solid: THREE.BufferGeometry[] = [], glow: THREE.BufferGeometry[] = [];
  for (const pr of props) {
    const world = new THREE.Matrix4().compose(new THREE.Vector3(pr.pos.x, pr.pos.y, pr.pos.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pr.yaw), new THREE.Vector3(1, 1, 1));
    const parts = new Parts(world);
    BUILD[pr.kind](parts, pr.variant);
    solid.push(...parts.solid);
    glow.push(...parts.glow);
    if (parts.canvases.length) {
      const pg = new THREE.Group();
      pg.position.set(pr.pos.x, pr.pos.y, pr.pos.z);
      pg.rotation.y = pr.yaw;
      for (const cv of parts.canvases) {
        const geo = new THREE.PlaneGeometry(cv.w, cv.h);
        const mat = new THREE.MeshLambertMaterial({ map: paint(pr.variant, cv.big) });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(cv.x, cv.y, cv.z);
        mesh.rotation.y = Math.PI; // faces the front, -z
        pg.add(mesh);
        owned.push(geo, mat);
      }
      group.add(pg);
    }
  }
  if (solid.length) {
    const geo = mergeGeometries(solid, false)!;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    group.add(new THREE.Mesh(geo, mat));
    owned.push(geo, mat, ...solid);
  }
  if (glow.length) {
    const geo = mergeGeometries(glow, false)!;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
    group.add(new THREE.Mesh(geo, mat));
    owned.push(geo, mat, ...glow);
  }
  return { group, owned };
}
