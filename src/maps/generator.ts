import { BROOM, PLAYER } from '../config/game';
import { MOVE } from '../config/movement';
import { LEGENDARIES, LEGENDARY_CHANCE, TIER_WEIGHT, WEAPON_TIERS, type WeaponId } from '../config/weapons';
import { Rng } from '../core/rng';
import { v3, type Vec3 } from '../core/vec';
import type { MapDef, MatId, RampDir, Solid, Surface, Trigger } from '../sim/map';
import { World } from '../sim/world';
import { THEMES } from './themes';

// Seeded procedural map generator.
//
// The map is designed on a square grid of 3 m cells (a height field with a
// few extras), then turned into brushes and triggers. The grid is 8 to 16
// cells a side (24 to 48 m): the host picks the size for each map from how
// many players are in the room (pickMapSize), and sends it with the seed. Working on a grid is
// what makes validation tractable: "can a player get from A to B" becomes a
// graph search over cells instead of a physics question.
//
//   1. an ARCHETYPE lays out the terrain (arena / terraces / rooms / islands)
//   2. connectors join every height change (ramps, stairs, jump pads, elevators,
//      bridges, moving platforms, teleporters)
//   3. decoration adds cover, pillars, pits, lava, ice, conveyors, low gravity, darkness
//   4. the walkability graph is built; spawns and weapons are placed on it
//   5. validation: everything reachable both ways, spawns far apart, nothing
//      inside geometry, every jump-pad arc actually clear
//   6. if anything fails, the whole thing is retried with a derived seed
//
// RULE: only the seeded Rng. Never Math.random, never iteration over
// unordered collections — every peer must build the identical map.

/**
 * Map sizes, in cells per side (3 m each), smallest first, with what each is
 * called and how many spawn points it has (so no more players than that can
 * play on it).
 */
export const MAP_SIZES = [
  { cells: 8, name: 'TINY', spawns: 4 }, // 24 m: a single brawl, everyone in sight
  { cells: 10, name: 'SMALL', spawns: 4 }, // 30 m
  { cells: 12, name: 'MEDIUM', spawns: 5 }, // 36 m
  { cells: 14, name: 'LARGE', spawns: 6 }, // 42 m
  { cells: 16, name: 'HUGE', spawns: 6 }, // 48 m: the old standard
] as const;

/**
 * How likely each size (MAP_SIZES order) is, by how many players there are.
 * Small rooms mostly get small, frantic maps (with the odd big one); a full
 * room gets room to breathe. Sizes with too few spawns are never picked.
 */
const SIZE_WEIGHTS: { upTo: number; w: number[] }[] = [
  { upTo: 2, w: [30, 30, 22, 12, 6] },
  { upTo: 3, w: [20, 30, 25, 15, 10] },
  { upTo: 4, w: [10, 25, 30, 20, 15] },
  { upTo: 99, w: [0, 0, 25, 35, 40] },
];

/** The grid size (cells per side) for a map, from its seed and the number of players. Deterministic. */
export function pickMapSize(seed: number, players: number): number {
  const rng = new Rng((seed ^ 0x6d2b79f5) >>> 0);
  const row = SIZE_WEIGHTS.find((r) => players <= r.upTo)!.w;
  const ok = MAP_SIZES.map((m, k) => (m.spawns >= players ? row[k] : 0));
  const total = ok.reduce((a, b) => a + b, 0);
  if (total <= 0) return MAP_SIZES[MAP_SIZES.length - 1].cells;
  let r = rng.next() * total;
  for (let k = 0; k < ok.length; k++) { if ((r -= ok[k]) < 0) return MAP_SIZES[k].cells; }
  return MAP_SIZES[MAP_SIZES.length - 1].cells;
}

// The size of the map being generated. Set at the start of each attempt; the
// generator is synchronous, so module state is safe here.
let N = 16; // cells per side
const CS = 3; // cell size (m)
const LV = 1.5; // height of one level (m): too tall to jump, so levels need connectors
let HALF = (N * CS) / 2;
/** How big this map is next to the biggest (1 = 16x16): counts of things scale with it. */
const AREA = () => (N * N) / 256;
const sizeInfo = () => MAP_SIZES.find((m) => m.cells === N) ?? MAP_SIZES[MAP_SIZES.length - 1];
const DI = [1, 0, -1, 0];
const DJ = [0, 1, 0, -1];
const RAMP_HIGH: RampDir[] = ['+x', '+z', '-x', '-z'];
/** Height difference a player can get up without help (jump is ~1.25 m; keep a margin). */
const CLIMB = 0.8;

type Kind = 'floor' | 'void' | 'block' | 'ramp' | 'shaft';

interface Cell {
  kind: Kind;
  h: number; // floor height; ramps: the LOW end; blocks: the top
  dir: number; // ramps: direction index towards the high side. conveyors: push direction
  stairs: boolean; // draw the ramp as steps
  surface: Surface;
  mat: MatId;
  thin: boolean; // floating slab instead of solid ground
  under: number; // floor height underneath a floating slab, NaN if none
  used: boolean; // reserved: nothing else (cover, spawn, weapon) may be placed here
  dark: boolean; // inside a dark patch (only matters for splitting floor boxes so shading has clean edges)
  prize: boolean; // top of a landmark: a power weapon goes here
  region: number;
}

interface Rect { i0: number; j0: number; i1: number; j1: number } // i1/j1 exclusive

const idx = (i: number, j: number) => j * N + i;
const inb = (i: number, j: number) => i >= 0 && j >= 0 && i < N && j < N;
const cx = (i: number) => (i - N / 2 + 0.5) * CS;
const x0 = (i: number) => (i - N / 2) * CS;

class Gen {
  rng: Rng;
  cells: Cell[] = [];
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  /** extra directed walkability edges created by mechanics (cell index pairs) */
  links: [number, number][] = [];
  pads: { from: Vec3; to: Vec3; vel: Vec3 }[] = [];
  destinations: Vec3[] = []; // teleporter exits, checked for clearance
  walled = true;
  archetype = '';
  structures: string[] = []; // landmarks placed on this map
  floorMats: MatId[] = ['concrete', 'tile', 'concrete', 'metal'];
  private pairs = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    for (let n = 0; n < N * N; n++) {
      this.cells.push({
        kind: 'floor', h: 0, dir: 0, stairs: false, surface: 'normal', mat: 'concrete',
        thin: false, under: NaN, used: false, dark: false, prize: false, region: 0,
      });
    }
  }

  at(i: number, j: number): Cell { return this.cells[idx(i, j)]; }
  center(i: number, j: number): Vec3 { return v3(cx(i), this.at(i, j).h, cx(j)); }

  each(r: Rect, fn: (c: Cell, i: number, j: number) => void): void {
    for (let j = r.j0; j < r.j1; j++) for (let i = r.i0; i < r.i1; i++) fn(this.at(i, j), i, j);
  }

  /** Plain, unreserved floor: the only place decoration, spawns and weapons may go. */
  free(i: number, j: number): boolean {
    if (!inb(i, j)) return false;
    const c = this.at(i, j);
    return c.kind === 'floor' && !c.used && c.surface === 'normal' && Number.isNaN(c.under);
  }

  /**
   * True if rect (w x d cells at i,j) plus a one-cell ring around it is free,
   * flat and inside the grid. Anything placed in such a spot can always be
   * walked around, so it can never cut the map in two.
   */
  clearing(i: number, j: number, w: number, d: number): boolean {
    if (!inb(i - 1, j - 1) || !inb(i + w, j + d)) return false;
    const h = this.at(i, j).h;
    for (let b = j - 1; b <= j + d; b++) {
      for (let a = i - 1; a <= i + w; a++) if (!this.free(a, b) || this.at(a, b).h !== h) return false;
    }
    return true;
  }

  reserve(i: number, j: number, w = 1, d = 1, ring = 1): void {
    for (let b = j - ring; b < j + d + ring; b++) {
      for (let a = i - ring; a < i + w + ring; a++) if (inb(a, b)) this.at(a, b).used = true;
    }
  }

  /** Try random spots for a clearing; returns the first hit. */
  findClearing(w: number, d: number, tries = 40): [number, number] | null {
    for (let t = 0; t < tries; t++) {
      const i = this.rng.int(1, N - w - 1), j = this.rng.int(1, N - d - 1);
      if (this.clearing(i, j, w, d)) return [i, j];
    }
    return null;
  }

  // ------------------------------------------------------------ mechanics
  ramp(i: number, j: number, dir: number, lowH: number): void {
    const c = this.at(i, j);
    c.kind = 'ramp'; c.h = lowH; c.dir = dir; c.used = true;
    c.stairs = this.rng.next() < 0.4;
    c.surface = 'normal'; c.mat = c.stairs ? 'concreteDark' : 'metal';
  }

  /** Jump pad on cell A that throws you onto cell B. */
  pad(ai: number, aj: number, bi: number, bj: number): void {
    const a = this.center(ai, aj), b = this.center(bi, bj);
    const dy = b.y - a.y;
    const apex = Math.max(dy, 0) + 1.9; // how far above the start the arc peaks
    const g = MOVE.gravity;
    const vy = Math.sqrt(2 * g * apex);
    const t = (vy + Math.sqrt(Math.max(0, vy * vy - 2 * g * dy))) / g;
    const vel = v3((b.x - a.x) / t, vy, (b.z - a.z) / t);
    this.triggers.push({ type: 'jumppad', min: v3(a.x - 0.9, a.y, a.z - 0.9), max: v3(a.x + 0.9, a.y + 0.5, a.z + 0.9), vel });
    this.pads.push({ from: a, to: b, vel });
    this.links.push([idx(ai, aj), idx(bi, bj)]);
    this.at(ai, aj).used = true;
    this.at(bi, bj).used = true;
  }

  /** Two-way teleporter between two cells. */
  teleport(ai: number, aj: number, bi: number, bj: number): void {
    const a = this.center(ai, aj), b = this.center(bi, bj);
    const pair = this.pairs++;
    const add = (p: Vec3, q: Vec3) => this.triggers.push({
      type: 'teleporter', min: v3(p.x - 0.7, p.y, p.z - 0.7), max: v3(p.x + 0.7, p.y + 2, p.z + 0.7),
      dest: v3(q.x, q.y + 0.05, q.z), pair,
    });
    add(a, b); add(b, a);
    this.destinations.push(a, b);
    this.links.push([idx(ai, aj), idx(bi, bj)], [idx(bi, bj), idx(ai, aj)]);
    this.reserve(ai, aj, 1, 1, 0);
    this.reserve(bi, bj, 1, 1, 0);
  }

  /** Elevator in cell (i,j) travelling between two floor heights. */
  elevator(i: number, j: number, lowH: number, highH: number): void {
    const c = this.at(i, j);
    c.kind = 'shaft'; c.h = lowH; c.used = true;
    const dy = highH - lowH - 0.3;
    this.solids.push({
      type: 'box', mat: 'hazard',
      min: v3(x0(i) + 0.15, lowH, x0(j) + 0.15), max: v3(x0(i) + CS - 0.15, lowH + 0.3, x0(j) + CS - 0.15),
      mover: { dx: 0, dy, dz: 0, moveTime: dy / 2.2, waitA: 2, waitB: 2, phase: this.rng.range(0, 6) },
    });
    // Everything level with the bottom stop is linked to everything level with the top stop.
    const low: number[] = [], high: number[] = [];
    for (let d = 0; d < 4; d++) {
      const a = i + DI[d], b = j + DJ[d];
      if (!inb(a, b)) continue;
      const n = this.at(a, b);
      if (n.kind !== 'floor') continue;
      if (Math.abs(n.h - lowH) <= 0.45) low.push(idx(a, b));
      else if (Math.abs(n.h - highH) <= 0.45) high.push(idx(a, b));
      n.used = true;
    }
    for (const a of low) for (const b of high) this.links.push([a, b], [b, a]);
  }

  /** Slab that ferries players across void between cell A and cell B (same row or column, same height). */
  platform(ai: number, aj: number, bi: number, bj: number): void {
    const di = Math.sign(bi - ai), dj = Math.sign(bj - aj);
    const gap = Math.abs(bi - ai) + Math.abs(bj - aj) - 1;
    const h = this.at(ai, aj).h;
    const si = ai + di, sj = aj + dj; // first void cell
    const dist = (gap - 1) * CS;
    this.solids.push({
      type: 'box', mat: 'hazard',
      min: v3(x0(si) + 0.1, h - 0.4, x0(sj) + 0.1), max: v3(x0(si) + CS - 0.1, h, x0(sj) + CS - 0.1),
      mover: { dx: di * dist, dy: 0, dz: dj * dist, moveTime: Math.max(0.6, dist / 2.4), waitA: 1.6, waitB: 1.6, phase: this.rng.range(0, 6) },
    });
    this.links.push([idx(ai, aj), idx(bi, bj)], [idx(bi, bj), idx(ai, aj)]);
    this.at(ai, aj).used = this.at(bi, bj).used = true;
  }

  /** Timed door in a doorway cell. `alongX`: the wall it sits in runs along X. */
  door(i: number, j: number, alongX: boolean, height: number): void {
    const c = this.at(i, j);
    c.used = true;
    const mid = (alongX ? x0(j) : x0(i)) + CS / 2;
    const min = alongX ? v3(x0(i), c.h, mid - 0.25) : v3(mid - 0.25, c.h, x0(j));
    const max = alongX ? v3(x0(i) + CS, c.h + height, mid + 0.25) : v3(mid + 0.25, c.h + height, x0(j) + CS);
    // Closed (up) for a moment, then sinks into the floor and stays open for longer.
    this.solids.push({
      type: 'box', mat: 'hazard', min, max,
      mover: { dx: 0, dy: -(height + 0.06), dz: 0, moveTime: 0.9, waitA: 2.2, waitB: 5.5, phase: this.rng.range(0, 9) },
    });
  }

  zoneBox(r: Rect, h: number, top: number): { min: Vec3; max: Vec3 } {
    return { min: v3(x0(r.i0), h - 0.5, x0(r.j0)), max: v3(x0(r.i1), h + top, x0(r.j1)) };
  }
}

// ------------------------------------------------------------- BSP helper
interface Split { alongX: boolean; k: number; from: number; to: number }

/** Recursively cut `r` into rectangles at least `min` cells wide. `gap` cells are left between halves (walls). */
function bsp(rng: Rng, r: Rect, min: number, gap: number, depth: number, out: Rect[], splits: Split[]): void {
  const w = r.i1 - r.i0, d = r.j1 - r.j0;
  const canX = w >= 2 * min + gap, canZ = d >= 2 * min + gap;
  if (depth <= 0 || (!canX && !canZ) || (depth < 3 && rng.next() < 0.15)) { out.push(r); return; }
  const cutX = canX && (!canZ || (w === d ? rng.next() < 0.5 : w > d));
  if (cutX) {
    const k = rng.int(r.i0 + min, r.i1 - min - gap);
    if (gap) splits.push({ alongX: false, k, from: r.j0, to: r.j1 });
    bsp(rng, { ...r, i1: k }, min, gap, depth - 1, out, splits);
    bsp(rng, { ...r, i0: k + gap }, min, gap, depth - 1, out, splits);
  } else {
    const k = rng.int(r.j0 + min, r.j1 - min - gap);
    if (gap) splits.push({ alongX: true, k, from: r.i0, to: r.i1 });
    bsp(rng, { ...r, j1: k }, min, gap, depth - 1, out, splits);
    bsp(rng, { ...r, j0: k + gap }, min, gap, depth - 1, out, splits);
  }
}

const full = (): Rect => ({ i0: 0, j0: 0, i1: N, j1: N });

// -------------------------------------------------------------- archetypes
/** One open floor with a raised plaza in the middle. */
function arena(g: Gen): void {
  if (g.rng.next() < 0.45) return; // open floor: the landmarks become the centrepiece
  const s = g.rng.pick([4, 4, 6]);
  const lo = N / 2 - s / 2, hi = lo + s;
  const plaza: Rect = { i0: lo, j0: lo, i1: hi, j1: hi };
  g.each(plaza, (c) => { c.h = LV; c.mat = 'tile'; c.region = 1; });
  // Ramps up to the plaza on 2-4 sides (always at least two opposite ones).
  const sides = [0, 2, ...(g.rng.next() < 0.6 ? [1] : []), ...(g.rng.next() < 0.6 ? [3] : [])];
  for (const d of sides) {
    const m = lo + g.rng.int(1, s - 2);
    // cell just outside the plaza on side d, sloping up towards it
    const i = d === 0 ? lo - 1 : d === 2 ? hi : m;
    const j = d === 1 ? lo - 1 : d === 3 ? hi : m;
    g.ramp(i, j, d, 0);
    g.reserve(i - DI[d], j - DJ[d], 1, 1, 0); // keep the approach clear
    g.reserve(i + DI[d], j + DJ[d], 1, 1, 0);
  }
  if (g.rng.next() < 0.5) { // a monument on the plaza
    const c = g.at(N / 2, N / 2);
    c.kind = 'block'; c.h = LV + g.rng.range(4, 8); c.mat = 'concreteDark';
    g.reserve(N / 2, N / 2);
  }
}

/** The floor is cut into terraces at different heights, joined by ramps, stairs, jump pads and elevators. */
function terraces(g: Gen): void {
  const rects: Rect[] = [];
  bsp(g.rng, full(), 4, 0, 4, rects, []);
  const level = rects.map(() => g.rng.int(0, 3));
  rects.forEach((r, n) => g.each(r, (c) => { c.h = level[n] * LV; c.region = n; c.mat = g.floorMats[level[n]]; }));

  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      if (level[a] === level[b]) continue;
      const lowN = level[a] < level[b] ? a : b, highN = lowN === a ? b : a;
      const lo = rects[lowN];
      // boundary cells of the low terrace that touch the high one, with the direction across
      const edge: [number, number, number][] = [];
      g.each(lo, (_c, i, j) => {
        for (let d = 0; d < 4; d++) {
          const ni = i + DI[d], nj = j + DJ[d];
          if (inb(ni, nj) && g.at(ni, nj).region === highN) edge.push([i, j, d]);
        }
      });
      if (edge.length < 2) continue;
      const diff = level[highN] - level[lowN];
      // try a few boundary spots until one has room
      for (let t = 0; t < 12; t++) {
        const [i, j, d] = g.rng.pick(edge);
        const bi = i - DI[d], bj = j - DJ[d]; // cell behind, deeper inside the low terrace
        const hi2 = i + DI[d], hj2 = j + DJ[d];
        if (!g.free(i, j) || !g.free(bi, bj) || !g.free(hi2, hj2) || g.at(bi, bj).region !== lowN) continue;
        if (diff === 1) {
          g.ramp(i, j, d, level[lowN] * LV);
          g.at(bi, bj).used = g.at(hi2, hj2).used = true;
        } else if (g.rng.next() < 0.45) {
          g.elevator(i, j, level[lowN] * LV, level[highN] * LV);
        } else {
          g.pad(bi, bj, hi2, hj2); // up by pad, down by simply walking off the edge
          g.at(i, j).used = true;
        }
        break;
      }
    }
  }
}

/** Walled rooms joined by doorways, some with timed doors. */
function rooms(g: Gen): void {
  const rects: Rect[] = [];
  const splits: Split[] = [];
  bsp(g.rng, full(), 4, 1, 3, rects, splits);
  const wallH = g.rng.range(3, 4.2);
  for (const s of splits) {
    for (let t = s.from; t < s.to; t++) {
      const c = s.alongX ? g.at(t, s.k) : g.at(s.k, t);
      c.kind = 'block'; c.h = wallH; c.mat = 'concreteDark'; c.used = true;
    }
  }
  rects.forEach((r, n) => g.each(r, (c) => { c.region = n; c.mat = g.floorMats[n % g.floorMats.length]; }));
  // Doorways are cut after all walls exist, so a later wall can never seal one.
  for (const s of splits) {
    const spots: number[] = [];
    for (let t = s.from; t < s.to; t++) {
      const [ai, aj, bi, bj] = s.alongX ? [t, s.k - 1, t, s.k + 1] : [s.k - 1, t, s.k + 1, t];
      if (g.free(ai, aj) && g.free(bi, bj)) spots.push(t);
    }
    const count = spots.length > 5 && g.rng.next() < 0.6 ? 2 : 1;
    for (let n = 0; n < count && spots.length; n++) {
      const t = spots.splice(g.rng.int(0, spots.length - 1), 1)[0];
      const [i, j] = s.alongX ? [t, s.k] : [s.k, t];
      const c = g.at(i, j);
      c.kind = 'floor'; c.h = 0; c.mat = 'metal';
      if (g.rng.next() < 0.4) g.door(i, j, s.alongX, wallH);
      // keep both sides of the doorway clear
      g.reserve(s.alongX ? i : i - 1, s.alongX ? j - 1 : j, s.alongX ? 1 : 3, s.alongX ? 3 : 1, 0);
    }
  }
  // Room moods.
  for (const r of rects) {
    const roll = g.rng.next();
    if (roll < 0.22) g.triggers.push({ type: 'dark', ...g.zoneBox(r, 0, 7) });
    else if (roll < 0.36) g.each(r, (c) => { if (c.kind === 'floor' && !c.used) { c.surface = 'ice'; c.mat = 'ice'; } });
    else if (roll < 0.48) g.triggers.push({ type: 'lowgrav', ...g.zoneBox(r, 0, 9), scale: 0.35 });
  }
}

/** Floating islands over the void, joined by bridges, gaps, moving platforms, pads and teleporters. */
function islands(g: Gen): void {
  g.walled = false;
  for (const c of g.cells) c.kind = 'void';
  // S x S slots of P cells (3x3 of 5 on the biggest maps, 2x2 on smaller
  // ones). Each island always covers the two middle rows and columns of its
  // slot, so neighbours can always be joined in a straight line.
  const S = N >= 15 ? 3 : 2, P = Math.floor((N - 1) / S), SLOTS = S * S;
  const root = S === 3 ? 4 : g.rng.int(0, SLOTS - 1); // the middle island, or any one of four
  const present: boolean[] = [];
  const rects: Rect[] = [];
  const level: number[] = [];
  for (let s = 0; s < SLOTS; s++) {
    const a = s % S, b = Math.floor(s / S);
    const o = (q: number) => q * P + 1;
    present.push(s === root || g.rng.next() < 0.82);
    rects.push({
      i0: o(a) + g.rng.int(0, 1), j0: o(b) + g.rng.int(0, 1),
      i1: o(a) + 3 + g.rng.int(0, 1), j1: o(b) + 3 + g.rng.int(0, 1),
    });
    level.push(g.rng.int(0, 2));
  }
  // Keep only islands connected to the root through other islands.
  const joined = new Set([root]);
  const tree: [number, number][] = [];
  const frontier = [root];
  const neighbours = (s: number) => [s - S, s + S, s % S > 0 ? s - 1 : -1, s % S < S - 1 ? s + 1 : -1].filter((n) => n >= 0 && n < SLOTS);
  while (frontier.length) {
    const s = frontier.splice(g.rng.int(0, frontier.length - 1), 1)[0];
    for (const n of neighbours(s)) {
      if (!present[n]) continue;
      if (!joined.has(n)) { joined.add(n); frontier.push(n); tree.push([s, n]); }
      else if (n > s && g.rng.next() < 0.35 && !tree.some(([x, y]) => (x === s && y === n) || (x === n && y === s))) tree.push([s, n]);
    }
  }
  for (let s = 0; s < SLOTS; s++) {
    if (!joined.has(s)) continue;
    g.each(rects[s], (c) => { c.kind = 'floor'; c.h = level[s] * LV; c.thin = true; c.region = s; c.mat = g.floorMats[level[s]]; });
  }

  for (const [sa, sb] of tree) {
    // order so that A is left/above B
    const [a, b] = sa < sb ? [sa, sb] : [sb, sa];
    const horizontal = b === a + 1;
    const row = (horizontal ? Math.floor(a / S) : a % S) * P + 2 + g.rng.int(0, 1); // shared middle row/column
    // edge cells facing each other, and the void cells between them
    const from = horizontal ? rects[a].i1 - 1 : rects[a].j1 - 1;
    const to = horizontal ? rects[b].i0 : rects[b].j0;
    const cell = (t: number): [number, number] => (horizontal ? [t, row] : [row, t]);
    const [ai, aj] = cell(from), [bi, bj] = cell(to);
    const gap = to - from - 1;
    const la = level[a], lb = level[b];
    const dir = horizontal ? 0 : 1; // direction index from A towards B
    const bridge = (t: number, h: number) => {
      const c = g.at(...cell(t));
      c.kind = 'floor'; c.h = h; c.thin = true; c.used = true; c.mat = 'metal'; c.region = -1;
    };
    g.at(ai, aj).used = g.at(bi, bj).used = true;

    if (la === lb) {
      const roll = g.rng.next();
      if (gap >= 2 && roll < 0.45) g.platform(ai, aj, bi, bj);
      else if (gap === 1 && roll < 0.4) g.links.push([idx(ai, aj), idx(bi, bj)], [idx(bi, bj), idx(ai, aj)]); // just jump it
      else {
        for (let t = from + 1; t < to; t++) bridge(t, la * LV);
        if (gap >= 2 && roll > 0.8) { // conveyor bridge
          for (let t = from + 1; t < to; t++) { const c = g.at(...cell(t)); c.surface = 'conveyor'; c.mat = 'conveyor'; c.dir = dir; }
        }
      }
    } else if (Math.abs(la - lb) <= gap) {
      // enough room for one ramp per level; the rest is flat bridge at the low height
      const up = lb > la;
      const steps = Math.abs(la - lb);
      let h = Math.min(la, lb) * LV;
      const order: number[] = [];
      for (let t = from + 1; t < to; t++) order.push(t);
      if (!up) order.reverse(); // walk from the low island towards the high one
      order.forEach((t, n) => {
        if (n < gap - steps) bridge(t, h);
        else { g.ramp(...cell(t), up ? dir : dir + 2, h); g.at(...cell(t)).thin = true; h += LV; }
      });
    } else if (g.rng.next() < 0.5) {
      g.teleport(ai, aj, bi, bj);
    } else {
      // pad up; coming back down you just run off the edge (the gap is one cell)
      const up = lb > la;
      if (up) g.pad(ai, aj, bi, bj); else g.pad(bi, bj, ai, aj);
      g.links.push(up ? [idx(bi, bj), idx(ai, aj)] : [idx(ai, aj), idx(bi, bj)]);
    }
  }
}

const ARCHETYPES: [string, (g: Gen) => void][] = [
  ['ARENA', arena], ['TERRACES', terraces], ['ROOMS', rooms], ['ISLANDS', islands],
];

// -------------------------------------------------------------- structures
// Landmarks: hand-designed set pieces that the generator drops into any map
// with room for them. Each one is built out of ordinary cells (floors, ramps,
// blocks, slabs, pads), so reachability validation understands it for free.
// A structure is only placed in a flat clearing with a free ring around it,
// so it can never block the way past.

type Structure = (g: Gen) => boolean;

/** Find a flat clearing of w x d cells; returns its corner or null. */
function site(g: Gen, w: number, d: number): [number, number, number] | null {
  // Look at every position, then pick one at random: big footprints are rare, so do not rely on luck.
  const spots: [number, number][] = [];
  for (let j = 1; j + d < N; j++) for (let i = 1; i + w < N; i++) if (g.clearing(i, j, w, d)) spots.push([i, j]);
  if (!spots.length) return null;
  const spot = g.rng.pick(spots);
  return [spot[0], spot[1], g.at(spot[0], spot[1]).h];
}

/**
 * SPIRAL TOWER (3x3). A staircase winds three levels up round a solid core;
 * the top is a sniper's perch with a prize on it.
 */
const spiralTower: Structure = (g) => {
  const s = site(g, 3, 3);
  if (!s) return false;
  const [i, j, h] = s;
  const flip = g.rng.next() < 0.5; // mirror it so towers do not all wind the same way
  const at = (a: number, b: number): [number, number] => (flip ? [i + b, j + a] : [i + a, j + b]);
  const dir = (d: number) => (flip ? [1, 0, 3, 2][d] : d);
  const flat = (a: number, b: number, lv: number, prize = false) => {
    const c = g.at(...at(a, b));
    c.h = h + lv * LV; c.mat = 'concreteDark'; c.prize = prize;
  };
  g.reserve(i, j, 3, 3);
  g.ramp(...at(1, 0), dir(0), h); // corner (0,0) stays at ground level: the way in
  flat(2, 0, 1);
  g.ramp(...at(2, 1), dir(1), h + LV);
  flat(2, 2, 2);
  g.ramp(...at(1, 2), dir(2), h + 2 * LV);
  flat(0, 2, 3);
  flat(0, 1, 3);
  flat(1, 1, 3, true); // the core
  return true;
};

/**
 * ZIGGURAT (5x5). A raised square with ramps on its sides and a second tier
 * in the middle: king of the hill.
 */
const ziggurat: Structure = (g) => {
  const s = site(g, 5, 5);
  if (!s) return false;
  const [i, j, h] = s;
  g.reserve(i, j, 5, 5);
  for (let b = 1; b <= 3; b++) for (let a = 1; a <= 3; a++) { const c = g.at(i + a, j + b); c.h = h + LV; c.mat = 'tile'; }
  const top = g.at(i + 2, j + 2);
  top.h = h + 2 * LV; top.mat = 'concreteDark'; top.prize = true;
  // One side is a double ramp straight to the top; the opposite one always exists too.
  g.ramp(i + 2, j, 1, h);
  g.ramp(i + 2, j + 1, 1, h + LV);
  g.ramp(i + 2, j + 4, 3, h);
  if (g.rng.next() < 0.7) g.ramp(i, j + 2, 0, h);
  if (g.rng.next() < 0.7) g.ramp(i + 4, j + 2, 2, h);
  return true;
};

/** BUNKER (3x3). A dark concrete box with two doorways and something worth having inside. */
const bunker: Structure = (g) => {
  const s = site(g, 3, 3);
  if (!s) return false;
  const [i, j, h] = s;
  const alongX = g.rng.next() < 0.5;
  const wallH = 2.7;
  g.reserve(i, j, 3, 3);
  for (let b = 0; b < 3; b++) {
    for (let a = 0; a < 3; a++) {
      const c = g.at(i + a, j + b);
      const door = alongX ? b === 1 && a !== 1 : a === 1 && b !== 1;
      if (a === 1 && b === 1) { c.used = false; c.mat = 'metal'; } // a weapon may spawn inside
      else if (door) c.mat = 'metal';
      else { c.kind = 'block'; c.h = h + wallH; c.mat = 'concreteDark'; }
    }
  }
  // roof, and darkness inside
  g.solids.push({ type: 'box', mat: 'concreteDark', min: v3(x0(i), h + wallH, x0(j)), max: v3(x0(i + 3), h + wallH + 0.4, x0(j + 3)) });
  g.triggers.push({ type: 'dark', min: v3(x0(i) + 0.4, h - 0.2, x0(j) + 0.4), max: v3(x0(i + 3) - 0.4, h + wallH - 0.05, x0(j + 3) - 0.4) });
  return true;
};

/** STUNT JUMP (1x4 or 1x5). Two kicker ramps facing each other across a strip of deadly floor. */
const stuntJump: Structure = (g) => {
  const len = g.rng.int(4, 5), d = g.rng.int(0, 1);
  const s = site(g, d === 0 ? len : 1, d === 0 ? 1 : len);
  if (!s) return false;
  const [i, j, h] = s;
  g.reserve(i, j, d === 0 ? len : 1, d === 0 ? 1 : len);
  for (let k = 0; k < len; k++) {
    const a = i + DI[d] * k, b = j + DJ[d] * k;
    if (k === 0) g.ramp(a, b, d, h);
    else if (k === len - 1) g.ramp(a, b, d + 2, h);
    else { const c = g.at(a, b); c.surface = 'deadly'; c.mat = 'lava'; }
  }
  return true;
};

/**
 * OVERPASS (1x7). Ramps up to a bridge two levels above the ground; you can
 * run underneath it. The middle of the bridge holds a prize.
 */
const overpass: Structure = (g) => {
  const d = g.rng.int(0, 1);
  const s = site(g, d === 0 ? 7 : 1, d === 0 ? 1 : 7);
  if (!s) return false;
  const [i, j, h] = s;
  g.reserve(i, j, d === 0 ? 7 : 1, d === 0 ? 1 : 7);
  const cell = (k: number): [number, number] => [i + DI[d] * k, j + DJ[d] * k];
  g.ramp(...cell(0), d, h);
  g.ramp(...cell(1), d, h + LV);
  g.ramp(...cell(5), d + 2, h + LV);
  g.ramp(...cell(6), d + 2, h);
  const side = d === 0 ? 1 : 0; // direction index across the bridge
  for (let k = 2; k <= 4; k++) {
    const [a, b] = cell(k);
    const c = g.at(a, b);
    c.under = h; c.h = h + 2 * LV; c.thin = true; c.mat = 'metal';
    // the ground underneath is open: both sides of the bridge are connected through it
    const n1 = idx(a + DI[side], b + DJ[side]), n2 = idx(a - DI[side], b - DJ[side]);
    g.links.push([n1, n2], [n2, n1]);
  }
  g.at(...cell(3)).used = false; // weapon spot on the bridge
  return true;
};

/** TRAMPOLINES. Three jump pads that throw you round a triangle for as long as you like. */
const trampolines: Structure = (g) => {
  const cand: [number, number][] = [];
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) if (g.free(i, j)) cand.push([i, j]);
  // Pads bounce you rather than aim you, so a group only goes where there is
  // solid floor at the same height all the way between its pads: a bounce that
  // misses lands you on the ground, never in the void or a pit.
  const solidBetween = (p: [number, number], q: [number, number]) => {
    const h = g.at(...p).h, steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 3);
    for (let k = 1; k < steps; k++) {
      const c = g.at(Math.round(p[0] + ((q[0] - p[0]) * k) / steps), Math.round(p[1] + ((q[1] - p[1]) * k) / steps));
      if (c.kind !== 'floor' || c.h !== h || c.surface === 'deadly' || !Number.isNaN(c.under)) return false;
    }
    return true;
  };
  const near = (p: [number, number], q: [number, number]) => {
    const m = Math.hypot(p[0] - q[0], p[1] - q[1]);
    return m >= 3 && m <= 6 && solidBetween(p, q);
  };
  for (let t = 0; t < 12 && cand.length > 10; t++) {
    const a = g.rng.pick(cand);
    const h = g.at(...a).h;
    const bs = cand.filter((q) => near(a, q) && g.at(...q).h === h);
    if (!bs.length) continue;
    const b = g.rng.pick(bs);
    const cs = bs.filter((q) => near(b, q));
    if (!cs.length) continue;
    const c = g.rng.pick(cs);
    g.pad(...a, ...b);
    g.pad(...b, ...c);
    g.pad(...c, ...a);
    return true;
  }
  return false;
};

const STRUCTURES: [string, Structure][] = [
  ['SPIRAL TOWER', spiralTower], ['ZIGGURAT', ziggurat], ['BUNKER', bunker],
  ['STUNT JUMP', stuntJump], ['OVERPASS', overpass], ['TRAMPOLINES', trampolines],
];

/** footprint (cells) of each entry in STRUCTURES, for placing big ones first */
const SIZE = [9, 25, 9, 5, 7, 1];

/** How many landmarks each kind of map tries to fit, and which ones make sense there. */
function placeStructures(g: Gen): void {
  const rng = g.rng;
  const pool = STRUCTURES.map((st, n) => ({ name: st[0], build: st[1], size: SIZE[n] }));
  for (let n = pool.length - 1; n > 0; n--) { const k = rng.int(0, n); [pool[n], pool[k]] = [pool[k], pool[n]]; }
  const want = g.archetype === 'ARENA' ? rng.int(3, 4) : g.archetype === 'TERRACES' ? rng.int(2, 3) : g.archetype === 'ROOMS' ? rng.int(1, 2) : 1;
  // Choose which ones this map gets, then build the biggest first while there is room.
  const chosen = pool.slice(0, want).sort((a, b) => b.size - a.size);
  const spare = pool.slice(want);
  for (const st of [...chosen, ...spare]) {
    if (g.structures.length >= want) break;
    if (g.archetype === 'ISLANDS' && st.name !== 'TRAMPOLINES') continue; // islands are too small for the big ones
    if (st.build(g)) g.structures.push(st.name);
  }
}

// -------------------------------------------------------------- decoration
function decorate(g: Gen): void {
  const rng = g.rng;
  const open = g.archetype !== 'ISLANDS';

  placeStructures(g); // landmarks first, while there is still room for them

  // Floating slabs you can only reach by jump pad: the high ground.
  for (let n = open ? rng.int(0, 2) : 0; n > 0; n--) {
    const spot = g.findClearing(2, 2);
    if (!spot) break;
    const [i, j] = spot;
    const base = g.at(i, j).h;
    // pad two cells away along a row or column, on the same level
    const d = rng.int(0, 3);
    const pi = i + (DI[d] > 0 ? 3 : DI[d] < 0 ? -2 : 0), pj = j + (DJ[d] > 0 ? 3 : DJ[d] < 0 ? -2 : 0);
    if (!g.free(pi, pj) || g.at(pi, pj).h !== base) continue;
    for (let b = j; b < j + 2; b++) {
      for (let a = i; a < i + 2; a++) { const c = g.at(a, b); c.under = base; c.h = base + 2 * LV; c.thin = true; c.mat = 'metal'; }
    }
    g.reserve(i, j, 2, 2);
    const ti = DI[d] > 0 ? i + 1 : i, tj = DJ[d] > 0 ? j + 1 : j; // slab cell nearest the pad
    g.pad(pi, pj, ti, tj);
    g.at(ti, tj).used = false; // the slab stays a valid weapon spot
  }

  // Hazards and obstacles, each in its own clearing so the map stays connected.
  const place = (count: number, w: number, d: number, fn: (c: Cell) => void) => {
    for (let n = 0; n < count; n++) {
      const spot = g.findClearing(w, d, 25);
      if (!spot) return;
      for (let b = spot[1]; b < spot[1] + d; b++) for (let a = spot[0]; a < spot[0] + w; a++) fn(g.at(a, b));
      g.reserve(spot[0], spot[1], w, d);
    }
  };
  if (open) {
    place(rng.int(0, 2), rng.int(1, 2), rng.int(1, 2), (c) => { c.kind = 'void'; }); // pits
    place(rng.int(0, 2), rng.int(1, 2), 1, (c) => { c.surface = 'deadly'; c.mat = 'lava'; }); // lava
  }
  place(rng.int(1, open ? 5 : 2), 1, 1, (c) => { c.kind = 'block'; c.h += rng.range(2.5, 7); c.mat = 'concreteDark'; }); // pillars

  // Conveyor strips: 3-5 cells in a line.
  for (let n = open ? rng.int(0, 2) : 0; n > 0; n--) {
    const d = rng.int(0, 3), len = rng.int(3, 5);
    const i = rng.int(1, N - 2), j = rng.int(1, N - 2);
    const cells: [number, number][] = [];
    for (let k = 0; k < len; k++) cells.push([i + DI[d] * k, j + DJ[d] * k]);
    if (!cells.every(([a, b]) => g.free(a, b) && g.at(a, b).h === g.at(i, j).h)) continue;
    for (const [a, b] of cells) { const c = g.at(a, b); c.surface = 'conveyor'; c.mat = 'conveyor'; c.dir = d; c.used = true; }
  }

  // Ice field, low-gravity pocket, dark corner (rooms roll their own).
  if (g.archetype !== 'ROOMS') {
    const patch = (): Rect | null => {
      const w = rng.int(3, 6), d = rng.int(3, 6), i = rng.int(0, N - w), j = rng.int(0, N - d);
      return { i0: i, j0: j, i1: i + w, j1: j + d };
    };
    if (rng.next() < 0.4) {
      const r = patch()!;
      g.each(r, (c, i, j) => { if (g.free(i, j)) { c.surface = 'ice'; c.mat = 'ice'; } });
    }
    const padHere = (r: Rect) => g.pads.some((p) => p.from.x > x0(r.i0) - CS && p.from.x < x0(r.i1) + CS && p.from.z > x0(r.j0) - CS && p.from.z < x0(r.j1) + CS);
    if (rng.next() < 0.35) {
      const r = patch()!;
      // low gravity would bend a jump pad's arc, so never overlap one
      if (!padHere(r)) g.triggers.push({ type: 'lowgrav', ...g.zoneBox(r, 0, 12), scale: 0.35 });
    }
    if (rng.next() < 0.3) {
      const r = patch()!;
      g.each(r, (c) => { c.dark = true; });
      g.triggers.push({ type: 'dark', ...g.zoneBox(r, 0, 9) });
    }
  }

  // A teleporter pair between two far-apart spots.
  if (rng.next() < (open ? 0.45 : 0.3)) {
    const cand: [number, number][] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (g.free(i, j)) cand.push([i, j]);
    if (cand.length > 20 * AREA()) {
      const a = rng.pick(cand);
      let best = a, bd = 0;
      for (const c of cand) {
        const dd = Math.hypot(c[0] - a[0], c[1] - a[1]) + rng.next() * 3;
        if (dd > bd) { bd = dd; best = c; }
      }
      if (bd > N * 0.45) g.teleport(a[0], a[1], best[0], best[1]);
    }
  }

  // Low cover. Small enough to walk around inside its cell.
  for (let n = Math.round(rng.int(8, 16) * Math.max(0.45, AREA())); n > 0; n--) {
    const i = rng.int(0, N - 1), j = rng.int(0, N - 1);
    if (!g.free(i, j)) continue;
    const c = g.at(i, j);
    const wide = rng.next() < 0.5;
    const w = wide ? 0.8 : 0.3, d = wide ? 0.3 : 0.8, h = rng.range(0.9, 1.3);
    g.solids.push({ type: 'box', mat: 'concrete', min: v3(cx(i) - w, c.h, cx(j) - d), max: v3(cx(i) + w, c.h + h, cx(j) + d) });
    c.used = true;
  }
}

// ------------------------------------------------------- walkability graph
interface Graph { nodes: number[]; adj: number[][]; radj: number[][] }

/** Height of a cell's edge on side d (ramps are low on one side and high on the other). */
function sideH(c: Cell, d: number): number {
  if (c.kind !== 'ramp') return c.h;
  if (d === c.dir) return c.h + LV;
  if (d === (c.dir + 2) % 4) return c.h;
  return c.h + LV / 2;
}

function buildGraph(g: Gen): Graph {
  const walkable = (c: Cell) => (c.kind === 'floor' || c.kind === 'ramp') && c.surface !== 'deadly';
  const adj: number[][] = [], radj: number[][] = [], nodes: number[] = [];
  for (let n = 0; n < N * N; n++) { adj.push([]); radj.push([]); }
  const link = (a: number, b: number) => { if (!adj[a].includes(b)) { adj[a].push(b); radj[b].push(a); } };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = g.at(i, j);
      if (!walkable(a)) continue;
      nodes.push(idx(i, j));
      for (let d = 0; d < 4; d++) {
        const ni = i + DI[d], nj = j + DJ[d];
        if (!inb(ni, nj)) continue;
        const b = g.at(ni, nj);
        // Walk across, hop up a little, or drop down any distance.
        if (walkable(b) && sideH(b, (d + 2) % 4) - sideH(a, d) <= CLIMB) link(idx(i, j), idx(ni, nj));
      }
    }
  }
  for (const [a, b] of g.links) link(a, b);
  return { nodes, adj, radj };
}

function bfs(adj: number[][], start: number): Int32Array {
  const dist = new Int32Array(N * N).fill(-1);
  const queue = [start];
  dist[start] = 0;
  for (let q = 0; q < queue.length; q++) {
    for (const n of adj[queue[q]]) if (dist[n] < 0) { dist[n] = dist[queue[q]] + 1; queue.push(n); }
  }
  return dist;
}

// ----------------------------------------------------- spawns and weapons
const cellPos = (g: Gen, n: number): Vec3 => g.center(n % N, Math.floor(n / N));

function pickSpawns(g: Gen, core: number[]): number[] | null {
  const cand = core.filter((n) => g.free(n % N, Math.floor(n / N)));
  const count = sizeInfo().spawns;
  // Spawns as far apart as the map allows: 12 m on the big maps, less on the small ones.
  const apart = Math.min(12, N * CS * 0.28);
  if (cand.length < count * 2) return null;
  // Farthest-point sampling: start at the cell farthest from the middle,
  // then keep adding whichever candidate is farthest from all chosen so far.
  const chosen: number[] = [];
  let first = cand[0], fd = -1;
  for (const n of cand) {
    const p = cellPos(g, n);
    const d = Math.hypot(p.x, p.z) + g.rng.next() * 2;
    if (d > fd) { fd = d; first = n; }
  }
  chosen.push(first);
  while (chosen.length < count) {
    let best = -1, bd = -1;
    for (const n of cand) {
      if (chosen.includes(n)) continue;
      const p = cellPos(g, n);
      let d = Infinity;
      for (const c of chosen) { const q = cellPos(g, c); d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)); }
      if (d > bd) { bd = d; best = n; }
    }
    if (best < 0 || bd < apart) return null; // spawns must be well apart
    chosen.push(best);
  }
  for (const n of chosen) g.cells[n].used = true;
  return chosen;
}

function placeWeapons(g: Gen, graph: Graph, core: number[], spawns: number[], seed: number): { pos: Vec3; weapon: WeaponId }[] {
  const out: { cell: number; weapon: WeaponId }[] = [];
  const dists = spawns.map((s) => bfs(graph.adj, s));
  const take = (cell: number, weapon: WeaponId) => { out.push({ cell, weapon }); g.cells[cell].used = true; };
  const freeCells = () => core.filter((n) => g.free(n % N, Math.floor(n / N)));
  // What lies in each spot: nothing is guaranteed. Every spot rolls on its own from every
  // weapon, each weighted by its tier (TIER_WEIGHT in config/weapons.ts: commoner tiers
  // turn up more often), so any weapon can be anywhere and no two maps feel alike.
  const pool = WEAPON_TIERS.flatMap((ids, t) => ids.map((id) => ({ id, w: TIER_WEIGHT[t] })));
  const poolWeight = pool.reduce((sum, p) => sum + p.w, 0);
  const roll = (): WeaponId => {
    let r = g.rng.next() * poolWeight;
    for (const p of pool) if ((r -= p.w) < 0) return p.id;
    return pool[pool.length - 1].id;
  };

  // Where the spots are:
  // 1. One a few steps from every spawn, so nobody starts far from something.
  spawns.forEach((_s, k) => {
    let best = -1, bd = Infinity;
    for (const n of freeCells()) {
      const d = dists[k][n];
      if (d < 2) continue;
      const score = d + g.rng.next() * 0.9;
      if (score < bd) { bd = score; best = n; }
    }
    if (best >= 0) take(best, roll());
  });

  // 2. Three in the best spots, where nobody starts with an advantage: landmark tops
  //    and jump-pad slabs first, then the cells whose NEAREST spawn is as far away as possible.
  let pn = 0;
  const firstPower = out.length;
  for (const n of core) {
    const c = g.cells[n];
    // landmark tops first, then jump-pad slabs and bridges
    if (pn < 3 && c.kind === 'floor' && c.prize) { c.prize = false; take(n, roll()); pn++; }
    else if (pn < 3 && !Number.isNaN(c.under) && !c.used) { take(n, roll()); pn++; }
  }
  while (pn < 3) {
    let best = -1, bs = -1;
    for (const n of freeCells()) {
      let near = Infinity;
      for (const d of dists) if (d[n] >= 0) near = Math.min(near, d[n]);
      const p = cellPos(g, n);
      let apart = Infinity; // keep power weapons away from each other too
      for (const o of out.slice(spawns.length)) { const q = cellPos(g, o.cell); apart = Math.min(apart, Math.hypot(p.x - q.x, p.z - q.z)); }
      if (apart < Math.min(9, N * CS * 0.2)) continue; // spread out
      const score = near + g.rng.next() * 0.5;
      if (score > bs) { bs = score; best = n; }
    }
    if (best < 0) break;
    take(best, roll());
    pn++;
  }
  // Now and then, the best spot of all holds a legendary instead. Rolled on
  // its own generator, so maps without one come out exactly as before.
  const luck = new Rng((seed ^ 0x51e9d4a7) >>> 0);
  if (pn > 0 && LEGENDARIES.length && luck.next() < LEGENDARY_CHANCE) {
    out[firstPower].weapon = LEGENDARIES[luck.int(0, LEGENDARIES.length - 1)];
  }

  // 3. The rest spread evenly over the map.
  const total = Math.max(spawns.length + 3, Math.round(15 * AREA())); // 15 on the biggest maps, fewer on smaller ones
  while (out.length < total) {
    let best = -1, bd = -1;
    for (const n of freeCells()) {
      const p = cellPos(g, n);
      let d = Infinity;
      for (const o of out) { const q = cellPos(g, o.cell); d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)); }
      if (d > bd) { bd = d; best = n; }
    }
    if (best < 0 || bd < Math.min(5, N * CS * 0.12)) break;
    take(best, roll());
  }
  // 4. Now and then, a SKYSWEEPER (a flying broom) in the emptiest spot left. Its own roll, so
  //    maps without one come out exactly as before.
  const broomLuck = new Rng((seed ^ 0x2b7e1516) >>> 0);
  if (broomLuck.next() < BROOM.chance) {
    let best = -1, bd = -1;
    for (const n of freeCells()) {
      const p = cellPos(g, n);
      let d = Infinity;
      for (const o of out) { const q = cellPos(g, o.cell); d = Math.min(d, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)); }
      if (d > bd) { bd = d; best = n; }
    }
    if (best >= 0) take(best, 'skysweeper');
  }
  return out.map((o) => ({ pos: cellPos(g, o.cell), weapon: o.weapon }));
}

// ------------------------------------------------------------- geometry
function emit(g: Gen): void {
  const s = g.solids;
  const DEEP = -1.2; // underside of solid ground
  const bottom = (c: Cell) => (c.thin && Number.isNaN(c.under) ? c.h - 0.8 : DEEP);

  // Floors: merge runs of identical cells into as few boxes as possible.
  const key = (c: Cell) => (c.kind === 'floor' ? `${c.h}|${c.thin}|${c.under}|${c.mat}|${c.surface}|${c.surface === 'conveyor' ? c.dir : 0}|${c.dark}` : '');
  const done = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = g.at(i, j);
      const k = key(c);
      if (!k || done[idx(i, j)]) continue;
      let w = 1;
      while (i + w < N && !done[idx(i + w, j)] && key(g.at(i + w, j)) === k) w++;
      let d = 1;
      grow: while (j + d < N) {
        for (let a = i; a < i + w; a++) if (done[idx(a, j + d)] || key(g.at(a, j + d)) !== k) break grow;
        d++;
      }
      for (let b = j; b < j + d; b++) for (let a = i; a < i + w; a++) done[idx(a, b)] = 1;
      const xa = x0(i), xb = x0(i + w), za = x0(j), zb = x0(j + d);
      const solid: Solid = { type: 'box', mat: c.mat, surface: c.surface, min: v3(xa, 0, za), max: v3(xb, c.h, zb) };
      if (!Number.isNaN(c.under)) {
        solid.min.y = c.h - 0.4; // floating slab...
        s.push({ type: 'box', mat: 'concrete', min: v3(xa, DEEP, za), max: v3(xb, c.under, zb) }); // ...over normal ground
      } else {
        solid.min.y = bottom(c);
        if (c.thin && w >= 2 && d >= 2) { // a chunk hanging under each island, for looks
          s.push({ type: 'box', mat: 'concreteDark', min: v3(xa + 0.8, c.h - 0.8 - 0.5 * Math.min(w, d), za + 0.8), max: v3(xb - 0.8, c.h - 0.8, zb - 0.8) });
        }
      }
      if (c.surface === 'conveyor') solid.push = v3(DI[c.dir] * 4, 0, DJ[c.dir] * 4);
      s.push(solid);
    }
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = g.at(i, j);
      const xa = x0(i), xb = xa + CS, za = x0(j), zb = za + CS;
      if (c.kind === 'block') s.push({ type: 'box', mat: c.mat, min: v3(xa, DEEP, za), max: v3(xb, c.h, zb) });
      else if (c.kind === 'shaft') s.push({ type: 'box', mat: 'concreteDark', min: v3(xa, DEEP, za), max: v3(xb, c.h, zb) });
      else if (c.kind === 'ramp') {
        const base = c.thin ? c.h - 0.8 : DEEP;
        if (c.h > base) s.push({ type: 'box', mat: c.mat, min: v3(xa, base, za), max: v3(xb, c.h, zb) });
        if (!c.stairs) {
          s.push({ type: 'ramp', mat: c.mat, high: RAMP_HIGH[c.dir], min: v3(xa, c.h, za), max: v3(xb, c.h + LV, zb) });
        } else {
          // six steps of 0.25 m, rising towards c.dir
          for (let k = 0; k < 6; k++) {
            const a = k * 0.5; // each step runs from its own start to the high end
            const lo = v3(xa, c.h, za), hi = v3(xb, c.h + 0.25 * (k + 1), zb);
            if (c.dir === 0) lo.x = xa + a; else if (c.dir === 2) hi.x = xb - a;
            else if (c.dir === 1) lo.z = za + a; else hi.z = zb - a;
            s.push({ type: 'box', mat: c.mat, min: lo, max: hi });
          }
        }
      }
    }
  }

  if (g.walled) {
    let top = 0;
    for (const c of g.cells) if (c.kind !== 'void') top = Math.max(top, c.h);
    const H = top + 5, W = HALF;
    s.push({ type: 'box', mat: 'concreteDark', min: v3(-W - 1, DEEP, -W - 1), max: v3(-W, H, W + 1) });
    s.push({ type: 'box', mat: 'concreteDark', min: v3(W, DEEP, -W - 1), max: v3(W + 1, H, W + 1) });
    s.push({ type: 'box', mat: 'concreteDark', min: v3(-W, DEEP, -W - 1), max: v3(W, H, -W) });
    s.push({ type: 'box', mat: 'concreteDark', min: v3(-W, DEEP, W), max: v3(W, H, W + 1) });
  }

  // Monoliths on the horizon. Pure scenery.
  for (let n = g.rng.int(4, 7); n > 0; n--) {
    const a = g.rng.range(0, Math.PI * 2), r = g.rng.range(84, 125); // well outside the menu camera orbit
    const w = g.rng.range(6, 16), h = g.rng.range(25, 75);
    const px = Math.cos(a) * r, pz = Math.sin(a) * r;
    s.push({ type: 'box', mat: n % 2 ? 'concrete' : 'concreteDark', min: v3(px - w, -30, pz - w), max: v3(px + w, h, pz + w) });
  }
}

// ------------------------------------------------------------ validation
const HULL_MIN = v3(-PLAYER.radius, 0.02, -PLAYER.radius);
const HULL_MAX = v3(PLAYER.radius, PLAYER.height, PLAYER.radius);

/** Fly a player-sized box along a jump pad's arc and make sure nothing is in the way. */
function arcClear(world: World, pad: { from: Vec3; to: Vec3; vel: Vec3 }): boolean {
  const g = MOVE.gravity, dt = 0.04;
  let p = v3(pad.from.x, pad.from.y + 0.06, pad.from.z);
  for (let t = 0; t < 4; t += dt) {
    const n = v3(pad.from.x + pad.vel.x * (t + dt), pad.from.y + 0.06 + pad.vel.y * (t + dt) - 0.5 * g * (t + dt) ** 2, pad.from.z + pad.vel.z * (t + dt));
    const tr = world.traceBox(p, n, HULL_MIN, HULL_MAX);
    if (tr.fraction < 1 || tr.startSolid) {
      // The only thing we may hit is the landing spot, coming down.
      return pad.vel.y - g * t < 0 && Math.hypot(tr.end.x - pad.to.x, tr.end.z - pad.to.z) < 1.3 && Math.abs(tr.end.y - pad.to.y) < 0.4;
    }
    p = n;
  }
  return false;
}

function tryGenerate(seed: number, attempt: number, cells: number): MapDef | null {
  N = cells;
  HALF = (N * CS) / 2;
  const g = new Gen(seed);
  const theme = g.rng.pick(THEMES);
  g.floorMats = g.rng.pick([
    ['concrete', 'tile', 'concrete', 'metal'], ['tile', 'concrete', 'metal', 'concrete'], ['concrete', 'concrete', 'tile', 'tile'],
  ] as MatId[][]);
  const [name, build] = g.rng.pick(N >= 10 ? ARCHETYPES : ARCHETYPES.filter(([a]) => a !== 'ISLANDS'));
  g.archetype = name;
  build(g);
  decorate(g);

  // --- reachability ---
  const graph = buildGraph(g);
  if (graph.nodes.length < N * N * 0.23) return null;
  // Start from the walkable cell nearest the middle.
  let start = graph.nodes[0], sd = Infinity;
  for (const n of graph.nodes) {
    const d = Math.hypot((n % N) - N / 2 + 0.5, Math.floor(n / N) - N / 2 + 0.5);
    if (d < sd) { sd = d; start = n; }
  }
  const fwd = bfs(graph.adj, start), back = bfs(graph.radj, start);
  const core: number[] = [];
  for (const n of graph.nodes) {
    if (fwd[n] < 0) continue;
    if (back[n] < 0) return null; // somewhere you can get into but never out of: a trap
    core.push(n);
  }
  if (core.length < graph.nodes.length * 0.75) return null; // too much of the map is cut off

  const spawnCells = pickSpawns(g, core);
  if (!spawnCells) return null;
  const pickups = placeWeapons(g, graph, core, spawnCells, seed);
  if (pickups.length < Math.min(9, spawnCells.length + 3)) return null;

  emit(g);

  // --- physical checks against the real collision world ---
  const fixed = new World(g.solids.filter((s) => !s.mover));
  const all = new World(g.solids);
  const clear = (p: Vec3) => !all.traceBox(p, p, HULL_MIN, HULL_MAX).startSolid;
  const spawns = spawnCells.map((n) => {
    const p = cellPos(g, n);
    return { pos: p, yaw: Math.atan2(p.x, p.z) }; // face the middle of the map
  });
  if (!spawns.every((s) => clear(s.pos)) || !pickups.every((p) => clear(p.pos)) || !g.destinations.every(clear)) return null;
  // Spawns and weapons must be standing on something.
  const grounded = (p: Vec3) => fixed.traceRay(v3(p.x, p.y + 0.5, p.z), v3(p.x, p.y - 0.3, p.z)).fraction < 1;
  if (!spawns.every((s) => grounded(s.pos)) || !pickups.every((p) => grounded(p.pos))) return null;
  if (!g.pads.every((p) => arcClear(fixed, p))) return null;

  return {
    name: `${sizeInfo().name} ${name} ${seed.toString(16).toUpperCase().padStart(8, '0')}`,
    seed, solids: g.solids, triggers: g.triggers, spawns, pickups, bots: [],
    killY: -22, palette: theme, extent: HALF, info: { archetype: name, attempt, structures: g.structures, cells: N },
  };
}

/** Plain walled floor with a few blocks. Only used if a seed somehow fails every attempt. */
function fallback(seed: number, cells: number): MapDef {
  N = cells;
  HALF = (N * CS) / 2;
  const g = new Gen(seed);
  g.archetype = 'ARENA';
  emit(g);
  const e = HALF * 0.75, f = HALF * 0.8;
  const ring: [number, number][] = [[-e, -e], [e, e], [e, -e], [-e, e], [0, -f], [0, f]];
  const guns: WeaponId[] = ['rivet', 'chatter', 'rivet', 'chatter', 'slab', 'slab', 'postman', 'rivet', 'chatter'];
  const gr = HALF * 0.42;
  return {
    name: 'FALLBACK ARENA', seed, solids: g.solids, triggers: [], bots: [], killY: -22, palette: THEMES[0], extent: HALF,
    spawns: ring.map(([x, z]) => ({ pos: v3(x, 0, z), yaw: Math.atan2(x, z) })),
    pickups: guns.map((weapon, n) => ({ pos: v3(Math.cos(n * 0.7) * gr, 0, Math.sin(n * 0.7) * gr), weapon })),
    info: { archetype: 'FALLBACK', attempt: -1, structures: [], cells: N },
  };
}

/**
 * Build the map for a seed, `cells` cells a side (see MAP_SIZES; by default
 * whatever pickMapSize gives a four-player room). Deterministic: the same seed
 * and size give the same map on every machine. If a layout fails validation it
 * is regenerated with a seed derived from the original one, so the result is
 * still a pure function of what the host sent.
 */
export function generateMap(seed: number, cells = pickMapSize(seed, 4)): MapDef {
  for (let attempt = 0; attempt < 40; attempt++) {
    const map = tryGenerate((seed + Math.imul(attempt, 0x9e3779b1)) >>> 0, attempt, cells);
    if (map) {
      map.seed = seed >>> 0;
      return map;
    }
  }
  const map = fallback(seed >>> 0, cells);
  return map;
}
