import { BOTS } from '../config/bots';
import { PLAYER } from '../config/game';
import { MOVE } from '../config/movement';
import { v3, vcopy, type Vec3 } from '../core/vec';
import type { MapDef } from './map';
import { HULL } from './pmove';
import { World, type Brush, type Trace } from './world';

// Where battle bots can walk, for finding their way round walls and up to
// other levels (see sim/bot.ts). Maps carry no navigation data, so it is
// worked out from the map itself, once per map, on the host:
//
//   - a grid of columns (NAV.cell m apart) over the play area; in each, every
//     surface a player can stand on (flat enough, not deadly, room for the
//     body above it) is a node
//   - neighbouring nodes are joined where a player can walk, step or hop
//     between them (up to NAV.climb higher) or drop down (up to BOTS.maxDrop),
//     with nothing in the way
//   - a ledge is joined to ground across a gap that a running jump clears
//   - jump pads join the nodes on them to the ground they can throw you onto
//     (you steer in the air); teleporters join the nodes on them to where they send you
//   - elevators and moving platforms get nodes on top of them at both ends of
//     their run, joined as a ride: the bot stands there and waits to be carried
//     (steer will not walk it off an edge while the platform is away)
//
// Movers never block in the plan (a door is a way through: it opens). Paths
// are found with A*.

/** How an edge is travelled: walked, jumped across a gap, thrown by a jump pad, ridden on a platform, teleported. */
export const EDGE = { walk: 0, leap: 1, pad: 2, ride: 3, tele: 4 } as const;

/** A point on a path, and how it is reached from the one before. */
export interface NavPoint extends Vec3 { kind: number }

export const NAV = {
  cell: 1, // m between columns
  climb: 1.0, // m: the highest ledge it plans to hop up onto (a jump clears about 1.25)
  padSpeed: 9, // m/s of sideways speed it assumes off a jump pad (air control does the rest)
  leapSpeed: 6.5, // m/s it counts on carrying into a running jump (a little under a run, to be safe)
  leapCells: 6, // the furthest (in cells) it looks across a gap for somewhere to land
  maxNodes: 40000, // a sanity limit for enormous maps
};

/** The box swept for clearance: a player's width, a little over waist height. */
const PROBE_MIN = v3(-PLAYER.radius, 0, -PLAYER.radius);
const PROBE_MAX = v3(PLAYER.radius, 1.2, PLAYER.radius);
const ZERO = v3();
const BUCKET = 4; // m: brushes are filed in buckets this size, so a trace only looks at what is near it

interface NavNode {
  x: number;
  y: number;
  z: number;
  to: number[]; // node ids reachable from here
  cost: number[]; // what each costs (about the metres walked)
  kind: number[]; // how each is travelled (EDGE)
}

export class NavGrid {
  nodes: NavNode[] = [];
  private cols = new Map<number, number[]>(); // column key -> node ids, lowest first
  private world: World;
  private buckets = new Map<number, Brush[]>();
  private stamp = new Map<Brush, number>();
  private traces = 0;
  private x0 = 0;
  private z0 = 0;

  constructor(map: MapDef) {
    // Only what stays put: movers are left out of the plan.
    this.world = new World(map.solids.filter((s) => !s.mover), []);
    for (const b of this.world.brushes) {
      for (let bx = Math.floor(b.min.x / BUCKET); bx <= Math.floor(b.max.x / BUCKET); bx++) {
        for (let bz = Math.floor(b.min.z / BUCKET); bz <= Math.floor(b.max.z / BUCKET); bz++) {
          const k = key(bx, bz);
          const list = this.buckets.get(k);
          if (list) list.push(b); else this.buckets.set(k, [b]);
        }
      }
    }
    this.build(map);
  }

  // ------------------------------------------------------------ building
  private build(map: MapDef): void {
    const solids = map.solids.filter((s) => !s.mover);
    if (!solids.length) return;
    const half = (map.extent ?? 40) + 4;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity, bottom = Infinity;
    for (const s of solids) {
      x0 = Math.min(x0, s.min.x); x1 = Math.max(x1, s.max.x);
      z0 = Math.min(z0, s.min.z); z1 = Math.max(z1, s.max.z);
      top = Math.max(top, s.max.y); bottom = Math.min(bottom, s.min.y);
    }
    x0 = Math.max(x0, -half); x1 = Math.min(x1, half); z0 = Math.max(z0, -half); z1 = Math.min(z1, half);
    this.x0 = x0; this.z0 = z0;
    const c = NAV.cell;
    const nx = Math.ceil((x1 - x0) / c), nz = Math.ceil((z1 - z0) / c);
    const floorY = Math.max(bottom - 1, map.killY);

    // Nodes: every surface in every column that a player can stand on.
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = x0 + (ix + 0.5) * c, z = z0 + (iz + 0.5) * c;
        let y = top + 1;
        const ids: number[] = [];
        for (let guard = 0; guard < 16 && y > floorY; guard++) {
          const tr = this.trace(v3(x, y, z), v3(x, floorY, z), ZERO, ZERO); // a ray
          if (tr.startSolid) { if (!tr.brush) break; y = tr.brush.min.y - 0.01; continue; }
          if (tr.fraction >= 1 || !tr.brush) break;
          const hy = tr.end.y;
          if (tr.normal.y >= MOVE.minGroundNormalY && tr.surface !== 'deadly' && hy > map.killY + 1
            && !this.trace(v3(x, hy + 0.3, z), v3(x, hy + 0.3, z), HULL.mins, HULL.stand).startSolid // (lifted a little: on a ramp the body's uphill edge is above the middle)
            && !(this.world.deadly.length && this.world.touchesDeadly(v3(x, hy, z), HULL.mins, HULL.stand, BOTS.hazardMargin))
            && this.nodes.length < NAV.maxNodes) {
            ids.unshift(this.nodes.length);
            this.nodes.push({ x, y: hy, z, to: [], cost: [], kind: [] });
          }
          y = tr.brush.min.y - 0.01;
        }
        if (ids.length) this.cols.set(key(ix, iz), ids);
      }
    }

    // Elevators and moving platforms: their top, at either end of the run (doors only open, so they are no floor).
    const rides: [number, number][] = [];
    for (const m of map.solids) {
      const mv = m.mover;
      if (!mv || (mv.dy < 0 && !mv.dx && !mv.dz)) continue;
      for (let ix = Math.floor((m.min.x - x0) / c); ix <= Math.floor((m.max.x - x0) / c); ix++) {
        for (let iz = Math.floor((m.min.z - z0) / c); iz <= Math.floor((m.max.z - z0) / c); iz++) {
          const x = x0 + (ix + 0.5) * c, z = z0 + (iz + 0.5) * c;
          if (x < m.min.x + 0.2 || x > m.max.x - 0.2 || z < m.min.z + 0.2 || z > m.max.z - 0.2) continue;
          const a = this.addNode(ix, iz, x, m.max.y, z);
          const b = this.addNode(ix + Math.round(mv.dx / c), iz + Math.round(mv.dz / c), x + mv.dx, m.max.y + mv.dy, z + mv.dz);
          rides.push([a, b]);
        }
      }
    }

    // Edges: walking, stepping, hopping up and dropping down between neighbouring columns.
    for (const [k, ids] of this.cols) {
      const ix = Math.floor(k / 4096) - 2048, iz = (k % 4096) - 2048;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const other = this.cols.get(key(ix + dx, iz + dz));
          if (!other) continue;
          for (const a of ids) for (const b of other) this.join(a, b);
        }
      }
    }

    for (const [a, b] of rides) {
      const wait = 4; // about a ride and a wait
      this.link(a, b, wait, EDGE.ride);
      this.link(b, a, wait, EDGE.ride);
    }

    // Running jumps: from a ledge, across a gap, to the first ground in reach on the far side.
    this.leaps();

    // Jump pads: from the pad to anywhere it can throw you onto (it throws you up; which way is up to you).
    for (const t of map.triggers) {
      if (t.type !== 'jumppad') continue;
      const vy = Math.max(MOVE.padBounce, t.vel.y);
      const rise = (vy * vy) / (2 * MOVE.gravity);
      const on = this.inside(t.min, t.max);
      for (const a of on) {
        const pa = this.nodes[a];
        const apex = v3(pa.x, pa.y + rise * 0.9, pa.z);
        if (this.trace(v3(pa.x, pa.y + 0.1, pa.z), apex, PROBE_MIN, PROBE_MAX).fraction < 1) continue; // something overhead
        for (let b = 0; b < this.nodes.length; b++) {
          const pb = this.nodes[b], dy = pb.y - pa.y;
          if (dy < -BOTS.maxDrop || dy > rise - 0.3) continue;
          // Time to come down onto it after the bounce, and how far it can drift meanwhile.
          const fall = (vy + Math.sqrt(vy * vy - 2 * MOVE.gravity * dy)) / MOVE.gravity;
          const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
          if (d > NAV.padSpeed * fall || d < (dy < NAV.climb ? 2.5 : 0.5)) continue; // (to somewhere it could walk to anyway, no need)
          if (this.trace(apex, v3(pb.x, pb.y + 0.5, pb.z), PROBE_MIN, PROBE_MAX).fraction < 1) continue;
          this.link(a, b, d + 4, EDGE.pad);
        }
      }
    }

    // Teleporters: from the pad to where it sends you.
    for (const t of map.triggers) {
      if (t.type !== 'teleporter') continue;
      const dest = this.nodeAt(t.dest);
      if (dest < 0) continue;
      for (const a of this.inside(t.min, t.max)) this.link(a, dest, 2, EDGE.tele);
    }
  }

  /** A node that is not found by looking down a column (the top of a moving platform), filed in its column by height. */
  private addNode(ix: number, iz: number, x: number, y: number, z: number): number {
    const id = this.nodes.length;
    this.nodes.push({ x, y, z, to: [], cost: [], kind: [] });
    const k = key(ix, iz);
    const ids = this.cols.get(k) ?? [];
    ids.push(id);
    ids.sort((p, q) => this.nodes[p].y - this.nodes[q].y);
    this.cols.set(k, ids);
    return id;
  }

  /** Join a to b if a player can get from one to the other: walk, step, hop up, or drop. */
  private join(a: number, b: number): void {
    const pa = this.nodes[a], pb = this.nodes[b];
    const dy = pb.y - pa.y;
    if (dy > NAV.climb || dy < -BOTS.maxDrop) return;
    const hi = Math.max(pa.y, pb.y) + 0.5; // high enough to clear the lip of a step or ledge
    // Up from where it stands, across, and (for a drop) down onto the other.
    if (hi > pa.y + 0.55 && !this.clear(v3(pa.x, pa.y + 0.3, pa.z), v3(pa.x, hi, pa.z))) return; // (from a little up: a ramp rises under the body's edge)
    if (!this.clear(v3(pa.x, hi, pa.z), v3(pb.x, hi, pb.z))) return;
    if (hi > pb.y + 0.55 && !this.clear(v3(pb.x, hi, pb.z), v3(pb.x, pb.y + 0.3, pb.z))) return;
    this.link(a, b, Math.hypot(pb.x - pa.x, pb.z - pa.z) + (dy > MOVE.stepHeight ? 1.5 : 0) + Math.max(0, -dy) * 0.1, EDGE.walk);
  }

  private link(a: number, b: number, cost: number, kind: number): void {
    const n = this.nodes[a];
    n.to.push(b); n.cost.push(cost); n.kind.push(kind);
  }

  /**
   * Running jumps. From each node, in each of the eight directions where it
   * cannot simply walk on (a ledge), look across for the first column with
   * ground it could land on: no higher than half a metre up, no further than
   * a running jump carries (further when it lands lower), clear overhead.
   */
  private leaps(): void {
    const c = NAV.cell, g = MOVE.gravity, v0 = MOVE.jumpSpeed;
    const walked = new Set<number>();
    this.nodes.forEach((pa, a) => {
      walked.clear();
      for (let k = 0; k < pa.to.length; k++) if (pa.kind[k] === EDGE.walk) walked.add(pa.to[k]);
      const ix = Math.floor((pa.x - this.x0) / c), iz = Math.floor((pa.z - this.z0) / c);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          // Not a ledge this way if it can walk to the next column at about its own height.
          const next = this.cols.get(key(ix + dx, iz + dz)) ?? [];
          if (next.some((b) => walked.has(b) && Math.abs(this.nodes[b].y - pa.y) < 1.5)) continue;
          for (let step = 2; step <= NAV.leapCells; step++) {
            const ids = this.cols.get(key(ix + dx * step, iz + dz * step));
            if (!ids) continue;
            let found = false;
            for (const b of ids) {
              const pb = this.nodes[b], dy = pb.y - pa.y;
              if (dy > 0.5 || dy < -BOTS.maxDrop) continue;
              const air = (v0 + Math.sqrt(v0 * v0 - 2 * g * dy)) / g; // up and back down to its height
              const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
              if (d > NAV.leapSpeed * air) continue;
              const top = v3((pa.x + pb.x) / 2, Math.max(pa.y, pb.y) + 1.2, (pa.z + pb.z) / 2);
              if (!this.clear(v3(pa.x, pa.y + 0.5, pa.z), top) || !this.clear(top, v3(pb.x, pb.y + 0.5, pb.z))) continue;
              this.link(a, b, d + 3, EDGE.leap);
              found = true;
            }
            if (found) break;
          }
        }
      }
    });
  }

  private clear(from: Vec3, to: Vec3): boolean {
    const tr = this.trace(from, to, PROBE_MIN, PROBE_MAX);
    return !tr.startSolid && tr.fraction >= 1;
  }

  /** Nodes standing within a trigger volume (a pad or teleporter). */
  private inside(min: Vec3, max: Vec3): number[] {
    const out: number[] = [];
    this.nodes.forEach((n, i) => {
      if (n.x >= min.x - 0.2 && n.x <= max.x + 0.2 && n.z >= min.z - 0.2 && n.z <= max.z + 0.2 && n.y >= min.y - 0.6 && n.y <= max.y + 0.2) out.push(i);
    });
    return out;
  }

  /** World.traceBox, but only against the brushes filed near the sweep. */
  private trace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3): Trace {
    const id = ++this.traces;
    let best: Trace | null = null;
    const bx0 = Math.floor((Math.min(start.x, end.x) + mins.x - 0.01) / BUCKET), bx1 = Math.floor((Math.max(start.x, end.x) + maxs.x + 0.01) / BUCKET);
    const bz0 = Math.floor((Math.min(start.z, end.z) + mins.z - 0.01) / BUCKET), bz1 = Math.floor((Math.max(start.z, end.z) + maxs.z + 0.01) / BUCKET);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        for (const b of this.buckets.get(key(bx, bz)) ?? []) {
          if (this.stamp.get(b) === id) continue;
          this.stamp.set(b, id);
          const tr = this.world.traceBrush(b, start, end, mins, maxs);
          if (tr.startSolid) return tr;
          if (tr.fraction < 1 && (!best || tr.fraction < best.fraction)) best = tr;
        }
      }
    }
    return best ?? { fraction: 1, end: vcopy(end), normal: v3(), startSolid: false, allSolid: false, surface: 'normal', brush: null };
  }

  // ------------------------------------------------------------ queries
  /**
   * The node someone at `pos` is standing on (or just above): in their column,
   * the highest surface not above their feet; failing that, the nearest such in
   * the columns around. -1 if there is none.
   */
  nodeAt(pos: Vec3): number {
    const c = NAV.cell;
    const ix = Math.floor((pos.x - this.x0) / c), iz = Math.floor((pos.z - this.z0) / c);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const id of this.cols.get(key(ix + dx, iz + dz)) ?? []) {
            const n = this.nodes[id];
            const below = pos.y + 0.6 - n.y;
            if (below < 0 || below > BOTS.maxDrop + 2) continue;
            const d = Math.hypot(n.x - pos.x, n.z - pos.z) + below * 0.5;
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
    }
    return best;
  }

  /** The way from one place to another, as the points to go through (not including where it starts). Null: no way there. */
  path(from: Vec3, to: Vec3): NavPoint[] | null {
    const s = this.nodeAt(from), g = this.nodeAt(to);
    if (s < 0 || g < 0) return null;
    if (s === g) return [];
    const n = this.nodes.length;
    const cost = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const how = new Uint8Array(n);
    const done = new Uint8Array(n);
    const goal = this.nodes[g];
    const h = (i: number) => Math.hypot(this.nodes[i].x - goal.x, this.nodes[i].z - goal.z) * 0.9;
    const heap = new Heap();
    cost[s] = 0;
    heap.push(s, h(s));
    while (heap.size) {
      const a = heap.pop();
      if (a === g) break;
      if (done[a]) continue;
      done[a] = 1;
      const na = this.nodes[a];
      for (let k = 0; k < na.to.length; k++) {
        const b = na.to[k], c = cost[a] + na.cost[k];
        if (c < cost[b]) { cost[b] = c; prev[b] = a; how[b] = na.kind[k]; heap.push(b, c + h(b)); }
      }
    }
    if (prev[g] < 0) return null;
    const out: NavPoint[] = [];
    for (let i = g; i !== s; i = prev[i]) out.push({ x: this.nodes[i].x, y: this.nodes[i].y, z: this.nodes[i].z, kind: how[i] });
    return out.reverse();
  }

  /** Can someone walk straight from `a` to `b` (same level, nothing in the way)? Used to cut corners off a path. */
  straight(a: Vec3, b: Vec3): boolean {
    if (Math.abs(a.y - b.y) > MOVE.stepHeight) return false;
    const y = Math.max(a.y, b.y) + MOVE.stepHeight + 0.05;
    return this.clear(v3(a.x, y, a.z), v3(b.x, y, b.z));
  }
}

const key = (ix: number, iz: number) => (ix + 2048) * 4096 + (iz + 2048);

/** A min-heap of node ids by priority, for A*. */
class Heap {
  private ids: number[] = [];
  private pr: number[] = [];
  get size(): number { return this.ids.length; }
  push(id: number, p: number): void {
    const ids = this.ids, pr = this.pr;
    let i = ids.length;
    ids.push(id); pr.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (pr[up] <= p) break;
      ids[i] = ids[up]; pr[i] = pr[up];
      i = up;
    }
    ids[i] = id; pr[i] = p;
  }
  pop(): number {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const id = ids.pop()!, p = pr.pop()!;
    const n = ids.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= p) break;
        ids[i] = ids[c]; pr[i] = pr[c];
        i = c;
      }
      ids[i] = id; pr[i] = p;
    }
    return top;
  }
}

const grids = new WeakMap<MapDef, NavGrid>();

/** The navigation grid for a map: built the first time it is asked for, then kept as long as the map is. */
export function navFor(map: MapDef): NavGrid {
  let g = grids.get(map);
  if (!g) { g = new NavGrid(map); grids.set(map, g); }
  return g;
}
