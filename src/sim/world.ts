import { DT } from '../config/game';
import { v3, vcopy, type Vec3 } from '../core/vec';
import type { MoverDef, Solid, Surface, Trigger } from './map';

// Collision world made of convex brushes (sets of planes), traced with a
// swept AABB — the classic Quake approach. It is exact for boxes and ramps,
// never tunnels, and gives clean surface normals for sliding along walls.
//
// Some brushes move (platforms, elevators, doors). Their position depends
// only on the tick, see setTick().

interface Plane {
  nx: number;
  ny: number;
  nz: number;
  d: number; // point is inside when n·p - d <= 0
}

export interface Brush {
  planes: Plane[];
  min: Vec3;
  max: Vec3;
  surface: Surface;
  push: Vec3 | null; // conveyor velocity
  mover: MoverDef | null;
  /** hulls only: the real faces (the rest of `planes` are bevels, which must never be reported as what was hit) */
  faces: Plane[] | null;
  /** movers only: rest pose, and how far the brush moved during the current tick */
  base: { min: Vec3; max: Vec3; d: number[] } | null;
  delta: Vec3;
}

export interface Trace {
  fraction: number; // 0..1 of the move completed
  end: Vec3;
  normal: Vec3; // surface normal at impact (zero if none)
  startSolid: boolean;
  allSolid: boolean;
  surface: Surface;
  brush: Brush | null; // what was hit (or what we started inside of)
}

/** Hull is kept this far from surfaces so floating point error never lets it leak through. */
const EPS = 0.003;
const ZERO = v3();

/** 0..1 position of a mover along its path at a (possibly fractional) tick. */
export function moverFraction(m: MoverDef, tick: number): number {
  const period = 2 * m.moveTime + m.waitA + m.waitB;
  let t = (tick * DT + m.phase) % period;
  if (t < 0) t += period;
  if (t < m.waitA) return 0;
  t -= m.waitA;
  if (t < m.moveTime) return t / m.moveTime;
  t -= m.moveTime;
  if (t < m.waitB) return 1;
  return 1 - (t - m.waitB) / m.moveTime;
}

function makeBrush(s: Solid): Brush {
  const { min, max } = s;
  // The six axial planes. For ramps these act as bevels, which keeps the
  // swept-box test exact around the sharp edges of the wedge.
  const planes: Plane[] = [
    { nx: 1, ny: 0, nz: 0, d: max.x },
    { nx: -1, ny: 0, nz: 0, d: -min.x },
    { nx: 0, ny: 1, nz: 0, d: max.y },
    { nx: 0, ny: -1, nz: 0, d: -min.y },
    { nx: 0, ny: 0, nz: 1, d: max.z },
    { nx: 0, ny: 0, nz: -1, d: -min.z },
  ];
  let faces: Plane[] | null = null;
  if (s.type === 'hull') {
    const h = hullPlanes(s);
    faces = h.faces;
    planes.push(...h.faces, ...h.bevels);
  }
  if (s.type === 'ramp') {
    const H = max.y - min.y;
    let nx = 0, ny = 0, nz = 0, px = min.x, pz = min.z;
    switch (s.high) {
      case '-z': ny = max.z - min.z; nz = H; pz = min.z; break;
      case '+z': ny = max.z - min.z; nz = -H; pz = max.z; break;
      case '-x': ny = max.x - min.x; nx = H; px = min.x; break;
      default: ny = max.x - min.x; nx = -H; px = max.x; break; // '+x'
    }
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    planes.push({ nx, ny, nz, d: nx * px + ny * max.y + nz * pz });
  }
  return {
    planes, min: vcopy(min), max: vcopy(max), surface: s.surface ?? 'normal',
    push: s.push ? vcopy(s.push) : null,
    mover: s.mover ?? null,
    faces,
    base: s.mover ? { min: vcopy(min), max: vcopy(max), d: planes.map((p) => p.d) } : null,
    delta: v3(),
  };
}

/**
 * A convex hull's planes: one per face, facing out, plus a bevel along every
 * edge (halfway between the two faces). The bevels are what keep the swept box
 * from catching on an invisible point above a sharp edge, such as a surf ridge.
 */
function hullPlanes(s: Solid): { faces: Plane[]; bevels: Plane[] } {
  const faces = s.faces ?? [];
  const c = { x: 0, y: 0, z: 0 };
  let n = 0;
  for (const f of faces) for (const p of f) { c.x += p.x; c.y += p.y; c.z += p.z; n++; }
  c.x /= n; c.y /= n; c.z /= n;
  const out: Plane[] = [];
  const bevels: Plane[] = [];
  const faceNormal: Vec3[] = [];
  for (const f of faces) {
    const ax = f[1].x - f[0].x, ay = f[1].y - f[0].y, az = f[1].z - f[0].z;
    const bx = f[2].x - f[0].x, by = f[2].y - f[0].y, bz = f[2].z - f[0].z;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (nx * (f[0].x - c.x) + ny * (f[0].y - c.y) + nz * (f[0].z - c.z) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    faceNormal.push(v3(nx, ny, nz));
    out.push({ nx, ny, nz, d: nx * f[0].x + ny * f[0].y + nz * f[0].z });
  }
  // Edges shared by two faces.
  const key = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const edges = new Map<string, { a: Vec3; face: number }>();
  faces.forEach((f, i) => f.forEach((a, k) => {
    const b = f[(k + 1) % f.length];
    const ka = key(a), kb = key(b);
    const id = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    const other = edges.get(id);
    if (!other) { edges.set(id, { a, face: i }); return; }
    const n1 = faceNormal[other.face], n2 = faceNormal[i];
    let nx = n1.x + n2.x, ny = n1.y + n2.y, nz = n1.z + n2.z;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-6) return;
    nx /= l; ny /= l; nz /= l;
    if (Math.abs(nx) > 0.9999 || Math.abs(ny) > 0.9999 || Math.abs(nz) > 0.9999) return; // the axial bevels cover it
    bevels.push({ nx, ny, nz, d: nx * a.x + ny * a.y + nz * a.z });
  }));
  return { faces: out, bevels };
}

function freshTrace(end: Vec3): Trace {
  return { fraction: 1, end: vcopy(end), normal: v3(), startSolid: false, allSolid: false, surface: 'normal', brush: null };
}

export class World {
  brushes: Brush[] = [];
  movers: Brush[] = [];
  triggers: Trigger[];
  private tick = NaN;

  constructor(solids: Solid[], triggers: Trigger[] = []) {
    for (const s of solids) {
      const b = makeBrush(s);
      this.brushes.push(b);
      if (b.mover) this.movers.push(b);
    }
    this.triggers = triggers.filter((t) => t.type !== 'dark');
    this.setTick(0);
  }

  /**
   * Put every mover where it is at `tick`, and remember how far it travelled
   * since tick-1 (used to carry and push players). Cheap and idempotent: the
   * host calls it once per step, client prediction once per replayed input.
   */
  setTick(tick: number): void {
    if (tick === this.tick) return;
    this.tick = tick;
    for (const b of this.movers) {
      const m = b.mover!, base = b.base!;
      const f1 = moverFraction(m, tick), f0 = moverFraction(m, tick - 1);
      const ox = m.dx * f1, oy = m.dy * f1, oz = m.dz * f1;
      b.min.x = base.min.x + ox; b.min.y = base.min.y + oy; b.min.z = base.min.z + oz;
      b.max.x = base.max.x + ox; b.max.y = base.max.y + oy; b.max.z = base.max.z + oz;
      for (let i = 0; i < b.planes.length; i++) {
        const p = b.planes[i];
        p.d = base.d[i] + p.nx * ox + p.ny * oy + p.nz * oz;
      }
      b.delta.x = m.dx * (f1 - f0); b.delta.y = m.dy * (f1 - f0); b.delta.z = m.dz * (f1 - f0);
    }
  }

  /** Sweep an AABB (mins/maxs relative to the origin) from start to end. */
  traceBox(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): Trace {
    const tr = freshTrace(end);
    const pad = EPS * 2;
    const bx0 = Math.min(start.x, end.x) + mins.x - pad, bx1 = Math.max(start.x, end.x) + maxs.x + pad;
    const by0 = Math.min(start.y, end.y) + mins.y - pad, by1 = Math.max(start.y, end.y) + maxs.y + pad;
    const bz0 = Math.min(start.z, end.z) + mins.z - pad, bz1 = Math.max(start.z, end.z) + maxs.z + pad;

    for (const b of this.brushes) {
      if (b.min.x > bx1 || b.max.x < bx0 || b.min.y > by1 || b.max.y < by0 || b.min.z > bz1 || b.max.z < bz0) continue;
      clipToBrush(b, start, end, mins, maxs, tr);
      if (tr.allSolid) break;
    }
    finish(tr, start, end);
    return tr;
  }

  /** Same sweep against one brush only. */
  traceBrush(b: Brush, start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): Trace {
    const tr = freshTrace(end);
    clipToBrush(b, start, end, mins, maxs, tr);
    finish(tr, start, end);
    return tr;
  }

  traceRay(start: Vec3, end: Vec3): Trace {
    return this.traceBox(start, end, ZERO, ZERO);
  }
}

function finish(tr: Trace, start: Vec3, end: Vec3): void {
  if (tr.fraction < 1) {
    tr.end.x = start.x + (end.x - start.x) * tr.fraction;
    tr.end.y = start.y + (end.y - start.y) * tr.fraction;
    tr.end.z = start.z + (end.z - start.z) * tr.fraction;
  }
}

function clipToBrush(b: Brush, start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, tr: Trace): void {
  let enterFrac = -1;
  let leaveFrac = 1;
  let clip: Plane | null = null;
  let startOut = false;
  let getOut = false;

  for (const p of b.planes) {
    // Push the plane out by the hull's support point (Minkowski sum).
    const ox = p.nx < 0 ? maxs.x : mins.x;
    const oy = p.ny < 0 ? maxs.y : mins.y;
    const oz = p.nz < 0 ? maxs.z : mins.z;
    const dist = p.d - (ox * p.nx + oy * p.ny + oz * p.nz);
    const d1 = start.x * p.nx + start.y * p.ny + start.z * p.nz - dist;
    const d2 = end.x * p.nx + end.y * p.ny + end.z * p.nz - dist;

    if (d2 > 0) getOut = true;
    if (d1 > 0) startOut = true;
    // Entirely in front of this plane: the move cannot touch the brush.
    if (d1 > 0 && (d2 >= EPS || d2 >= d1)) return;
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      let f = (d1 - EPS) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) { enterFrac = f; clip = p; }
    } else {
      let f = (d1 + EPS) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startOut) {
    tr.startSolid = true;
    if (!tr.brush || b.mover) tr.brush = b; // prefer reporting the mover we are stuck in
    if (!getOut) { tr.allSolid = true; tr.fraction = 0; }
    return;
  }
  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction && clip) {
    tr.fraction = enterFrac < 0 ? 0 : enterFrac;
    // A bevel is only there to keep the box off sharp edges: report the real face
    // closest to it instead (a surf ridge's crest is a slope, not a floor); between
    // two equally close ones, the one the move runs into more.
    if (b.faces && !b.faces.includes(clip)) {
      const bev = clip;
      const mx = end.x - start.x, my = end.y - start.y, mz = end.z - start.z;
      let bestSim = -Infinity, bestInto = Infinity;
      for (const f of b.faces) {
        const sim = f.nx * bev.nx + f.ny * bev.ny + f.nz * bev.nz;
        const into = f.nx * mx + f.ny * my + f.nz * mz;
        if (sim > bestSim + 0.02 || (sim > bestSim - 0.02 && into < bestInto)) {
          if (sim > bestSim) bestSim = sim;
          bestInto = into;
          clip = f;
        }
      }
    }
    tr.normal.x = clip.nx; tr.normal.y = clip.ny; tr.normal.z = clip.nz;
    tr.surface = b.surface;
    if (!tr.startSolid) tr.brush = b;
  }
}
