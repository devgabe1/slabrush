import * as THREE from 'three';
import { v3, vcross, vdot, vnorm, vsub, type Vec3 } from '../core/vec';
import type { MapDef, MatId, Solid, Trigger } from '../sim/map';

// Turns MapDef solids into one merged mesh per material (few draw calls).
// UVs are projected from world space so textures line up across blocks.
// Dark areas are baked in as vertex colours.
const TILE = 0.5; // texture repeats every 2 m
const DARK = 0.2; // brightness of surfaces inside a dark area

interface Acc {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
}

type Box = { min: Vec3; max: Vec3; level?: number };

/** How dark it is at p (0 lit .. 1 darkest), from the dark areas it is in. */
function darkAt(p: Vec3, boxes: Box[]): number {
  let k = 0;
  for (const b of boxes) {
    if (p.x > b.min.x - 0.05 && p.x < b.max.x + 0.05 && p.y > b.min.y - 0.05 && p.y < b.max.y + 0.05
      && p.z > b.min.z - 0.05 && p.z < b.max.z + 0.05) k = Math.max(k, b.level ?? 1);
  }
  return k;
}

/** Add a convex polygon, automatically wound to face away from `centroid`. */
function pushPoly(a: Acc, verts: Vec3[], centroid: Vec3, dark: Box[]): void {
  let n = vnorm(vcross(vsub(verts[1], verts[0]), vsub(verts[2], verts[0])));
  const fc = v3();
  for (const p of verts) { fc.x += p.x / verts.length; fc.y += p.y / verts.length; fc.z += p.z / verts.length; }
  if (vdot(n, vsub(fc, centroid)) < 0) {
    verts = [...verts].reverse();
    n = v3(-n.x, -n.y, -n.z);
  }
  // A whole face is either lit or dark (decided at its centre), so darkness
  // never smears across a large neighbouring floor.
  let shade = dark.length ? 1 - (1 - DARK) * darkAt(fc, dark) : 1;
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  // Cheap baked lighting, in vertex colours:
  //  - every face gets a slightly different tone, like separately cast slabs
  //  - walls darken towards their base (fake ambient occlusion)
  //  - undersides are dim
  const h = Math.sin(fc.x * 12.9898 + fc.y * 78.233 + fc.z * 37.719) * 43758.5453;
  shade *= 1 + (h - Math.floor(h) - 0.5) * 0.09;
  if (n.y < -0.5) shade *= 0.6;
  let lo = Infinity, hi = -Infinity;
  for (const p of verts) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  const wall = ay < 0.5 && hi - lo > 0.3;
  const span = Math.min(hi - lo, 3.5);
  for (let i = 1; i < verts.length - 1; i++) {
    for (const p of [verts[0], verts[i], verts[i + 1]]) {
      const v = wall ? shade * (0.68 + 0.32 * Math.min(1, (p.y - lo) / span)) : shade;
      a.pos.push(p.x, p.y, p.z);
      a.nor.push(n.x, n.y, n.z);
      a.col.push(v, v, v);
      if (ay >= ax && ay >= az) a.uv.push(p.x * TILE, p.z * TILE);
      else if (ax >= az) a.uv.push(p.z * TILE, p.y * TILE);
      else a.uv.push(p.x * TILE, p.y * TILE);
    }
  }
}

function addSolid(a: Acc, s: Solid, dark: Box[]): void {
  const { min: lo, max: hi } = s;
  const c = v3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2);
  if (s.type === 'box') {
    const p = (i: number, j: number, k: number) => v3(i ? hi.x : lo.x, j ? hi.y : lo.y, k ? hi.z : lo.z);
    pushPoly(a, [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)], c, dark);
    pushPoly(a, [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)], c, dark);
    pushPoly(a, [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)], c, dark);
    pushPoly(a, [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)], c, dark);
    pushPoly(a, [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)], c, dark);
    pushPoly(a, [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)], c, dark);
    return;
  }
  // Ramp: a triangular prism. A = low edge, B = under the high edge, C = high edge.
  let A0: Vec3, A1: Vec3, B0: Vec3, B1: Vec3, C0: Vec3, C1: Vec3;
  if (s.high === '-z' || s.high === '+z') {
    const hz = s.high === '-z' ? lo.z : hi.z, lz = s.high === '-z' ? hi.z : lo.z;
    A0 = v3(lo.x, lo.y, lz); A1 = v3(hi.x, lo.y, lz);
    B0 = v3(lo.x, lo.y, hz); B1 = v3(hi.x, lo.y, hz);
    C0 = v3(lo.x, hi.y, hz); C1 = v3(hi.x, hi.y, hz);
  } else {
    const hx = s.high === '-x' ? lo.x : hi.x, lx = s.high === '-x' ? hi.x : lo.x;
    A0 = v3(lx, lo.y, lo.z); A1 = v3(lx, lo.y, hi.z);
    B0 = v3(hx, lo.y, lo.z); B1 = v3(hx, lo.y, hi.z);
    C0 = v3(hx, hi.y, lo.z); C1 = v3(hx, hi.y, hi.z);
  }
  const all = [A0, A1, B0, B1, C0, C1];
  const pc = v3();
  for (const p of all) { pc.x += p.x / 6; pc.y += p.y / 6; pc.z += p.z / 6; }
  pushPoly(a, [A0, A1, C1, C0], pc, dark); // slope
  pushPoly(a, [A0, A1, B1, B0], pc, dark); // bottom
  pushPoly(a, [B0, B1, C1, C0], pc, dark); // back
  pushPoly(a, [A0, B0, C0], pc, dark);
  pushPoly(a, [A1, B1, C1], pc, dark);
}

function toMesh(a: Acc, mat: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(a.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(a.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(a.uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(a.col, 3));
  return new THREE.Mesh(geo, mat);
}

export const darkBoxes = (triggers: Trigger[]): Box[] => triggers.filter((t) => t.type === 'dark');

/** Everything that does not move, merged per material. */
export function buildMapMesh(map: MapDef, mats: Record<MatId, THREE.Material>): THREE.Group {
  const dark = darkBoxes(map.triggers);
  const acc = new Map<MatId, Acc>();
  for (const s of map.solids) {
    if (s.mover) continue;
    let a = acc.get(s.mat);
    if (!a) acc.set(s.mat, (a = { pos: [], nor: [], uv: [], col: [] }));
    addSolid(a, s, dark);
  }
  const group = new THREE.Group();
  for (const [mat, a] of acc) group.add(toMesh(a, mats[mat] ?? mats.concrete)); // (a theme material the palette lacks: plain concrete)
  return group;
}

/** One mesh for a moving brush, built at its rest position; the renderer offsets it each frame. */
export function buildSolidMesh(s: Solid, mats: Record<MatId, THREE.Material>, dark: Box[] = []): THREE.Mesh {
  const a: Acc = { pos: [], nor: [], uv: [], col: [] };
  addSolid(a, s, dark);
  return toMesh(a, mats[s.mat] ?? mats.concrete);
}
