import type { Vec3 } from '../core/vec';
import { box, type MapDef, type MatId, type MoverDef, type Palette, type Solid, type Surface, type Trigger } from '../sim/map';

// PARKOUR: three long obstacle courses, each with its own look:
//   BLOCKLANDS   - a blocky voxel world of floating grass islands over a lava sea
//   DUNE TEMPLE  - sandstone temple ruins in a desert at golden hour
//   NEON SPRAWL  - a megacity at night: glass towers, neon, rain-dark metal
// Jump, bunny hop, crouch, wall run, wall jump and ride platforms from the
// start to the finish as fast as you can; a checkpoint after every section.
//
// A course is built section by section along +x (Builder below): each section
// is an obstacle proven by the autopilot, placed from where the last
// checkpoint ended. Each course also carries a `route`: where to go and how.
// The autopilot in scripts/parkourtest.ts follows it to prove every course
// can be finished; the game itself does not use it.

/** How the autopilot gets to a waypoint. */
export type Move =
  | 'run' // W, jumping at the edge of every drop on the way
  | 'hop' // W + jump on every landing (bunny hops, for speed)
  | 'crouch' // W + crouch (slides when fast)
  | 'wallrun' // W, jumping at an edge: carried along a wall by a run started before
  | 'climb'; // W + a jump press each time it can wall jump: up a chimney

export interface Waypoint {
  x: number;
  y: number;
  z: number;
  move: Move;
  /** Hold still before setting off for this waypoint until this is true (moving platforms). */
  wait?: (tick: number) => boolean;
  /** how close counts as there (m, flat distance); default 1 */
  reach?: number;
  /** only counts as there once standing on it (so the pilot brakes in the air to land on something small) */
  land?: boolean;
}

export interface Course {
  id: string;
  name: string;
  blurb: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  map: MapDef;
  /** Below this you have fallen, wherever you are (see also RACE.fallBelow): back to your last checkpoint. */
  fallY: number;
  /** How many checkpoints there are (start excluded). */
  checkpoints: number;
  route: Waypoint[];
}

/** Where a mover is (0 at rest, 1 at the far end) at a tick: the same sum the world does. */
function moverAt(m: MoverDef, tick: number): number {
  const period = 2 * m.moveTime + m.waitA + m.waitB;
  let t = ((tick / 60) + m.phase) % period;
  if (t < 0) t += period;
  if (t < m.waitA) return 0;
  t -= m.waitA;
  if (t < m.moveTime) return t / m.moveTime;
  t -= m.moveTime;
  if (t < m.waitB) return 1;
  return 1 - (t - m.waitB) / m.moveTime;
}

/** Seconds left at the near end (0) / far end (1) of the cycle, or 0 when it is not resting there. */
function restLeft(m: MoverDef, tick: number, end: 0 | 1): number {
  const period = 2 * m.moveTime + m.waitA + m.waitB;
  let t = ((tick / 60) + m.phase) % period;
  if (t < 0) t += period;
  if (end === 0) return t < m.waitA ? m.waitA - t : 0;
  const s = m.waitA + m.moveTime;
  return t >= s && t < s + m.waitB ? s + m.waitB - t : 0;
}

/** A course's look: what each part is made of, what stands under it and around it. */
interface Theme {
  palette: Palette;
  floor: MatId; // walkable tops
  cap?: MatId; // a thin layer on top of floors (grass on dirt)
  checkpoint: MatId;
  finish: MatId;
  wall: MatId; // walls to run along, chimneys, ceilings
  beam: MatId; // beams, stones, pillars
  accent: MatId; // hurdles and bars
  mover: MatId;
  tower: MatId; // what a spiral climbs round
  spiral: MatId; // the steps of the spiral
  /** Called once the course is laid: structures under the floors, scenery around, glowing bits. */
  dress(b: Builder): void;
  /**
   * In place of the plain tower a spiral climbs round: something to look at,
   * built in the leg's frame round (cx, 0), the steps rising from y. It must
   * keep within 2.5 m of the centre between y - 1 and y + 14 (the steps run
   * there), and stand at least 3.3 m from the centre on the diagonals.
   */
  statue?(b: Builder, cx: number, y: number): void;
  /**
   * Another world the course can go on into through a portal (see Builder.portal):
   * the materials its sections use there, and how to dress it (called with
   * b.floors holding only that world's floors).
   */
  realm?: { t: Partial<Omit<Theme, 'realm' | 'dress' | 'palette'>>; dress(b: Builder): void };
}

/** A floor the course runs on, remembered so the theme can build under and around it. */
interface Floor { x0: number; x1: number; z0: number; z1: number; y: number; under: boolean; mat: MatId }

/** A steady random number 0..1 for a point (and a salt): the same every time. */
const hash2 = (x: number, z: number, k: number) => { const h = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return h - Math.floor(h); };

/** Steady pseudo-random numbers for scenery (the same every time: every peer builds the same map). */
function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A box with a box-shaped hole cut out of it: the pieces left (up to six). */
function carve(b: { min: Vec3; max: Vec3 }, h: { min: Vec3; max: Vec3 }): { min: Vec3; max: Vec3 }[] {
  if (h.min.x >= b.max.x || h.max.x <= b.min.x || h.min.y >= b.max.y || h.max.y <= b.min.y || h.min.z >= b.max.z || h.max.z <= b.min.z) return [b];
  const out: { min: Vec3; max: Vec3 }[] = [];
  let r = { min: { ...b.min }, max: { ...b.max } };
  for (const k of ['x', 'y', 'z'] as const) {
    if (h.min[k] > r.min[k]) { out.push({ min: { ...r.min }, max: { ...r.max, [k]: h.min[k] } }); r = { min: { ...r.min, [k]: h.min[k] }, max: r.max }; }
    if (h.max[k] < r.max[k]) { out.push({ min: { ...r.min, [k]: h.max[k] }, max: { ...r.max } }); r = { min: r.min, max: { ...r.max, [k]: h.max[k] } }; }
  }
  return out;
}

class Builder {
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  route: Waypoint[] = [];
  spawns: { pos: Vec3; yaw: number }[] = [];
  decor: { min: Vec3; max: Vec3; color: number }[] = [];
  screens: NonNullable<MapDef['screens']> = [];
  traffic: NonNullable<MapDef['traffic']> = [];
  holos: NonNullable<MapDef['holos']> = [];
  life: NonNullable<MapDef['life']> = [];
  /** The towers the spirals climb round, in the world: their centres and tops (the themes crown them). */
  towers: { x: number; z: number; top: number }[] = [];
  floors: Floor[] = [];
  /** The tomb (DUNE TEMPLE's end): its halls in the world, and the door in from outside (the pyramid is built round them). */
  tombHalls: { min: Vec3; max: Vec3 }[] = [];
  tombDoor: { x: number; y: number; z: number; fwd: { x: number; z: number }; entry: { min: Vec3; max: Vec3 } } | null = null;
  /** Ground the scenery must keep off (as if it were course): the pyramid's footprint. */
  keepOff: { x0: number; x1: number; z0: number; z1: number }[] = [];
  /**
   * The cursor, in the frame of the current leg of the course: `x` how far
   * along it the next section starts (the far end of the last floor), `y` at
   * what height. Sections are written in that frame: x forward, z to the
   * right. A turn starts a new leg, so a course can wind about.
   */
  x = 0;
  y = 0;
  /** The current leg: its origin in the world and its heading (0 +x, 1 +z, 2 -x, 3 -z; a right turn adds one). */
  private ox = 0;
  private oz = 0;
  private h = 0;
  /** Which section each floor belongs to (for the check that the course never runs into itself). */
  private section = 0;
  private floorSection: number[] = [];
  private cps = 0;
  get checkpoints(): number { return this.cps; }

  /** The height the course starts at (scenery is placed around it). */
  readonly y0: number;

  /** The theme the sections build with: the course's own, or its realm's once through a portal. */
  t: Theme;
  /** Where the floors of the realm beyond the portal start (-1: no portal). */
  private realmFrom = -1;

  constructor(readonly theme: Theme, y: number) { this.t = theme; this.y = this.y0 = y; }

  // ------------------------------------------------------------ the frame
  private get fwd(): { x: number; z: number } { return [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }][this.h]; }
  private get right(): { x: number; z: number } { return [{ x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 }][this.h]; }
  /** A point of the current leg, in the world. */
  pt(u: number, y: number, v: number): Vec3 {
    const f = this.fwd, r = this.right;
    return { x: this.ox + f.x * u + r.x * v, y, z: this.oz + f.z * u + r.z * v };
  }
  /** A box of the current leg (u along it, v across it), in the world. */
  area(u0: number, u1: number, v0: number, v1: number, y0: number, y1: number): { min: Vec3; max: Vec3 } {
    const a = this.pt(u0, y0, v0), b = this.pt(u1, y1, v1);
    return { min: { x: Math.min(a.x, b.x), y: y0, z: Math.min(a.z, b.z) }, max: { x: Math.max(a.x, b.x), y: y1, z: Math.max(a.z, b.z) } };
  }
  /** A direction along the leg (du forward, dv right), in the world. */
  dir(du: number, dv: number): { x: number; z: number } {
    const f = this.fwd, r = this.right;
    return { x: f.x * du + r.x * dv, z: f.z * du + r.z * dv };
  }
  /** The yaw that looks along the leg. */
  get yaw(): number { const f = this.fwd; return Math.atan2(-f.x, -f.z); }
  /** Back to plain world coordinates (for the scenery). */
  world(): void { this.ox = this.oz = 0; this.h = 0; }

  // ------------------------------------------------------------ pieces (in the leg's frame)
  /** A plain box, top at y. */
  block(x0: number, x1: number, z0: number, z1: number, y: number, mat: MatId, depth = 1, surface: Surface = 'normal'): Solid {
    const a = this.area(x0, x1, z0, z1, y - depth, y);
    const s = box(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, mat, surface);
    this.solids.push(s);
    return s;
  }

  /** Something to stand on, top at y, in the theme's floor (with its cap). `under`: may the theme build beneath it. */
  floor(x0: number, x1: number, z0: number, z1: number, y: number, o: { depth?: number; mat?: MatId; under?: boolean } = {}): Solid {
    const depth = o.depth ?? 1, mat = o.mat ?? this.t.floor;
    const a = this.area(x0, x1, z0, z1, y, y);
    this.floors.push({ x0: a.min.x, x1: a.max.x, z0: a.min.z, z1: a.max.z, y, under: o.under ?? true, mat: o.mat ?? this.t.cap ?? mat });
    this.floorSection.push(this.section);
    if (this.t.cap && !o.mat) {
      this.block(x0, x1, z0, z1, y - 0.3, mat, depth - 0.3);
      return this.block(x0, x1, z0, z1, y, this.t.cap, 0.3);
    }
    return this.block(x0, x1, z0, z1, y, mat, depth);
  }

  go(x: number, y: number, z: number, move: Move, extra: Partial<Waypoint> = {}): void {
    this.route.push({ ...this.pt(x, y, z), move, ...extra });
  }

  /** A jump pad on a floor at y. */
  pad(x0: number, x1: number, z0: number, z1: number, y: number, up = 13): void {
    this.triggers.push({ type: 'jumppad', ...this.area(x0, x1, z0, z1, y, y + 0.5), vel: { x: 0, y: up, z: 0 } });
  }

  /** A wall from y-2 to y+6 (z0..z1 its thickness). */
  wall(x0: number, x1: number, z0: number, z1: number, y: number): Solid {
    const a = this.area(x0, x1, z0, z1, y - 2, y + 6);
    const s = box(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, this.t.wall);
    this.solids.push(s);
    return s;
  }

  /** A platform that travels (dx along the leg, dy, dz across it) and back, waiting at each end. */
  mover(x0: number, x1: number, z0: number, z1: number, y: number, m: MoverDef, depth = 0.6, mat = this.t.mover): MoverDef {
    const s = this.block(x0, x1, z0, z1, y, mat, depth);
    const d = this.dir(m.dx, m.dz);
    m.dx = d.x; m.dz = d.z;
    s.mover = m;
    return m;
  }

  /** A booster strip across x0..x1, sending you along the leg at `speed`. */
  booster(x0: number, x1: number, z0: number, z1: number, y: number, speed: number): void {
    this.block(x0, x1, z0 + 0.5, z1 - 0.5, y + 0.03, 'conveyor', 0.05);
    const d = this.dir(speed, 0);
    this.triggers.push({ type: 'boost', ...this.area(x0, x1, z0, z1, y, y + 2), vel: { x: d.x, y: 0, z: d.z } });
  }

  /** A digital billboard on the face of a thin box, looking along the leg's (du, dv) direction. */
  screen(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, du: number, dv: number, style: number): void {
    const d = this.dir(du, dv);
    const face = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? '+x' : '-x') : (d.z > 0 ? '+z' : '-z');
    this.screens.push({ ...this.area(x0, x1, z0, z1, y0, y1), face, style });
  }

  /** Glowing scenery (not solid). */
  glow(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    this.decor.push({ ...this.area(x0, x1, z0, z1, y0, y1), color });
  }

  // ------------------------------------------------------------ start, checkpoints, turns, finish
  start(): void {
    const y = this.y;
    this.floor(-8, 6, -4, 4, y, { mat: this.t.checkpoint, depth: 2 });
    this.triggers.push({ type: 'start', ...this.area(-8, 6, -4, 4, y, y + 4) });
    // Room for a whole race: the middle first (solo runs use that one), then out to both sides.
    this.spawns = [0, -1, 1, -2, 2, -3].map((k) => ({ pos: this.pt(-6.5, y + 0.02, k * 1.1), yaw: this.yaw }));
    this.x = 6;
  }

  /** A checkpoint platform at the cursor: fall after this and you come back here. */
  checkpoint(len = 12): void {
    const { x, y } = this;
    this.section++;
    this.floor(x, x + len, -4, 4, y, { mat: this.t.checkpoint, depth: 2 });
    this.triggers.push({ type: 'checkpoint', ...this.area(x, x + len, -4, 4, y, y + 4), index: ++this.cps, spawn: this.pt(x + 1.5, y + 0.02, 0), yaw: this.yaw });
    this.go(x + len - 3, y, 0, 'run', { reach: 1.5 });
    this.x = x + len;
    this.section++;
  }

  /** A corner (and a checkpoint): the course turns right (+1) or left (-1). */
  turn(dir: 1 | -1): void {
    const { x, y } = this;
    this.section++;
    this.floor(x, x + 9, -4.5, 4.5, y, { mat: this.t.checkpoint, depth: 2 });
    const c = this.pt(x + 4.5, y, 0);
    this.go(x + 4.5, y, 0, 'run', { reach: 1.5 });
    const area = this.area(x, x + 9, -4.5, 4.5, y, y + 4);
    this.ox = c.x; this.oz = c.z;
    this.h = (this.h + dir + 4) % 4;
    this.triggers.push({ type: 'checkpoint', ...area, index: ++this.cps, spawn: { x: c.x, y: y + 0.02, z: c.z }, yaw: this.yaw });
    this.x = 4.5;
    this.section++;
  }

  finish(): void {
    const { x, y } = this;
    this.section++;
    this.floor(x, x + 14, -5, 5, y, { mat: this.t.finish, depth: 2 });
    this.triggers.push({ type: 'finish', ...this.area(x, x + 14, -5, 5, y, y + 4) });
    this.block(x + 14, x + 15, -5.5, 5.5, y + 4, this.t.wall, 6); // the end: a wall to stop against
    this.go(x + 7, y, 0, 'run');
    this.x = x + 15;
  }

  /**
   * Floors of sections that are not next to each other must not come close:
   * a course that runs into itself (after a few turns) is a mistake. Throws.
   */
  checkLayout(): void {
    const f = this.floors, sec = this.floorSection;
    for (let i = 0; i < f.length; i++) {
      for (let j = i + 1; j < f.length; j++) {
        if (Math.abs(sec[i] - sec[j]) <= 4) continue; // neighbours (a checkpoint, a corner, the next section) may be close
        const gx = Math.max(f[i].x0 - f[j].x1, f[j].x0 - f[i].x1), gz = Math.max(f[i].z0 - f[j].z1, f[j].z0 - f[i].z1);
        if (Math.max(gx, gz) < 6 && Math.abs(f[i].y - f[j].y) < 14) {
          throw new Error(`course runs into itself: floors ${i} (section ${sec[i]}) and ${j} (section ${sec[j]}) at x ${f[j].x0.toFixed(0)} z ${f[j].z0.toFixed(0)}`);
        }
      }
    }
  }

  /** How far a point is from the course (flat distance to the nearest floor), for placing scenery. */
  clearance(x: number, z: number, y?: number): number {
    let best = Infinity;
    for (const f of this.floors) {
      if (y !== undefined && y < f.y - 30) continue; // far below it: no matter
      const dx = Math.max(f.x0 - x, 0, x - f.x1), dz = Math.max(f.z0 - z, 0, z - f.z1);
      best = Math.min(best, Math.hypot(dx, dz));
    }
    for (const f of this.keepOff) best = Math.min(best, Math.hypot(Math.max(f.x0 - x, 0, x - f.x1), Math.max(f.z0 - z, 0, z - f.z1)));
    return best;
  }

  /** The course's extent in the world. */
  bounds(): { x0: number; x1: number; z0: number; z1: number } {
    const f = this.floors;
    return { x0: Math.min(...f.map((a) => a.x0)), x1: Math.max(...f.map((a) => a.x1)), z0: Math.min(...f.map((a) => a.z0)), z1: Math.max(...f.map((a) => a.z1)) };
  }

  // ------------------------------------------------------------ sections
  // Each starts at the cursor (the end of a checkpoint) and leaves it where the next checkpoint goes.

  /** Stones 4 m square, 3 m apart, each at `rise` above the start (no step more than 1 m up). */
  stones(rises: number[], lavaBelow = false): void {
    const { x, y } = this;
    rises.forEach((r, k) => {
      const bx = x + 3 + 7 * k;
      this.floor(bx, bx + 4, -2, 2, y + r);
      this.go(bx + 2, y + r, 0, 'run', { land: r < (k ? rises[k - 1] : 0) }); // jumping down, land on each one
    });
    const end = x + 7 * rises.length;
    if (lavaBelow) this.block(x, end + 3, -8, 8, y + Math.min(0, ...rises) - 3, 'lava', 1, 'deadly');
    this.x = end + 3;
    this.y = y + rises[rises.length - 1];
  }

  /** A crawlspace 1.3 m high (crouch or slide through), then a jump pad up 3.5 m. */
  crawlPad(): void {
    const { x, y } = this;
    this.floor(x, x + 25, -2, 2, y, { depth: 2 });
    this.block(x + 3, x + 15, -2, 2, y + 2.2, this.t.wall, 0.9); // the ceiling, 1.3 m up
    this.block(x + 3, x + 15, -2.6, -2, y + 2.2, this.t.wall, 2.2);
    this.block(x + 3, x + 15, 2, 2.6, y + 2.2, this.t.wall, 2.2);
    this.pad(x + 20, x + 22, -2, 2, y);
    this.go(x + 2, y, 0, 'run');
    this.go(x + 16, y, 0, 'crouch');
    this.go(x + 21, y, 0, 'run', { reach: 0.8 });
    this.x = x + 28;
    this.y = y + 3.5;
  }

  /** A roof of hurdles (jump them) and a bar to crouch under, then zigzag stones down 1.5 m. */
  hurdles(): void {
    const { x, y } = this;
    this.floor(x, x + 37, -3, 3, y, { depth: 2 });
    for (const h of [6, 14, 22]) this.block(x + h, x + h + 0.4, -3, 3, y + 0.8, this.t.accent, 0.8);
    this.block(x + 28, x + 31, -3, 3, y + 2.2, this.t.accent, 0.9); // the bar, 1.3 m up
    this.go(x + 26, y, 0, 'run', { reach: 1.5 });
    this.go(x + 33, y, 0, 'crouch', { reach: 1.5 });
    [[40, 0.5, 3.5, 0.5, 2], [46, -3.5, -0.5, 1, -2], [52, 0.5, 3.5, 1.5, 2]].forEach(([dx, z0, z1, down, zc]) => {
      this.floor(x + dx, x + dx + 3, z0, z1, y - down);
      this.go(x + dx + 1.5, y - down, zc, 'run');
    });
    this.x = x + 58;
    this.y = y - 1.5;
  }

  /** The spiral's steps round a centre cx (local frame), its foot at height y: centres and tops. */
  static spiralSteps(cx: number, y: number): { x: number; z: number; top: number; a: number }[] {
    const R = 7;
    return Array.from({ length: 13 }, (_, i) => {
      const a = Math.PI - (i * Math.PI) / 4; // from the west side, clockwise seen from above
      return { x: cx + Math.cos(a) * R, z: Math.sin(a) * R, top: y + 0.9 * (i + 1), a };
    });
  }

  /** Thirteen steps round a tower, each 0.9 m up: all the way round and on. */
  spiral(): void {
    const { x, y } = this;
    const cx = x + 13, R = 7;
    if (this.t.statue) this.t.statue(this, cx, y);
    else {
      this.block(cx - 2.5, cx + 2.5, -2.5, 2.5, y + 14, this.t.tower, 40);
      const tc = this.pt(cx, y + 14, 0);
      this.towers.push({ x: tc.x, z: tc.z, top: y + 14 });
    }
    for (const { x: sx, z: sz, top } of Builder.spiralSteps(cx, y)) {
      this.floor(sx - 1.6, sx + 1.6, sz - 1.6, sz + 1.6, top, { mat: this.t.spiral, under: false });
      this.go(sx, top, sz, 'run', { reach: 1 });
    }
    this.x = cx + R + 4;
    this.y = y + 11.7;
  }

  /** A platform with a booster at its end, and a 7 m leap down 1 m. */
  boostLeap(): void {
    const { x, y } = this;
    this.floor(x, x + 12, -4, 4, y, { depth: 2 });
    this.booster(x + 7, x + 12, -4, 4, y, 12);
    this.go(x + 3, y, 0, 'run', { reach: 1.5 });
    this.x = x + 19;
    this.y = y - 1;
  }

  /** A jump pad, an island with another, and on: two bounces over the void. */
  padIslands(): void {
    const { x, y } = this;
    this.floor(x, x + 12, -4, 4, y, { depth: 2 });
    this.pad(x + 9, x + 11, -1.5, 1.5, y);
    this.floor(x + 19, x + 25, -3, 3, y);
    this.pad(x + 22.5, x + 24.5, -1.5, 1.5, y);
    this.go(x + 3, y, 0, 'run', { reach: 2 });
    this.go(x + 10, y, 0, 'run', { reach: 0.8 });
    this.go(x + 21, y, 0, 'run', { reach: 1.2 });
    this.go(x + 23.5, y, 0, 'run', { reach: 0.8 });
    this.x = x + 33;
  }

  /** Wall runs over 10 m gaps, one per side given (+1: wall on the right), a roof to land on between. */
  wallruns(sides: (1 | -1)[]): void {
    const { y } = this;
    let edge = this.x + 12;
    this.floor(this.x, edge, -3, 3, y, { depth: 2 });
    sides.forEach((side, k) => {
      this.wall(edge - 1, edge + 18, side > 0 ? 3 : -3.6, side > 0 ? 3.6 : -3, y);
      this.wallSign(edge - 1, edge + 18, side * 3, side, y);
      this.go(edge - 7, y, side * 2.55, 'hop', { reach: 1.5 });
      this.go(edge - 0.5, y, side * 2.55, 'hop', { reach: 1.5 });
      const land = edge + 10;
      const last = k === sides.length - 1;
      this.floor(land, land + (last ? 8 : 18), -3, 3, y, { depth: 2 });
      this.go(land + 3, y, side * 2.4, 'wallrun', { reach: 2 });
      edge = land + (last ? 8 : 18);
    });
    this.x = edge;
  }

  /**
   * A chimney: a long, narrow corridor between two tall walls, with the next
   * checkpoint on a ledge 2.6 m up at its end (beyond a jump: wall jumps needed). Run in at speed and wall jump
   * from side to side as you go: the corridor is long enough to climb on the
   * move instead of slamming into the ledge.
   */
  chimney(): void {
    const { x, y } = this;
    const L = 18, UP = 2.6;
    this.floor(x, x + L, -1.3, 1.3, y, { depth: 2 });
    this.block(x, x + L + 2, -2, -1.3, y + 6, this.t.wall, 8);
    this.block(x, x + L + 2, 1.3, 2, y + 6, this.t.wall, 8);
    // (the pilot runs in beside the right-hand wall and starts the climb 9 m before the ledge)
    this.go(x + 2, y, 0.85, 'run', { reach: 1 });
    this.go(x + L - 9, y, 0.85, 'run', { reach: 1 });
    this.go(x + L + 3, y + UP, 0.85, 'climb', { reach: 1.5 });
    this.x = x + L;
    this.y = y + UP;
  }

  /** A ferry over a 14 m gap, then a lift up 5 m, on the same beat. */
  ferryLift(): void {
    const { x, y } = this;
    const ferry = this.mover(x + 0.2, x + 4.2, -2, 2, y, { dx: 14, dy: 0, dz: 0, moveTime: 2, waitA: 1.2, waitB: 1.2, phase: 0 });
    this.go(x - 1, y, 0, 'run', { reach: 0.8 });
    this.go(x + 2, y, 0, 'run', { reach: 0.8, wait: (t) => restLeft(ferry, t, 0) > 0.5 });
    this.go(x + 17, y, 0, 'run', { reach: 0.8, wait: (t) => restLeft(ferry, t, 1) > 0.5 });
    this.floor(x + 18.4, x + 28, -3, 3, y, { depth: 2 });
    const lift = this.mover(x + 28.2, x + 32.2, -2, 2, y, { dx: 0, dy: 5, dz: 0, moveTime: 2, waitA: 1.2, waitB: 1.2, phase: 1.5 });
    this.go(x + 27, y, 0, 'run', { reach: 0.8 });
    this.go(x + 30.2, y, 0, 'run', { reach: 0.8, wait: (t) => restLeft(lift, t, 0) > 0.4 });
    this.go(x + 34, y + 5, 0, 'run', { reach: 0.8, wait: (t) => moverAt(lift, t) > 0.999 });
    this.x = x + 32.4;
    this.y = y + 5;
  }

  /** A narrow bridge swept by two blocks sliding across it: cross each lane while its block rests to one side. */
  sweepers(): void {
    const { x, y } = this;
    this.floor(x, x + 34, -1.5, 1.5, y, { depth: 2 });
    for (const [dx, phase] of [[9, 0], [21, 1.1]] as const) {
      const sx = x + dx;
      const m = this.mover(sx, sx + 2, -8.5, -6, y + 2.4, { dx: 0, dy: 0, dz: 14.5, moveTime: 1.1, waitA: 1.1, waitB: 1.1, phase }, 2.4, this.t.accent);
      this.go(sx - 2.5, y, 0, 'run', { reach: 0.6 });
      this.go(sx + 4, y, 0, 'run', { reach: 1, wait: (t) => restLeft(m, t, 0) > 0.75 || restLeft(m, t, 1) > 0.75 });
    }
    this.x = x + 34;
  }

  /** Beams under a metre wide, then a booster and an 8 m gap. */
  beamsBoost(): void {
    const { x, y } = this;
    this.floor(x + 3, x + 15, -0.4, 0.4, y, { mat: this.t.beam, under: false });
    this.go(x + 6, y, 0, 'run', { reach: 0.6 });
    this.go(x + 14, y, 0, 'run', { reach: 0.6 });
    this.floor(x + 18, x + 30, -0.4, 0.4, y + 0.5, { mat: this.t.beam, under: false });
    this.go(x + 21, y + 0.5, 0, 'run', { reach: 0.6 });
    this.go(x + 29, y + 0.5, 0, 'run', { reach: 0.6 });
    this.floor(x + 33, x + 43, -3, 3, y + 0.5, { depth: 2 });
    this.booster(x + 38, x + 43, -3, 3, y + 0.5, 13);
    this.go(x + 35, y + 0.5, 0, 'run');
    this.x = x + 51;
  }

  /** Ice, a belt running back at you, and a long jump in low gravity. */
  iceBeltGrav(): void {
    const { x, y } = this;
    this.floor(x, x + 14, -3, 3, y, { mat: 'ice', depth: 2 });
    this.solids[this.solids.length - 1].surface = 'ice';
    const belt = this.floor(x + 18, x + 30, -2, 2, y + 0.5, { mat: 'conveyor' });
    belt.push = { x: -4, y: 0, z: 0 };
    this.floor(x + 30, x + 39, -3, 3, y + 0.5, { depth: 2 });
    this.triggers.push({ type: 'lowgrav', ...this.area(x + 37, x + 54, -6, 6, y - 6, y + 12), scale: 0.35 });
    this.go(x + 13, y, 0, 'run', { reach: 1.5 });
    this.go(x + 29, y + 0.5, 0, 'run', { reach: 1.5 });
    this.go(x + 37, y + 0.5, 0, 'run', { reach: 1 });
    this.x = x + 52;
    this.y = y + 1.5;
  }

  /** Two pads up 7 m, and a wall run over the gap to the next checkpoint. */
  padsWallrun(): void {
    const { x, y } = this;
    const p0 = x + 3;
    this.floor(x, x + 6, -3, 3, y, { depth: 2 });
    this.pad(p0, p0 + 2, -1.5, 1.5, y);
    this.floor(p0 + 7, p0 + 12, -2.5, 2.5, y + 3.5);
    this.pad(p0 + 9.5, p0 + 11.5, -1.5, 1.5, y + 3.5);
    this.floor(p0 + 17, p0 + 30, -3, 3, y + 7, { depth: 2 });
    this.wall(p0 + 29, p0 + 48, 3, 3.6, y + 7);
    this.wallSign(p0 + 29, p0 + 48, 3, 1, y + 7);
    this.go(p0 + 1, y, 0, 'run', { reach: 0.8 });
    this.go(p0 + 8.5, y + 3.5, 0, 'run', { reach: 1 });
    this.go(p0 + 10.5, y + 3.5, 0, 'run', { reach: 0.8 });
    this.go(p0 + 20, y + 7, 2.2, 'run', { reach: 1.5 });
    this.go(p0 + 24, y + 7, 2.55, 'hop', { reach: 1.5 });
    this.go(p0 + 29.5, y + 7, 2.55, 'hop', { reach: 1.5 });
    this.go(p0 + 44, y + 7, 2.4, 'wallrun', { reach: 2 });
    this.x = p0 + 39;
    this.y = y + 7;
  }

  /** A portal at the end of a roof: up to the top of a spire, then dive onto the next checkpoint far below. */
  portalDive(): void {
    const { x, y } = this;
    this.floor(x, x + 6, -3, 3, y, { depth: 2 });
    this.block(x + 6, x + 7, -3, 3, y + 4, this.t.wall, 6); // a wall behind the portal
    this.triggers.push({ type: 'teleporter', ...this.area(x + 3.5, x + 5.5, -1, 1, y, y + 2), dest: this.pt(x + 13, y + 18.02, 0), pair: 1 });
    this.floor(x + 10, x + 20, -3, 3, y + 18, { mat: this.t.beam, depth: 2, under: false });
    this.block(x + 12, x + 18, -2, 2, y + 16, this.t.tower, 40);
    this.go(x + 4.5, y, 0, 'run', { reach: 0.4 });
    this.go(x + 18, y + 18, 0, 'run', { reach: 1 });
    this.x = x + 31;
    this.y = y - 2;
  }

  /** Pillars 3.5 m long, 2 m apart, up and down: a run of jumps, no stopping. */
  pillars(): void {
    const { x, y } = this;
    let px = x + 2;
    for (const dy of [0, 0.5, 1, 0.5, 0, -0.5, 0, 0.6]) {
      this.floor(px, px + 3.5, -1, 1, y + dy, { mat: this.t.beam });
      this.go(px + 1.75, y + dy, 0, 'run', { reach: 1.2, land: true });
      px += 5.5;
    }
    this.x = px + 0.5;
  }

  /** Off a ledge and down `h` metres (up to 9) onto a wide landing: a leap of faith. */
  drop(h: number): void {
    const { x, y } = this;
    this.floor(x, x + 6, -3, 3, y, { depth: 2 });
    this.floor(x + 9, x + 21, -4.5, 4.5, y - h, { depth: 2 });
    this.go(x + 3, y, 0, 'run', { reach: 1.5 });
    this.go(x + 13, y - h, 0, 'run', { reach: 2.5 });
    this.x = x + 21;
    this.y = y - h;
  }

  /** Down a cascade of ledges, each 2.5 m lower than the last. */
  cascade(n: number): void {
    const { x, y } = this;
    for (let k = 0; k < n; k++) {
      const u = x + 2 + 8 * k, top = y - 2.5 * (k + 1);
      this.floor(u, u + 6, -2.5, 2.5, top);
      this.go(u + 3, top, 0, 'run', { reach: 1.5, land: true });
    }
    this.x = x + 8 * n + 2;
    this.y = y - 2.5 * n;
  }

  /** A slalom: stones to the left and right in turn, each a diagonal jump from the last. */
  slalom(n = 5): void {
    const { x, y } = this;
    for (let k = 0; k < n; k++) {
      const u = x + 3 + 6 * k, v = k % 2 ? -2.5 : 2.5;
      this.floor(u, u + 3, v - 1.5, v + 1.5, y + (k % 3 === 2 ? 0.5 : 0));
      this.go(u + 1.5, y + (k % 3 === 2 ? 0.5 : 0), v, 'run', { reach: 1, land: true });
    }
    this.x = x + 3 + 6 * n;
  }

  /** Stepping stones sliding from side to side together: hop from one to the next while they rest. */
  movingStones(n = 3): void {
    const { x, y } = this;
    const ms: MoverDef[] = [];
    for (let k = 0; k < n; k++) {
      const u = x + 3 + 7 * k;
      ms.push(this.mover(u, u + 4, -5, -1, y, { dx: 0, dy: 0, dz: 6, moveTime: 1.4, waitA: 1.4, waitB: 1.4, phase: 0 }, 0.8));
    }
    ms.forEach((m, k) => {
      const u = x + 3 + 7 * k;
      // go when they have just come to rest on the left, and land while they are still there
      this.go(u + 2, y, -3, 'run', { reach: 1, land: true, wait: (t) => restLeft(m, t, 0) > 0.85 });
    });
    this.go(x + 3 + 7 * n + 3, y, 0, 'run', { reach: 2, wait: (t) => restLeft(ms[n - 1], t, 0) > 0.85 });
    this.x = x + 3 + 7 * n;
  }

  // ------------------------------------------------------------ through a portal, into another world

  /**
   * A gate of dark stone at the end of a platform, a curtain of fire in it:
   * run through and you are in the theme's realm, far away, going the same
   * way, on its first checkpoint. The rest of the course is built there, with
   * the realm's materials.
   */
  portal(): void {
    const { x, y } = this, D: MatId = 'basalt';
    this.floor(x, x + 12, -4, 4, y, { depth: 2 });
    const g = x + 9;
    this.gateFrame(g, y, 0xff3a1a, 0xff5a1a);
    const tp = { type: 'teleporter' as const, ...this.area(g + 0.2, g + 0.8, -2.4, 2.4, y, y + 6), dest: { x: 0, y: 0, z: 0 }, pair: 3, plain: true };
    this.triggers.push(tp);
    this.block(g + 1, x + 12, -4, 4, y + 6.8, D, 0.6); // (a roof over the floor beyond it: nobody walks round the gate)
    this.go(x + 4, y, 0, 'run', { reach: 1.5 });
    this.go(g + 0.5, y, 0, 'run', { reach: 0.4 });
    // ...and over to the realm: far off, the same heading
    const bb = this.bounds();
    this.ox = bb.x1 + 1100; this.oz = (bb.z0 + bb.z1) / 2;
    this.x = 0;
    this.realmFrom = this.floors.length;
    this.section += 10;
    if (this.theme.realm) this.t = { ...this.theme, ...this.theme.realm.t };
    // where you come out: a gate behind you (its fire low and dark), the first checkpoint
    this.gateFrame(-1.2, y, 0x8a1a0a, 0x8a2a10);
    this.checkpoint(14);
    tp.dest = this.pt(1.5, y + 0.02, 0);
  }

  /** A gate of dark stone (u0..u0+1 along the leg, 5 m wide, 7 m high), glowing runes up its posts, a curtain of fire in it. */
  private gateFrame(u0: number, y: number, rune: number, fire: number): void {
    const D: MatId = 'basalt';
    this.block(u0, u0 + 1, -3.6, -2.4, y + 7, D, 7.5); // posts
    this.block(u0, u0 + 1, 2.4, 3.6, y + 7, D, 7.5);
    this.block(u0 - 0.3, u0 + 1.3, -4.4, 4.4, y + 8.2, D, 1.2); // the lintel
    this.block(u0 - 0.1, u0 + 1.1, -2.2, 2.2, y + 9, D, 0.8);
    this.block(u0 - 0.3, u0 + 1.3, -4.4, -2.4, y + 0.4, D, 0.9); // feet
    this.block(u0 - 0.3, u0 + 1.3, 2.4, 4.4, y + 0.4, D, 0.9);
    for (const v of [-3, 3]) {
      for (let k = 0; k < 4; k++) {
        const y0 = y + 1.2 + k * 1.4;
        this.glow(u0 - 0.04, y0, v - 0.22, u0, y0 + 0.5, v + 0.22, rune); // on its front...
        this.glow(u0 + 1, y0, v - 0.22, u0 + 1.04, y0 + 0.5, v + 0.22, rune); // ...and back
      }
    }
    this.glow(u0 - 0.34, y + 7.5, -1.2, u0 - 0.3, y + 7.8, 1.2, rune);
    const a = this.area(u0 + 0.3, u0 + 0.7, -2.4, 2.4, y, y + 7);
    this.life.push({ kind: 'fall', min: a.min, max: a.max, color: fire, speed: 2.5 });
    this.life.push({ kind: 'swarm', center: this.pt(u0 + 0.5, y + 3.5, 0), spread: 2.6, count: 14, colors: [0xff7a1a, 0xffc23a, fire], size: 0.16, glow: true });
  }

  /** Posts 2.5 m square over the lava, 3.5 m apart, up and down and side to side: a run of jumps, no stopping. */
  lavaHops(): void {
    const { x, y } = this;
    const hops: [number, number][] = [[0, 0], [0.8, 1.5], [0.3, -1.5], [1.1, 0], [0.4, 1.8], [1.2, -0.4]]; // [rise, across]
    hops.forEach(([rise, v], k) => {
      const u = x + 3 + 6 * k;
      this.floor(u, u + 2.5, v - 1.25, v + 1.25, y + rise, { mat: this.t.beam });
      this.go(u + 1.25, y + rise, v, 'run', { reach: 0.9, land: true });
    });
    this.x = x + 3 + 6 * hops.length;
    this.y = y + 1.2;
  }

  /**
   * Stones over a pool of lava that sink into it and rise again, one just
   * after another, a wave: set off as the first comes up and keep going.
   */
  sinkers(n = 4): void {
    const { x, y } = this;
    const ms: MoverDef[] = [];
    for (let k = 0; k < n; k++) {
      const u = x + 3 + 6 * k, v = k % 2 ? 1 : -1;
      ms.push(this.mover(u, u + 3, v - 1.5, v + 1.5, y, { dx: 0, dy: -2.6, dz: 0, moveTime: 0.8, waitA: 3, waitB: 1.4, phase: -k * 0.3 }, 0.8));
    }
    this.block(x - 0.5, x + 3 + 6 * n + 0.5, -6, 6, y - 1.7, 'lava', 1, 'deadly'); // the pool
    ms.forEach((m, k) => {
      const u = x + 3 + 6 * k, v = k % 2 ? 1 : -1;
      this.go(u + 1.5, y, v, 'run', { reach: 1, land: true, wait: k === 0 ? (t) => restLeft(m, t, 0) > 2.5 : undefined });
    });
    this.x = x + 3 + 6 * n;
  }

  // ------------------------------------------------------------ the tomb: into a pyramid full of traps
  // Corridors 9 m wide (v -4.5..4.5) and 6 m high, dim and torch-lit, a bed of
  // spikes 3 m under the floor wherever there is no floor. The pyramid itself
  // is built round them at the end (pyramidShell).

  /**
   * A corridor of the tomb along this leg, u0..u1, floor level y: walls (with
   * `open` gaps: side +1 right, -1 left), a ceiling, end walls if asked, the
   * deadly bed of the pits, and the gloom.
   */
  private hall(u0: number, u1: number, y: number, o: { open?: { side: 1 | -1; a: number; b: number }[]; capEnd?: boolean; h?: number; v0?: number; v1?: number } = {}): void {
    const T = 1.2, v0 = o.v0 ?? -4.5, v1 = o.v1 ?? 4.5, top = y + (o.h ?? 6), bot = y - 4, S = this.t.wall;
    for (const side of [1, -1] as const) {
      const gaps = (o.open ?? []).filter((g) => g.side === side).sort((p, q) => p.a - q.a);
      let at = u0;
      for (const g of [...gaps, { a: u1, b: u1 }]) {
        if (g.a > at + 0.01) this.block(at, g.a, side > 0 ? v1 : v0 - T, side > 0 ? v1 + T : v0, top, S, top - bot);
        at = Math.max(at, g.b);
      }
    }
    this.block(u0, u1, v0 - T, v1 + T, top + T, S, T); // the ceiling
    if (o.capEnd) this.block(u1, u1 + T, v0 - T, v1 + T, top + T, S, top + T - bot);
    this.block(u0, u1, v0, v1, y - 3, 'stone', 1, 'deadly'); // the bed of the pits
    this.triggers.push({ type: 'dark', ...this.area(u0 - T - 0.5, u1 + T + 0.5, v0 - 11, v1 + 11, bot - 1, top + T + 0.5), level: 0.72 });
    this.tombHalls.push(this.area(u0, u1 + (o.capEnd ? T : 0), v0 - T, v1 + T, bot, top + T));
  }

  /** A torch on a bracket on the wall (side +1 right, -1 left), 2.6 m up. */
  private wallTorch(u: number, y: number, side: 1 | -1, w = 4.5): void {
    this.block(u - 0.25, u + 0.25, side > 0 ? w - 0.75 : -w, side > 0 ? w : -w + 0.75, y + 2.6, 'stone', 0.3);
    this.block(u - 0.12, u + 0.12, side > 0 ? w - 0.4 : -w, side > 0 ? w : -w + 0.4, y + 2.3, 'stone', 0.6);
    this.life.push({ kind: 'flame', pos: this.pt(u, y + 2.6, side * (w - 0.5)), size: 0.5 });
  }

  /** Spikes standing in a pit, u0..u1 across v0..v1, the bed at y - 3. */
  private spikes(u0: number, u1: number, v0: number, v1: number, y: number): void {
    for (let u = u0 + 0.6; u < u1 - 0.3; u += 1.1) {
      for (let v = v0 + 0.6; v < v1 - 0.3; v += 1.3) {
        const j = ((u * 7.3 + v * 3.1) % 1 + 1) % 1 * 0.4;
        this.block(u - 0.14 + j * 0.2, u + 0.14 + j * 0.2, v - 0.14, v + 0.14, y - 2.1 - j, 'metal', 0.9 - j, 'deadly');
      }
    }
  }

  /** Three pits of spikes across the corridor, 3.5 m each, slabs between. */
  private spikePits(): void {
    const { x, y } = this;
    const slabs = [[0, 4], [7.5, 11], [14.5, 18], [21.5, 26]];
    slabs.forEach(([a, b], k) => {
      this.floor(x + a, x + b, -4.5, 4.5, y, { depth: 2, under: false });
      if (k) this.go(x + (a + b) / 2, y, 0, 'run', { reach: 1.2, land: true });
      if (k < slabs.length - 1) this.spikes(x + b, x + slabs[k + 1][0], -4.5, 4.5, y);
    });
    for (const u of [9.25, 19.75]) { this.wallTorch(x + u, y, 1); this.wallTorch(x + u, y, -1); }
    this.x = x + 26;
  }

  /** Three slabs of stone in the ceiling, slamming down to the floor in turn: run under each while it is up. */
  private crushers(): void {
    const { x, y } = this;
    this.floor(x, x + 30, -4.5, 4.5, y, { depth: 2, under: false });
    ([[5, 0], [14, 1.1], [23, 2.2]] as const).forEach(([du, phase]) => {
      const u = x + du;
      const m = this.mover(u, u + 3, -4.5, 4.5, y + 5.9, { dx: 0, dy: -3.5, dz: 0, moveTime: 0.3, waitA: 2, waitB: 0.5, phase }, 2.4, 'stone');
      this.glow(u, y + 0.01, -4.5, u + 3, y + 0.04, 4.5, 0x5a1a0a); // a dark stain where it lands
      this.go(u - 2.2, y, 0, 'run', { reach: 0.6 });
      this.go(u + 4.5, y, 0, 'run', { reach: 1, wait: (t) => restLeft(m, t, 0) > 1.1 });
    });
    for (const u of [10.5, 19.5]) { this.wallTorch(x + u, y, 1); this.wallTorch(x + u, y, -1); }
    this.x = x + 30;
  }

  /** Two narrow beams over a pit of spikes, the second a step up. */
  private spikeBeams(): void {
    const { x, y } = this;
    this.floor(x, x + 5.5, -0.4, 0.4, y, { mat: this.t.beam, under: false });
    this.floor(x + 7.5, x + 13, -0.4, 0.4, y + 0.5, { mat: this.t.beam, under: false });
    this.spikes(x, x + 13, -4.5, 4.5, y);
    this.go(x + 2, y, 0, 'run', { reach: 0.6 });
    this.go(x + 5, y, 0, 'run', { reach: 0.6 });
    this.go(x + 9.5, y + 0.5, 0, 'run', { reach: 0.6, land: true });
    this.go(x + 12.5, y + 0.5, 0, 'run', { reach: 0.6 });
    this.wallTorch(x + 6.5, y, 1); this.wallTorch(x + 6.5, y, -1);
    this.x = x + 13;
    this.y = y + 0.5;
  }

  /** Bronze blades shooting out of slots in the walls, across the corridor and back: through each while it is in. Returns the slots. */
  private blades(): { side: 1 | -1; a: number; b: number }[] {
    const { x, y } = this;
    this.floor(x, x + 30, -4.5, 4.5, y, { depth: 2, under: false });
    const slots: { side: 1 | -1; a: number; b: number }[] = [];
    ([[6, 1, 0], [15, -1, 0.9], [24, 1, 1.8]] as const).forEach(([du, side, phase]) => {
      const u = x + du;
      // at rest it is in the wall (and the dark beyond it); out, it spans the corridor to the far wall
      const m = this.mover(u, u + 0.4, side > 0 ? 4.55 : -13.55, side > 0 ? 13.55 : -4.55, y + 2.5, { dx: 0, dy: 0, dz: -side * 9.05, moveTime: 0.4, waitA: 1.7, waitB: 0.45, phase }, 2.45, 'metal');
      slots.push({ side, a: u - 0.05, b: u + 0.45 });
      this.glow(u - 0.3, y + 0.01, -4.5, u + 0.7, y + 0.04, 4.5, 0x5a1a0a);
      this.go(u - 2.2, y, 0, 'run', { reach: 0.6 });
      this.go(u + 3, y, 0, 'run', { reach: 1, wait: (t) => restLeft(m, t, 0) > 0.8 });
    });
    for (const u of [10.5, 19.5]) { this.wallTorch(x + u, y, 1); this.wallTorch(x + u, y, -1); }
    this.x = x + 30;
    return slots;
  }

  /**
   * The treasure room: a tall chamber, wider on the left. Stones rise over a
   * pit of spikes to the dais at the back, where the treasure is heaped round
   * a sarcophagus, and its mummy shambles to and fro. The finish is on the dais.
   */
  private treasure(): void {
    const { x, y } = this;
    const L = 40, V0 = -16, V1 = 4.5, H = 11, T = 1.2, S = this.t.wall, bot = y - 4, top = y + H;
    // the chamber
    this.block(x - T, x, V0 - T, -4.5, top + T, S, top + T - bot); // front wall, left of the way in
    this.block(x - T, x, -4.5, V1 + T, top + T, S, top + T - (y + 6)); // over the way in
    this.block(x, x + L, V1, V1 + T, top, S, top - bot); // right wall
    this.block(x, x + L, V0 - T, V0, top, S, top - bot); // left wall
    this.block(x + L, x + L + T, V0 - T, V1 + T, top + T, S, top + T - bot); // back wall
    this.block(x, x + L, V0 - T, V1 + T, top + T, S, T); // ceiling
    this.block(x, x + L, V0, V1, y - 3, 'stone', 1, 'deadly');
    this.triggers.push({ type: 'dark', ...this.area(x - T - 0.5, x + L + T + 0.5, V0 - 6, V1 + 6, bot - 1, top + T + 0.5), level: 0.62 });
    this.tombHalls.push(this.area(x - T, x + L + T, V0 - T, V1 + T, bot, top + T));
    // in: a landing, then stones up over the spikes to the dais
    const D = 24, up = 2.4;
    this.floor(x, x + 5, -4.5, 4.5, y, { depth: 2, under: false });
    [[8, 11, 0.6], [14, 17, 1.2], [20, 23, 1.8]].forEach(([a, b, dy]) => {
      this.floor(x + a, x + b, -1.5, 1.5, y + dy, { under: false });
      this.go(x + (a + b) / 2, y + dy, 0, 'run', { reach: 1, land: true });
    });
    this.spikes(x + 5, x + D, V0, V1, y);
    this.block(x + D, x + L, V0, V1, y + up, 'sandstone', up + 3); // the dais
    this.block(x + D - 0.4, x + D, V0, V1, y + up, 'stone', 0.3); // its lip
    this.glow(x + D - 0.45, y + up - 0.35, V0, x + D - 0.4, y + up - 0.15, V1, 0xffc23a); // a gold band along its edge
    // the sarcophagus, on the left of the dais, lying along the room; its lid gold, a face on it
    const sv0 = -12.5, sv1 = -9, su0 = x + 29, su1 = x + 36;
    this.block(su0 - 0.5, su1 + 0.5, sv0 - 0.5, sv1 + 0.5, y + up + 0.5, 'stone', 0.5);
    this.block(su0, su1, sv0, sv1, y + up + 1.8, 'sandstone', 1.3);
    this.glow(su0 + 0.1, y + up + 1.8, sv0 + 0.1, su1 - 0.1, y + up + 2.0, sv1 - 0.1, 0xe8b030);
    this.glow(su1 - 1.8, y + up + 2.0, sv0 + 0.9, su1 - 0.4, y + up + 2.35, sv1 - 0.9, 0x2a7a9a); // the face (blue and gold)
    this.glow(su1 - 1.6, y + up + 2.35, sv0 + 1.1, su1 - 0.6, y + up + 2.45, sv1 - 1.1, 0xffd860);
    this.glow(su0 + 1, y + up + 2.0, sv0 + 1.3, su1 - 2.4, y + up + 2.1, sv1 - 1.3, 0x2a7a9a); // folded arms
    // the treasure: heaps of gold, chests, urns, along the walls of the dais and down its left side
    const heap = (u: number, v: number, r: number, at = y + up) => {
      for (let k = 0; k < 3; k++) {
        const w = r * (1 - k * 0.3), c = [0xd89a20, 0xffc23a, 0xffe070][k];
        this.glow(u - w, at + k * 0.35, v - w * 0.8, u + w, at + (k + 1) * 0.35, v + w * 0.8, c);
      }
    };
    heap(x + 27, -14, 1.6); heap(x + 33, -14.6, 1.2); heap(x + 38, -12, 1.4); heap(x + 38.4, -6.5, 1.1); heap(x + 38.3, 2.8, 1.2); heap(x + 27.5, 3.3, 0.9);
    heap(x + 10, -13, 1.8, y - 3); heap(x + 16, -14, 1.4, y - 3); // and some down among the spikes, out of reach
    for (const [u, v] of [[x + 30.5, -14.6], [x + 37.6, -9.5], [x + 37.6, 0.8]]) { // chests
      this.block(u - 0.7, u + 0.7, v - 0.5, v + 0.5, y + up + 0.9, 'planks', 0.9);
      this.glow(u - 0.72, y + up + 0.55, v - 0.52, u + 0.72, y + up + 0.65, v + 0.52, 0xffc23a);
      this.glow(u - 0.6, y + up + 0.9, v - 0.4, u + 0.6, y + up + 1.1, v + 0.4, 0xffe070);
    }
    for (const [u, v] of [[x + 25, -15.2], [x + 35.5, -15.2], [x + 25, 3.7]]) { // urns
      this.block(u - 0.35, u + 0.35, v - 0.35, v + 0.35, y + up + 1.1, 'sandstone', 1.1);
      this.glow(u - 0.38, y + up + 0.75, v - 0.38, u + 0.38, y + up + 0.85, v + 0.38, 0xffc23a);
    }
    // pillars at the corners of the dais and down the room, torches on them
    for (const [u, v] of [[x + 6, -12.5], [x + 18, -12.5], [x + D + 1, -15], [x + L - 1, -15]]) {
      this.block(u - 1, u + 1, v - 1, v + 1, top, S, top - bot);
      this.glow(u - 1.02, y + 7, v - 1.02, u + 1.02, y + 7.2, v + 1.02, 0xffc23a);
    }
    for (const u of [x + 6, x + 18]) this.life.push({ kind: 'flame', pos: this.pt(u, y + 4.2, -11.2), size: 0.6 }); // on brackets, facing the room
    for (const u of [x + 6, x + 18]) this.block(u - 0.2, u + 0.2, -11.5, -11.2, y + 4.2, 'stone', 0.3);
    this.wallTorch(x + 4, y, 1); this.wallTorch(x + 12, y, 1); this.wallTorch(x + 20, y, 1);
    // the mummy: up from its sarcophagus, shambling across the dais in front of the treasure
    this.life.push({ kind: 'mummy', a: this.pt(x + 28, y + up, -7.5), b: this.pt(x + 28, y + up, 3), size: 1.05, speed: 0.75 });
    this.x = x + D;
    this.y = y + up;
  }

  /**
   * DUNE TEMPLE's end: up to a door in the face of a great pyramid, in, and
   * through its traps: spike pits, crushing slabs, beams over spikes, blades
   * from the walls; round two corners (a step aside, and on, deeper in) to the
   * treasure room and the finish.
   */
  tomb(): void {
    const { x } = this, Y = this.y + 1, T = 1.2;
    // the porch, outside the door, and the passage in
    this.floor(x + 4, x + 13, -4.5, 4.5, Y, { depth: 2 });
    this.go(x + 8, Y, 0, 'run', { reach: 1.5, land: true });
    const door = x + 13;
    this.floor(door, door + 6, -4.5, 4.5, Y, { depth: 2 });
    this.tombDoor = { ...this.pt(door, Y, 0), fwd: this.dir(1, 0), entry: this.area(door - 0.1, door + 30, -4.5 - T, 4.5 + T, Y - 4, Y + 6 + T) }; // (the hole through the face: the tiers above step back over the passage)
    // a gateway round the door: posts and a lintel, gold-banded
    this.block(door - 1.5, door, -6.9, -4.5, Y + 7.2, 'sandstone', 11.2);
    this.block(door - 1.5, door, 4.5, 6.9, Y + 7.2, 'sandstone', 11.2);
    this.block(door - 1.5, door, -6.9, 6.9, Y + 8.6, 'sandstone', 1.4);
    this.glow(door - 1.52, Y + 7.6, -6.92, door + 0.02, Y + 7.9, 6.92, 0xffc23a);
    this.glow(door - 1.52, Y + 8.0, -1.2, door - 1.5, Y + 8.5, 1.2, 0x2a7a9a); // an eye over the door
    this.glow(door - 1.53, Y + 8.15, -0.35, door - 1.52, Y + 8.35, 0.35, 0xffe070);
    this.life.push({ kind: 'flame', pos: this.pt(door - 2.2, Y + 1.3, -5.7), size: 0.8 });
    this.life.push({ kind: 'flame', pos: this.pt(door - 2.2, Y + 1.3, 5.7), size: 0.8 });
    for (const v of [-5.7, 5.7]) {
      this.block(door - 2.6, door - 1.8, v - 0.4, v + 0.4, Y + 1.3, 'stone', 1.3);
    }
    this.x = door + 6; this.y = Y;
    // leg one: the passage, the spike pits, the crushers, to a corner
    this.checkpoint(); // in the passage
    this.spikePits(); this.checkpoint();
    this.crushers();
    this.hall(door, this.x + 9, Y, { capEnd: true, open: [{ side: 1, a: this.x, b: this.x + 9 }] });
    this.turn(1);
    // leg two: beams over spikes, to another corner
    const b0 = this.x;
    this.spikeBeams();
    this.hall(b0, this.x + 9, Y, { capEnd: true, open: [{ side: -1, a: this.x, b: this.x + 9 }] });
    this.turn(-1);
    // leg three, deeper in (beside leg one): the blades, then the treasure room
    const c0 = this.x;
    const slots = this.blades(); this.checkpoint();
    this.hall(c0, this.x, this.y, { open: slots });
    this.treasure();
    this.finish();
  }

  /**
   * The great pyramid round the tomb, standing on the sand (`ground`), the
   * tomb's door in its face: tiers 4 m high, each 4 m in from the one below,
   * built as hollow rings (only the outside shows), big enough that the tomb's
   * halls sit inside it with room to spare. Called after build() has gone to
   * world coordinates.
   */
  pyramidShell(ground: number): void {
    const d = this.tombDoor;
    if (!d) return;
    const Th = 4, inset = 4, wall = 1.6, margin = 1;
    const ax: 'x' | 'z' = d.fwd.x ? 'x' : 'z', cx: 'x' | 'z' = ax === 'x' ? 'z' : 'x', sg = d.fwd.x || d.fwd.z;
    const tier = (y: number) => Math.max(0, Math.floor((y - ground) / Th));
    const doorA = d[ax] * sg;
    const kb = tier(d.entry.min.y);
    const cross0 = Math.min(...this.tombHalls.map((h) => h.min[cx])), cross1 = Math.max(...this.tombHalls.map((h) => h.max[cx]));
    const cc = (cross0 + cross1) / 2;
    let H0 = 20, ca = 0;
    const fits = () => this.tombHalls.every((h) => {
      const k = tier(h.max.y), half = H0 - k * inset - inset - wall - margin; // inside the ring of that tier
      const a0 = Math.min(h.min[ax] * sg, h.max[ax] * sg), a1 = Math.max(h.min[ax] * sg, h.max[ax] * sg);
      // (the hall in from the door starts at the face: only its far end must be inside)
      return half > 0 && h.min[cx] >= cc - half && h.max[cx] <= cc + half && a1 <= ca + half && (a0 >= ca - half || a0 <= doorA + 0.5);
    });
    for (; H0 < 400; H0 += 1) {
      ca = doorA + (H0 - kb * inset);
      if (fits()) break;
    }
    // (the entry hall starts at the door: the rings it passes through get a hole for it)
    const centre = { [ax]: ca * sg, [cx]: cc } as { x: number; z: number };
    const boxes: { min: Vec3; max: Vec3 }[] = [];
    for (let k = 0; ; k++) {
      const half = H0 - k * inset, y0 = ground + k * Th, y1 = y0 + Th;
      if (half <= 3) { // the cap
        boxes.push({ min: { x: centre.x - half, y: y0, z: centre.z - half }, max: { x: centre.x + half, y: y1, z: centre.z + half } });
        this.glow(centre.x - half - 0.05, y0, centre.z - half - 0.05, centre.x + half + 0.05, y1 + 0.05, centre.z + half + 0.05, 0xffc23a);
        break;
      }
      const inner = half - inset - wall;
      const X0 = centre.x - half, X1 = centre.x + half, Z0 = centre.z - half, Z1 = centre.z + half;
      const x0 = centre.x - inner, x1 = centre.x + inner, z0 = centre.z - inner, z1 = centre.z + inner;
      boxes.push({ min: { x: X0, y: y0, z: Z0 }, max: { x: X1, y: y1, z: z0 } });
      boxes.push({ min: { x: X0, y: y0, z: z1 }, max: { x: X1, y: y1, z: Z1 } });
      boxes.push({ min: { x: X0, y: y0, z: z0 }, max: { x: x0, y: y1, z: z1 } });
      boxes.push({ min: { x: x1, y: y0, z: z0 }, max: { x: X1, y: y1, z: z1 } });
    }
    const hole = d.entry;
    for (const bx of boxes) {
      for (const piece of carve(bx, hole)) this.solids.push(box(piece.min.x, piece.min.y, piece.min.z, piece.max.x, piece.max.y, piece.max.z, 'sandstone'));
    }
    this.keepOff.push({ x0: centre.x - H0 - 4, x1: centre.x + H0 + 4, z0: centre.z - H0 - 4, z1: centre.z + H0 + 4 });
    // Nothing else of the course may be inside it.
    for (const f of this.floors) {
      if (this.tombHalls.some((h) => (f.x0 + f.x1) / 2 > h.min.x && (f.x0 + f.x1) / 2 < h.max.x && (f.z0 + f.z1) / 2 > h.min.z && (f.z0 + f.z1) / 2 < h.max.z && f.y > h.min.y && f.y < h.max.y)) continue;
      if (f.y > ground + 1 && f.y < ground + (H0 / inset) * Th) {
        const half = H0 - tier(f.y) * inset + 1;
        if (f.x1 > centre.x - half && f.x0 < centre.x + half && f.z1 > centre.z - half && f.z0 < centre.z + half) {
          // the porch outside the door touches the face: fine
          const nearDoor = Math.hypot((f.x0 + f.x1) / 2 - d.x, (f.z0 + f.z1) / 2 - d.z) < 12;
          if (!nearDoor) throw new Error(`the pyramid swallows part of the course at x ${f.x0.toFixed(0)} z ${f.z0.toFixed(0)} y ${f.y.toFixed(0)}`);
        }
      }
    }
  }

  // ------------------------------------------------------------ dressing helpers
  /** Neon themes put a glowing sign on the face of every wall you run along. */
  signs: number[] | null = null;
  private signCount = 0;
  /** A billboard along the face of a wall you run on, framed in neon (u0..u1 along it, its face at v = face, beside a floor at y). */
  private wallSign(u0: number, u1: number, face: number, side: 1 | -1, y: number): void {
    if (!this.signs) return;
    const c = this.signs[this.signCount++ % this.signs.length];
    const v0 = Math.min(face - side * 0.02, face - side * 0.07), v1 = Math.max(face - side * 0.02, face - side * 0.07);
    this.screen(u0 + 2, u1 - 2, Math.min(face, face - side * 0.01), Math.max(face, face - side * 0.01), y + 1.8, y + 5.2, 0, -side, this.signCount * 5 + 3);
    this.glow(u0 + 1.6, y + 1.5, v0, u1 - 1.6, y + 1.65, v1, c); // neon tubes under it...
    this.glow(u0 + 1.6, y + 5.35, v0, u1 - 1.6, y + 5.5, v1, c); // ...and over it
  }

  /** Is any other floor below this one, overlapping it? (Then nothing may be built under it.) */
  covered(f: Floor): boolean {
    return this.floors.some((o) => o !== f && o.y < f.y - 0.01 && o.x0 < f.x1 && o.x1 > f.x0 && o.z0 < f.z1 && o.z1 > f.z0);
  }

  build(c: Omit<Course, 'map' | 'checkpoints' | 'route' | 'fallY'>): Course {
    this.checkLayout();
    this.world(); // scenery is placed in world coordinates
    this.t = this.theme;
    const all = this.floors;
    if (this.realmFrom >= 0 && this.theme.realm) {
      // each world dressed on its own: this one, then the realm beyond the portal
      this.floors = all.slice(0, this.realmFrom);
      this.theme.dress(this);
      this.floors = all.slice(this.realmFrom);
      this.keepOff = [];
      this.theme.realm.dress(this);
      this.floors = all;
    } else this.theme.dress(this);
    const lowest = Math.min(...this.floors.map((f) => f.y));
    const fallY = lowest - 10;
    const map: MapDef = {
      name: c.name, seed: 0, solids: this.solids, triggers: this.triggers, decor: this.decor,
      screens: this.screens, traffic: this.traffic, holos: this.holos, life: this.life,
      spawns: this.spawns, pickups: [], bots: [],
      killY: fallY - 200, palette: this.t.palette, extent: 40,
    };
    return { ...c, fallY, map, checkpoints: this.cps, route: this.route };
  }
}

// ================================================================ scenery helpers
/** Spots for scenery: a jittered grid over the course's extent (plus a margin), kept `clear` metres from any floor. */
function spots(b: Builder, r: () => number, step: number, margin: number, clear: number, y?: number): { x: number; z: number }[] {
  const bb = b.bounds(), out: { x: number; z: number }[] = [];
  for (let x = bb.x0 - margin; x < bb.x1 + margin; x += step) {
    for (let z = bb.z0 - margin; z < bb.z1 + margin; z += step) {
      const px = x + (r() - 0.5) * step * 0.8, pz = z + (r() - 0.5) * step * 0.8;
      if (b.clearance(px, pz, y) >= clear) out.push({ x: px, z: pz });
    }
  }
  return out;
}


/** The height of the base of the floor block whose top is `f` (what the theme builds under). */
const baseOf = (b: Builder, f: Floor) => b.solids.find((s) => s.max.y === f.y && s.min.x === f.x0 && s.max.x === f.x1 && s.min.z === f.z0)?.min.y ?? f.y - 1;

// ================================================================ BLOCKLANDS
/**
 * The underrealm, through the gate at the end of BLOCKLANDS: a vast cavern
 * of crimson rock over a sea of lava, in a red haze. Great basalt pillars
 * run from the lava to the roof, falls of lava pour from it, rock hangs down,
 * embers float up and ash drifts by. Every platform hangs on a lump of rock.
 */
function underrealm(b: Builder): void {
  const r = rand(53);
  const f = b.floors, bb = b.bounds();
  const lowest = Math.min(...f.map((q) => q.y)), highest = Math.max(...f.map((q) => q.y));
  const M = 46, X0 = bb.x0 - M, X1 = bb.x1 + M, Z0 = bb.z0 - M, Z1 = bb.z1 + M, sea = lowest - 9, roof = highest + 34, T = 8;
  // the lava sea, the cavern's walls and its roof, and the haze
  b.block(X0, X1, Z0, Z1, sea, 'lava', 3, 'deadly');
  const bottom = sea - 4;
  b.block(X0 - T, X0, Z0 - T, Z1 + T, roof + T, 'ember', roof + T - bottom);
  b.block(X1, X1 + T, Z0 - T, Z1 + T, roof + T, 'ember', roof + T - bottom);
  b.block(X0, X1, Z0 - T, Z0, roof + T, 'ember', roof + T - bottom);
  b.block(X0, X1, Z1, Z1 + T, roof + T, 'ember', roof + T - bottom);
  b.block(X0, X1, Z0, Z1, roof + T, 'basalt', T);
  b.triggers.push({ type: 'dark', min: { x: X0, y: bottom, z: Z0 }, max: { x: X1, y: roof, z: Z1 }, level: 0.5, tint: 0x3a0806 });
  // a lump of rock under every platform, tapering away (like the islands above)
  for (const q of [...f]) {
    if (!q.under || b.covered(q) || q.x1 - q.x0 < 2 || q.z1 - q.z0 < 2) continue;
    let top = baseOf(b, q);
    [[0.4, 'ember'], [1.1, 'basalt'], [1.9, 'ember']].forEach(([inset, mat], i) => {
      const ix = Math.min(inset as number, (q.x1 - q.x0) / 2 - 0.3), iz = Math.min(inset as number, (q.z1 - q.z0) / 2 - 0.3);
      b.block(q.x0 + ix, q.x1 - ix, q.z0 + iz, q.z1 - iz, top, mat as MatId, 1.4 + i * 0.6);
      top -= 1.4 + i * 0.6;
    });
  }
  // great pillars of basalt from the lava to the roof, and rock hanging from it
  for (const p of spots(b, r, 24, M - 10, 12)) {
    const k = r(), w = 2 + r() * 3.5;
    if (k < 0.35) {
      b.block(p.x - w, p.x + w, p.z - w, p.z + w, roof, 'basalt', roof - sea + 1);
      b.block(p.x - w - 1, p.x + w + 1, p.z - w - 1, p.z + w + 1, sea + 2, 'basalt', 2.5); // its foot, spreading in the lava
      if (r() < 0.4) b.glow(p.x - w - 0.05, sea + 3 + r() * 20, p.z - 0.6, p.x - w, sea + 6 + r() * 25, p.z + 0.6, 0xff8a2a); // a seam of fire up its side
    } else if (k < 0.7) { // hanging from the roof, in steps
      let y = roof, ww = w;
      for (let s = 0; s < 3; s++) { const h = 4 + r() * 6; b.block(p.x - ww, p.x + ww, p.z - ww, p.z + ww, y, s % 2 ? 'basalt' : 'ember', h); y -= h; ww *= 0.6; }
    } else if (k < 0.82) { // a fall of lava from the roof
      b.life.push({ kind: 'fall', min: { x: p.x - 1.2, y: sea, z: p.z - 1.2 }, max: { x: p.x + 1.2, y: roof, z: p.z + 1.2 }, color: 0xff6a10, speed: 7 });
      b.block(p.x - 3, p.x + 3, p.z - 3, p.z + 3, sea + 0.6, 'lava', 0.8, 'deadly'); // it splashing into the sea
    } else { // a crag rising out of the lava, crystals glowing on it
      const h = 6 + r() * 14;
      b.block(p.x - w, p.x + w, p.z - w, p.z + w, sea + h, 'ember', h + 1);
      for (let c = 0; c < 3; c++) {
        const cx = p.x + (r() - 0.5) * w * 1.4, cz = p.z + (r() - 0.5) * w * 1.4, ch = 0.8 + r() * 1.6;
        b.glow(cx - 0.25, sea + h, cz - 0.25, cx + 0.25, sea + h + ch, cz + 0.25, [0xff4a2a, 0xffa23a, 0xff2a6a][c]);
      }
    }
  }
  // embers floating up, ash drifting through
  for (let k = 0; k < 10; k++) {
    b.life.push({ kind: 'swarm', center: { x: bb.x0 + r() * (bb.x1 - bb.x0), y: lowest - 2 + r() * 10, z: bb.z0 + r() * (bb.z1 - bb.z0) }, spread: 14, count: 14, colors: [0xff7a1a, 0xffb43a, 0xff3a1a], size: 0.14, glow: true });
  }
  b.life.push({ kind: 'wind', x0: X0, x1: X1, z0: Z0, z1: Z1, y0: lowest - 6, y1: highest + 20, count: 260, color: 0x5a5258, speed: 3 });
}

/** Floating grass islands over a lava sea: stepped earth under every floor, blocky trees, clouds, mountains. */
const BLOCKS: Theme = {
  palette: {
    sky: 0x8cc8ff, fogNear: 90, fogFar: 360, sun: 0xfff4d8, ambientSky: 0xdcefff, ambientGround: 0x5a4a38,
    mats: {
      concrete: '#8d8d8d', concreteDark: '#5c5c5c', tile: '#b08a52', metal: '#7a7a7a', hazard: '#e0b020', ice: '#9cd2f0', conveyor: '#3a3a3a', lava: '#ff6a10',
      grass: '#5da83a', dirt: '#7a5232', stone: '#8a8a8a', planks: '#a77b46', leaves: '#3f8f2c', log: '#6b4a2b', snow: '#eef3f8',
      ember: '#7a2a22', basalt: '#3e3a42',
    },
  },
  floor: 'dirt', cap: 'grass', checkpoint: 'planks', finish: 'hazard', wall: 'stone', beam: 'planks', accent: 'planks',
  mover: 'planks', tower: 'log', spiral: 'leaves',
  realm: { t: { floor: 'ember', cap: undefined, checkpoint: 'basalt', finish: 'hazard', wall: 'basalt', beam: 'basalt', accent: 'ember', mover: 'basalt', tower: 'basalt', spiral: 'ember' }, dress: underrealm },
  /**
   * A giant tree, the spiral climbing its leafy boughs. The trunk keeps to the
   * old tower's 2.5 m through the height of the steps, flaring into roots on a
   * lump of earth below them. Every step is a pad of leaves at the end of a
   * branch out of the trunk, the branch slanting up under it. Above the steps,
   * thick boughs hold up a broad, rounded crown.
   */
  statue(b, cx, y) {
    const L = 'log', F = 'leaves';
    const box = (x0: number, x1: number, z0: number, z1: number, top: number, mat: MatId, h: number) => b.block(cx + x0, cx + x1, z0, z1, top, mat, h);
    // the trunk, a touch narrower up high, and the roots and earth below the steps
    box(-2.4, 2.4, -2.4, 2.4, y + 8, L, 12.4); // down to the earth
    box(-2.1, 2.1, -2.1, 2.1, y + 18, L, 10);
    box(-3.4, 3.4, -1.2, 1.2, y - 1.4, L, 3); // roots, splayed out both ways
    box(-1.2, 1.2, -3.4, 3.4, y - 1.4, L, 3);
    box(-4.2, -3.2, -0.8, 0.8, y - 2.4, L, 3); box(3.2, 4.2, -0.8, 0.8, y - 2.4, L, 3);
    box(-0.8, 0.8, -4.2, -3.2, y - 2.4, L, 3); box(-0.8, 0.8, 3.2, 4.2, y - 2.4, L, 3);
    box(-5, 5, -5, 5, y - 4.4, 'grass', 0.4);
    box(-5, 5, -5, 5, y - 4.8, 'dirt', 2);
    box(-3.5, 3.5, -3.5, 3.5, y - 6.8, 'stone', 2.5);
    box(-2, 2, -2, 2, y - 9.3, 'stone', 2);
    // a branch out to every step: a run of blocks from the trunk, slanting up to just under the leaves
    for (const s of Builder.spiralSteps(0, y)) {
      const n = 6;
      for (let k = 0; k <= n; k++) {
        const t = k / n, rr = 2.1 + t * 4.2;
        const px = Math.cos(s.a) * rr, pz = Math.sin(s.a) * rr;
        const top = s.top - 1.9 + t * 1.6, hw = 0.45 - t * 0.1;
        box(px - hw, px + hw, pz - hw, pz + hw, top, L, 0.8);
      }
    }
    // the crown: boughs out of the top of the trunk, each ending in a clump of leaves, then the canopy over them
    const crown = y + 18;
    for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      for (let k = 1; k <= 4; k++) box(dx * k * 1.1 - 0.5, dx * k * 1.1 + 0.5, dz * k * 1.1 - 0.5, dz * k * 1.1 + 0.5, crown - 3 + k * 0.7, L, 1);
      box(dx * 5.4 - 2.2, dx * 5.4 + 2.2, dz * 5.4 - 2.2, dz * 5.4 + 2.2, crown + 1.5, F, 2.5);
    }
    box(-6.5, 6.5, -6.5, 6.5, crown + 3, F, 2);
    box(-8, 8, -4.5, 4.5, crown + 2.6, F, 1.4);
    box(-4.5, 4.5, -8, 8, crown + 2.6, F, 1.4);
    box(-5.5, 5.5, -5.5, 5.5, crown + 5, F, 2);
    box(-3.5, 3.5, -3.5, 3.5, crown + 6.5, F, 1.5);
    box(-1.5, 1.5, -1.5, 1.5, crown + 7.3, F, 0.8);
  },
  dress(b) {
    const r = rand(11);
    const lowest = Math.min(...b.floors.map((f) => f.y));
    // Every island hangs over the void on a stepped lump of earth and rock.
    for (const f of [...b.floors]) {
      if (!f.under || b.covered(f) || f.x1 - f.x0 < 2 || f.z1 - f.z0 < 2) continue;
      let top = baseOf(b, f);
      [[0.4, 'dirt'], [1.2, 'stone'], [2, 'stone']].forEach(([inset, mat], i) => {
        const ix = Math.min(inset as number, (f.x1 - f.x0) / 2 - 0.3), iz = Math.min(inset as number, (f.z1 - f.z0) / 2 - 0.3);
        b.block(f.x0 + ix, f.x1 - ix, f.z0 + iz, f.z1 - iz, top, mat as MatId, 1.5 + i * 0.5);
        top -= 1.5 + i * 0.5;
      });
    }
    // Islands with a tree and flowers, off the course.
    for (const p of spots(b, r, 26, 30, 13)) {
      if (r() < 0.35) continue;
      const y = b.y0 + (r() - 0.5) * 30, w = 3 + Math.floor(r() * 3);
      const { x, z } = p;
      b.block(x - w, x + w, z - w, z + w, y, 'grass', 0.3);
      b.block(x - w, x + w, z - w, z + w, y - 0.3, 'dirt', 2);
      b.block(x - w + 1, x + w - 1, z - w + 1, z + w - 1, y - 2.3, 'stone', 2.5);
      const tx = x + Math.round((r() - 0.5) * (w - 2)), tz = z + Math.round((r() - 0.5) * (w - 2)), h = 4 + Math.floor(r() * 3);
      b.block(tx - 0.5, tx + 0.5, tz - 0.5, tz + 0.5, y + h, 'planks', h);
      b.block(tx - 2.5, tx + 2.5, tz - 2.5, tz + 2.5, y + h + 1, 'leaves', 3);
      b.block(tx - 1.5, tx + 1.5, tz - 1.5, tz + 1.5, y + h + 2, 'leaves', 1);
      for (let k = 0; k < 3; k++) {
        const fx = x + (r() - 0.5) * (w * 2 - 1), fz = z + (r() - 0.5) * (w * 2 - 1);
        b.glow(fx - 0.15, y, fz - 0.15, fx + 0.15, y + 0.35, fz + 0.15, [0xff4a4a, 0xffe14a, 0xffffff][k]);
      }
      // A spring at one edge, pouring off the island into the void.
      if (r() < 0.45) {
        const side = r() < 0.5 ? -1 : 1, ex = x + side * w;
        b.glow(Math.min(ex, ex - side * 2), y - 0.25, z - 0.8, Math.max(ex, ex - side * 2), y + 0.02, z + 0.8, 0x3a8aff);
        b.life.push({ kind: 'fall', min: { x: Math.min(ex, ex + side * 0.5), y: y - 34, z: z - 0.8 }, max: { x: Math.max(ex, ex + side * 0.5), y: y + 0.02, z: z + 0.8 }, color: 0x5aa8ff, speed: 9 });
      }
      // Butterflies round the tree, and an animal or two wandering along the edge.
      if (r() < 0.6) b.life.push({ kind: 'swarm', center: { x, y: y + 1.2, z }, spread: w, count: 6, colors: [0xffffff, 0xffe14a, 0xff8ad0, 0x8ad8ff], size: 0.35 });
      if (w >= 4 && r() < 0.7) {
        const colors = [[0xf2b8b0], [0xf0f0ea], [0x7a4e30], [0x3a3a3a, 0xf0f0ea]][Math.floor(r() * 4)];
        b.life.push({ kind: 'walkers', a: { x: x - w + 1, y, z: z + w - 1 }, b: { x: x + w - 1, y, z: z + w - 1 }, count: 1 + Math.floor(r() * 2), gap: 2.2, shape: 'beast', colors, size: 0.7, speed: 0.8 });
      }
    }
    // Birds circling over the course.
    const bb0 = b.bounds();
    for (let k = 0; k < 5; k++) {
      b.life.push({ kind: 'flock', center: { x: bb0.x0 + r() * (bb0.x1 - bb0.x0), y: b.y0 + 22 + r() * 14, z: bb0.z0 + r() * (bb0.z1 - bb0.z0) }, radius: 18 + r() * 20, count: 6 + Math.floor(r() * 5), color: 0x2a2a2a, size: 0.8, speed: 7 });
    }
    // Clouds drifting by above, blocky mountains all round (lava pouring down some), the lava sea far below.
    const bb = b.bounds();
    const clouds: { x: number; y: number; z: number; w: number; d: number }[] = [];
    for (const p of spots(b, r, 40, 140, 0)) {
      if (r() < 0.5) continue;
      clouds.push({ x: p.x, y: b.y0 + 45 + r() * 25, z: p.z, w: 12 + r() * 16, d: 8 + r() * 10 });
    }
    b.life.push({ kind: 'clouds', x0: bb.x0 - 160, x1: bb.x1 + 160, boxes: clouds, speed: 2.2 });
    // Mountains all round, out of the lava sea: blocky, but shaped like mountains. Each is a field of
    // columns 9 m square, stepped in 3 m terraces: an uneven outline, ridges, a second lower peak; grass
    // on the lower slopes, bare rock above, snow on the tall ones. Some are volcanoes: a crater of lava
    // at the top and a stream of it running down the terraces towards the course.
    const sea = lowest - 40, C = 9, STEP = 3;
    for (let k = 0; k < 15; k++) {
      const a = (k / 15) * Math.PI * 2 + r() * 0.2, rad = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2 + 150 + r() * 80;
      const mx = (bb.x0 + bb.x1) / 2 + Math.cos(a) * rad, mz = (bb.z0 + bb.z1) / 2 + Math.sin(a) * rad;
      const R = 42 + r() * 28, H = R * (0.95 + r() * 0.45), volcano = k % 5 === 2; // slopes of about 45 degrees: broad, not needles
      const p1 = r() * 6.3, p2 = r() * 6.3, sa = r() * 6.3; // the outline's wobble, where the second peak is
      const sx = mx + Math.cos(sa) * R * 0.55, sz = mz + Math.sin(sa) * R * 0.55;
      const toward = Math.atan2((bb.z0 + bb.z1) / 2 - mz, (bb.x0 + bb.x1) / 2 - mx); // the face looking at the course
      const height = (x: number, z: number) => {
        const th = Math.atan2(z - mz, x - mx);
        const reach = R * (1 + 0.22 * Math.sin(3 * th + p1) + 0.12 * Math.sin(5 * th + p2));
        const t = Math.hypot(x - mx, z - mz) / reach, t2 = Math.hypot(x - sx, z - sz) / (R * 0.6);
        let h = Math.max(t < 1 ? H * (1 - t) ** 1.1 : 0, t2 < 1 ? H * 0.6 * (1 - t2) ** 1.1 : 0);
        if (volcano) h = Math.min(h, H * 0.8); // a flat top for its crater
        if (h > 0) h += (hash2(x, z, k) - 0.5) * 5;
        return h > 1 ? Math.round(h / STEP) * STEP : 0;
      };
      const n = Math.ceil((R * 1.4) / C);
      for (let i = -n; i <= n; i++) {
        for (let j = -n; j <= n; j++) {
          const x = mx + i * C, z = mz + j * C, h = height(x, z);
          if (!h) continue;
          // the lowest neighbour: the column only has to come down to there (below, the others hide it)
          const low = Math.min(...[[C, 0], [-C, 0], [0, C], [0, -C]].map(([dx, dz]) => height(x + dx, z + dz)));
          const top = sea + h, f = h / H;
          const d = Math.hypot(x - mx, z - mz), th = Math.atan2(z - mz, x - mx);
          const crater = volcano && h >= H * 0.8 - STEP && d < R * 0.22;
          const stream = volcano && Math.abs(Math.sin(th - toward)) * d < C * 0.6 && Math.cos(th - toward) > 0;
          const cap: MatId = crater || stream ? 'lava' : !volcano && f > 0.62 && H > 50 ? 'snow' : f > 0.4 ? 'stone' : 'grass';
          const ct = crater ? top - STEP : top;
          b.block(x - C / 2, x + C / 2, z - C / 2, z + C / 2, ct, cap, cap === 'lava' ? 0.6 : STEP);
          const under = cap === 'grass' ? 'dirt' : 'stone';
          const body = ct - (cap === 'lava' ? 0.6 : STEP), foot = Math.min(sea + low - STEP, body) - 1;
          if (body > foot) b.block(x - C / 2, x + C / 2, z - C / 2, z + C / 2, body, under, body - Math.max(foot, sea - 1));
        }
      }
    }
    b.block(bb.x0 - 400, bb.x1 + 400, bb.z0 - 400, bb.z1 + 400, lowest - 40, 'lava', 2, 'deadly');
  },
};

function blocklands(): Course {
  const b = new Builder(BLOCKS, 70);
  b.start();
  b.stones([0, 0, 0]); b.checkpoint();
  b.crawlPad(); b.checkpoint(); // a mine tunnel
  b.turn(1);
  b.stones([1, 2, 3]); b.checkpoint(); // up the hill
  b.slalom(); b.checkpoint();
  b.turn(-1);
  b.drop(7); b.checkpoint(); // a leap into the valley
  b.stones([0, 0, 0, 0], true); b.checkpoint(); // over lava
  b.hurdles(); b.checkpoint(); // fences
  b.turn(-1);
  b.spiral(); b.checkpoint(); // round a giant tree
  b.padIslands(); b.checkpoint();
  b.turn(1);
  b.cascade(4); b.checkpoint(); // down the cliffs
  b.movingStones(); b.checkpoint(); // floating logs
  b.turn(1);
  b.ferryLift(); b.checkpoint(); // a raft and a lift
  b.stones([0.5, 1, 0.5, 0]); b.checkpoint();
  b.turn(-1);
  b.boostLeap(); b.checkpoint();
  b.turn(-1);
  b.stones([1, 2, 3]); b.checkpoint(); // up again
  b.padIslands(); b.checkpoint();
  b.drop(6); b.checkpoint();
  b.slalom(); b.checkpoint();
  b.turn(1);
  b.hurdles(); b.checkpoint();
  b.movingStones(); b.checkpoint();
  b.pillars(); b.checkpoint(); // fence posts
  b.portal(); // through the gate of fire, into the underrealm: harder from here
  b.lavaHops(); b.checkpoint();
  b.wallruns([1, -1, 1]); b.checkpoint(); // three walls of basalt
  b.sinkers(); b.checkpoint(); // stones sinking into the lava
  b.turn(1);
  b.beamsBoost(); b.checkpoint();
  b.chimney(); b.checkpoint();
  b.movingStones(4); b.checkpoint();
  b.turn(-1);
  b.slalom(7); b.checkpoint();
  b.sweepers(); b.checkpoint();
  b.pillars(); b.finish();
  return b.build({ id: 'blocklands', name: 'BLOCKLANDS', difficulty: 'EASY',
    blurb: 'A blocky world of floating grass islands over a lava sea, winding through a mine, over lava and fences, up a giant tree, down cliffs and across floating logs, then through a gate of fire into the underrealm, where it gets harder.' });
}

// ================================================================ DUNE TEMPLE
/** Sandstone temple ruins in the desert at golden hour: columns down to the sand, pyramids and dunes. */
const DUNES: Theme = {
  palette: {
    sky: 0xf4c890, fogNear: 80, fogFar: 340, sun: 0xffd8a0, ambientSky: 0xffe2b8, ambientGround: 0x7a5a38,
    mats: {
      concrete: '#c8a874', concreteDark: '#8a6a44', tile: '#2fa39a', metal: '#a07040', hazard: '#e0b020', ice: '#a8d8e0', conveyor: '#4a3a2a', lava: '#ff7a1a',
      sand: '#e2c48c', sandstone: '#d7b479', stone: '#b39466', planks: '#8a5a30', leaves: '#5a8a2a',
    },
  },
  floor: 'sandstone', checkpoint: 'tile', finish: 'hazard', wall: 'sandstone', beam: 'stone', accent: 'stone',
  mover: 'stone', tower: 'sandstone', spiral: 'stone',
  /**
   * A giant guardian statue, jackal-headed, the spiral winding round it. It looks
   * back down the course (towards -u, where the runners come from). Within the
   * height of the steps it keeps to the old tower's 2.5 m: a robed body with its
   * arms folded across the chest. Below the steps it stands on a plinth; above
   * them the shoulders broaden and the head rises, snout out, ears up. In its
   * right hand a tall staff with a fire burning on top.
   */
  statue(b, cx, y) {
    const S = 'sandstone', D = 'stone';
    const box = (u0: number, u1: number, v0: number, v1: number, top: number, depth: number, mat: MatId) => b.block(cx + u0, cx + u1, v0, v1, top, mat, depth);
    const gold = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number) => b.glow(cx + u0, y + y0, v0, cx + u1, y + y1, v1, 0xffc83a);
    // the plinth, stepped, below the first step
    box(-4.5, 4.5, -4.5, 4.5, y - 2, 30, D);
    box(-3.6, 3.6, -3.6, 3.6, y - 1.2, 0.8, S);
    // feet, peeking out from under the robe
    box(-3, -2.3, -1.6, -0.3, y - 0.7, 0.5, S);
    box(-3, -2.3, 0.3, 1.6, y - 0.7, 0.5, S);
    // the robe, a little narrower going up, a gold hem and belt
    box(-2.3, 2.3, -2.3, 2.3, y + 5, 6.2, S);
    gold(-2.35, 2.35, -2.35, 2.35, -1.15, -0.85);
    box(-2.0, 2.0, -2.1, 2.1, y + 8.5, 3.5, S);
    gold(-2.1, 2.1, -2.2, 2.2, 8.3, 8.8);
    // the torso, arms folded across the chest (forearms crossed in front)
    box(-1.8, 1.8, -2.2, 2.2, y + 14, 5.5, S);
    box(-2.4, -1.8, -2.2, 2.2, y + 12.6, 0.9, D);
    box(-2.45, -1.8, -0.4, 0.4, y + 13.4, 2.2, D);
    // shoulders broaden once clear of the steps, a gold collar on them
    box(-2.2, 2.2, -3.8, 3.8, y + 16, 2, S);
    gold(-2.3, 2.3, -3.2, 3.2, 15.4, 16.05);
    // upper arms down the sides, above the top step's headroom
    box(-1.2, 1.2, -4.2, -3.4, y + 16, 1.6, S);
    box(-1.2, 1.2, 3.4, 4.2, y + 16, 1.6, S);
    // the neck and the jackal head: a long snout looking down the course, tall ears
    box(-0.9, 0.9, -0.9, 0.9, y + 17.2, 1.2, S);
    box(-1.6, 1.6, -1.5, 1.5, y + 20, 2.8, D);
    box(-4.0, -1.6, -0.7, 0.7, y + 19, 1.2, D);
    box(-4.3, -3.6, -0.5, 0.5, y + 18.6, 0.5, D);
    box(-0.6, 0.6, -1.4, -0.6, y + 23, 3, D);
    box(-0.6, 0.6, 0.6, 1.4, y + 23, 3, D);
    gold(-1.65, -1.6, -1.1, -0.6, 19.2, 19.6); // eyes, glowing
    gold(-1.65, -1.6, 0.6, 1.1, 19.2, 19.6);
    // the headdress falling to the shoulders, striped gold
    box(-0.4, 1.8, -1.9, -1.5, y + 19.8, 3.4, S);
    box(-0.4, 1.8, 1.5, 1.9, y + 19.8, 3.4, S);
    gold(-0.45, 1.85, -1.95, -1.45, 17.4, 17.7);
    gold(-0.45, 1.85, 1.45, 1.95, 17.4, 17.7);
    // the staff in the right hand: from the plinth to well above the head, a fire on top
    box(-0.15, 0.15, 3.85, 4.15, y + 25, 27, D);
    gold(-0.4, 0.4, 3.6, 4.4, 25, 25.8);
    const top = b.pt(cx, y + 25.8, 4);
    b.life.push({ kind: 'flame', pos: top, size: 1.6 });
  },
  dress(b) {
    const r = rand(23);
    const lowest = Math.min(...b.floors.map((f) => f.y));
    const ground = lowest - 26;
    b.pyramidShell(ground); // the great pyramid round the tomb at the end (the scenery keeps off it)
    const inTomb = (x: number, z: number, y: number) => b.tombHalls.some((h) => x > h.min.x && x < h.max.x && z > h.min.z && z < h.max.z && y > h.min.y && y < h.max.y);
    // Gold capping the obelisks the spirals climb, and a fire burning on top.
    for (const t of b.towers) {
      b.glow(t.x - 1.5, t.top, t.z - 1.5, t.x + 1.5, t.top + 2, t.z + 1.5, 0xffc23a);
      b.life.push({ kind: 'flame', pos: { x: t.x, y: t.top + 2, z: t.z }, size: 2.2 });
    }
    // Braziers burning beside every other checkpoint, each on a short post on its own little floating plinth.
    let n = 0;
    for (const t of b.triggers) {
      if (t.type !== 'checkpoint' || n++ % 2 || inTomb((t.min.x + t.max.x) / 2, (t.min.z + t.max.z) / 2, t.min.y + 1)) continue; // (the tomb has torches of its own)
      const y = t.min.y;
      // the platform the checkpoint is on, and two of its corners, the torches set off them diagonally with a gap
      const cx = (t.min.x + t.max.x) / 2, cz = (t.min.z + t.max.z) / 2;
      const f = b.floors.find((q) => Math.abs(q.y - y) < 0.05 && cx > q.x0 && cx < q.x1 && cz > q.z0 && cz < q.z1) ?? { x0: t.min.x, x1: t.max.x, z0: t.min.z, z1: t.max.z };
      const clear = (px: number, pz: number) => !b.solids.some((q) => q.max.x > px - 1.6 && q.min.x < px + 1.6 && q.max.z > pz - 1.6 && q.min.z < pz + 1.6 && q.max.y > y - 3 && q.min.y < y + 3);
      const spots2: number[][] = [];
      for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        if (spots2.length === 2) break;
        const at = [2.6, 2.1, 1.6].map((g) => [sx < 0 ? f.x0 - g : f.x1 + g, sz < 0 ? f.z0 - g : f.z1 + g]).find(([px, pz]) => clear(px, pz));
        if (at) spots2.push(at);
      }
      for (const [px, pz] of spots2) {
        b.block(px - 0.85, px + 0.85, pz - 0.85, pz + 0.85, y - 0.2, 'stone', 0.35); // the plinth: a capstone,
        b.block(px - 0.7, px + 0.7, pz - 0.7, pz + 0.7, y - 0.55, 'sandstone', 0.9); // a block,
        b.block(px - 0.45, px + 0.45, pz - 0.45, pz + 0.45, y - 1.45, 'sandstone', 0.7); // tapering away below
        b.block(px - 0.2, px + 0.2, pz - 0.2, pz + 0.2, y - 2.15, 'stone', 0.5);
        b.glow(px - 0.72, y - 0.75, pz - 0.72, px + 0.72, y - 0.6, pz + 0.72, 0xffc23a); // a gold band round it
        b.block(px - 0.35, px + 0.35, pz - 0.35, pz + 0.35, y + 1.1, 'sandstone', 1.3); // the post
        b.block(px - 0.6, px + 0.6, pz - 0.6, pz + 0.6, y + 1.3, 'stone', 0.2);
        b.life.push({ kind: 'flame', pos: { x: px, y: y + 1.3, z: pz }, size: 0.75 });
      }
    }
    // Vultures wheeling high overhead.
    const bv = b.bounds();
    // (where the aliens are building their pyramid: see below)
    const site = { x: (bv.x0 + bv.x1) / 2, y: ground, z: bv.z0 - 130 };
    const B = 8, base = 17, half = (base * B) / 2;
    const offSite = (x: number, z: number, m: number) => Math.abs(x - site.x) > half + m || Math.abs(z - site.z) > half + m;
    for (let k = 0; k < 4; k++) {
      b.life.push({ kind: 'flock', center: { x: bv.x0 + r() * (bv.x1 - bv.x0), y: b.y0 + 45 + r() * 15, z: bv.z0 + r() * (bv.z1 - bv.z0) }, radius: 30 + r() * 25, count: 3 + Math.floor(r() * 3), color: 0x2a1a10, size: 1.3, speed: 6 });
    }
    // Gusts of sand blowing across, under the course (never through your face).
    for (let k = 0; k < 5; k++) {
      const cz = bv.z0 + r() * (bv.z1 - bv.z0);
      b.life.push({ kind: 'wind', x0: bv.x0 - 80, x1: bv.x1 + 80, z0: cz - 25, z1: cz + 25, y0: Math.min(...b.floors.map((f) => f.y)) - 22, y1: Math.min(...b.floors.map((f) => f.y)) - 4, count: 160, color: 0xf2dcaa, speed: 16 });
    }
    // The desert: the floor, then dunes, broken columns and palms off the course, pyramids all round.
    const bb = b.bounds();
    b.block(bb.x0 - 400, bb.x1 + 400, bb.z0 - 400, bb.z1 + 400, ground, 'sand', 4);
    for (const p of spots(b, r, 22, 60, 10)) {
      const { x, z } = p, k = r();
      if (!offSite(x, z, 50)) continue;
      if (k < 0.4) {
        const w = 8 + r() * 10;
        b.block(x - w, x + w, z - w * 0.6, z + w * 0.6, ground + 2 + r() * 2, 'sand', 3);
        b.block(x - w * 0.6, x + w * 0.6, z - w * 0.35, z + w * 0.35, ground + 4 + r() * 2, 'sand', 3);
      } else if (k < 0.7) {
        const h = 6 + r() * 16;
        b.block(x - 1.2, x + 1.2, z - 1.2, z + 1.2, ground + h, 'sandstone', h);
        if (h > 15 && r() < 0.5) b.life.push({ kind: 'fall', min: { x: x + 1.2, y: ground, z: z - 0.4 }, max: { x: x + 1.5, y: ground + h, z: z + 0.4 }, color: 0xe2c48c, speed: 4 }); // sand pouring off the top
      } else {
        const h = 7 + r() * 4;
        b.block(x - 0.4, x + 0.4, z - 0.4, z + 0.4, ground + h, 'planks', h);
        b.block(x - 3, x + 3, z - 0.8, z + 0.8, ground + h + 0.6, 'leaves', 0.8);
        b.block(x - 0.8, x + 0.8, z - 3, z + 3, ground + h + 0.6, 'leaves', 0.8);
      }
    }
    // Aliens building a giant pyramid out in the desert, beside the course: saucers fly the blocks in
    // from a stockpile, a mothership looks on, little green figures walk the site.
    b.life.push({ kind: 'pyramidWorks', center: site, block: B, base, prebuilt: 5, saucers: 8 });
    for (const [ax, az, bx2, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      const o = half + 6;
      b.life.push({ kind: 'walkers', a: { x: site.x + ax * o, y: ground, z: site.z + az * o }, b: { x: site.x + bx2 * o, y: ground, z: site.z + bz * o }, count: 3, gap: 2.5, shape: 'alien', colors: [0x6aff6a, 0x9aff3a, 0x4ae8a0], size: 1, speed: 1.2 });
    }
    b.life.push({ kind: 'walkers', a: { x: site.x + half + 22, y: ground, z: site.z + 2 }, b: { x: site.x + half + 40, y: ground, z: site.z + 2 }, count: 4, gap: 2, shape: 'alien', colors: [0x6aff6a, 0x9aff3a], size: 1, speed: 1.6 });
    // Camel caravans plodding across the sand, well away from the course (and the aliens).
    for (const [z, x0, x1] of [[bv.z1 + 70, bv.x0, bv.x1], [bv.z0 - 235, bv.x1, bv.x0]]) {
      b.life.push({ kind: 'walkers', a: { x: x0, y: ground, z }, b: { x: x1, y: ground, z }, count: 6, gap: 4.5, shape: 'camel', colors: [0xc8a070, 0xb08a5a, 0xd8b888], size: 1.3, speed: 1.6 });
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.4, rad = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2 + 120 + r() * 60;
      const px = (bb.x0 + bb.x1) / 2 + Math.cos(a) * rad, pz = (bb.z0 + bb.z1) / 2 + Math.sin(a) * rad, sz = 30 + r() * 30;
      if (Math.hypot(px - site.x, pz - site.z) < sz + half + 40) continue; // not on top of the aliens' site
      for (let s = 0; s < 8; s++) {
        const w = sz * (1 - s / 8);
        b.block(px - w, px + w, pz - w, pz + w, ground + (s + 1) * sz / 7, 'sandstone', sz / 7);
      }
    }
  },
};

function duneTemple(): Course {
  const b = new Builder(DUNES, 70);
  b.start();
  b.stones([0, 0.5, 1]); b.checkpoint(); // broken columns
  b.wallruns([1]); b.checkpoint(); // along the temple wall
  b.turn(-1);
  b.hurdles(); b.checkpoint(); // fallen columns and a lintel
  b.chimney(); b.checkpoint(); // up a temple shaft...
  b.chimney(); b.checkpoint(); // ...and up again
  b.turn(1);
  b.drop(8); b.checkpoint(); // off the temple roof
  b.sweepers(); b.checkpoint(); // sliding stone blocks
  b.turn(1);
  b.spiral(); b.checkpoint(); // round an obelisk
  b.boostLeap(); b.checkpoint();
  b.slalom(); b.checkpoint();
  b.turn(-1);
  b.padIslands(); b.checkpoint();
  b.movingStones(); b.checkpoint(); // sliding slabs
  b.turn(-1);
  b.cascade(3); b.checkpoint(); // down the terraces
  b.wallruns([-1, 1]); b.checkpoint();
  b.turn(1);
  b.stones([0, 0.6, 1.2, 0.6]); b.checkpoint();
  b.turn(1);
  b.ferryLift(); b.checkpoint(); // a stone raft and a lift
  b.padsWallrun(); b.checkpoint(); // up and along the great wall
  b.drop(8); b.checkpoint();
  b.cascade(2); b.checkpoint();
  b.turn(-1);
  b.hurdles(); b.checkpoint();
  b.slalom(); b.checkpoint();
  b.pillars(); b.checkpoint(); // column tops
  b.tomb(); // into the great pyramid: traps, and the treasure room
  return b.build({ id: 'dunetemple', name: 'DUNE TEMPLE', difficulty: 'MEDIUM',
    blurb: 'Sandstone ruins over the desert at golden hour: wall runs along the temple, two shafts to climb, a leap off the roof, sliding stone blocks, a spiral round a guardian statue, terraces down, and at the end into a great pyramid full of traps, to the treasure room and its mummy.' });
}

// ================================================================ NEON SPRAWL
const NEON = [0xff2e88, 0x2ee8ff, 0xffd23a, 0x9a5aff, 0x3aff9a];

/**
 * A neon megacity at night. Glass towers under every floor with neon running
 * up their corners; round the course a skyline of stepped skyscrapers with
 * neon roof lines, antenna spires with red lights, digital billboards facing
 * the course, tall glyph signs, elevated highways full of moving lights,
 * holograms turning in the sky and a purple haze over it all.
 */
const CITY: Theme = {
  palette: {
    sky: 0x1c0b34, fogNear: 45, fogFar: 300, sun: 0xd0a0ff, ambientSky: 0xb080ff, ambientGround: 0x381040,
    mats: {
      concrete: '#2e3346', concreteDark: '#1a1c28', tile: '#3a2266', metal: '#46557a', hazard: '#ff2e88', ice: '#2a6a9a', conveyor: '#22242e', lava: '#ff3a8a',
      glass: '#ffd890', panel: '#2ee8ff', panelAlt: '#ff2e88',
    },
  },
  // Floors of dark glossy panels with glowing seams: cyan on the course, magenta on the checkpoints.
  floor: 'panel', checkpoint: 'panelAlt', finish: 'hazard', wall: 'concreteDark', beam: 'panel', accent: 'hazard',
  mover: 'panelAlt', tower: 'glass', spiral: 'panel',
  dress(b) {
    const r = rand(37);
    const pick = () => NEON[Math.floor(r() * NEON.length)];
    const lowest = Math.min(...b.floors.map((f) => f.y));
    const street = lowest - 70;
    let style = 0;

    /** Neon along the four top edges of a box (a roof line), and maybe up its corners. */
    const outline = (x0: number, x1: number, z0: number, z1: number, y: number, c: number, corners: number) => {
      const t = 0.18;
      b.glow(x0 - t, y - t, z0 - t, x1 + t, y, z0, c);
      b.glow(x0 - t, y - t, z1, x1 + t, y, z1 + t, c);
      b.glow(x0 - t, y - t, z0, x0, y, z1, c);
      b.glow(x1, y - t, z0, x1 + t, y, z1, c);
      if (corners > 0) {
        const h = Math.min(corners, y - street);
        for (const [cx, cz] of [[x0, z0], [x1, z1], [x0, z1], [x1, z0]].slice(0, 2 + Math.floor(r() * 3))) {
          b.glow(cx - t, y - h, cz - t, cx + t, y, cz + t, c);
        }
      }
    };

    /** Which face of a box looks most towards the course? */
    const faceTo = (x: number, z: number): '+x' | '-x' | '+z' | '-z' => {
      let best = { d: Infinity, x: 0, z: 0 };
      for (const f of b.floors) {
        const px = Math.max(f.x0, Math.min(x, f.x1)), pz = Math.max(f.z0, Math.min(z, f.z1));
        const d = Math.hypot(px - x, pz - z);
        if (d < best.d) best = { d, x: px - x, z: pz - z };
      }
      return Math.abs(best.x) > Math.abs(best.z) ? (best.x > 0 ? '+x' : '-x') : (best.z > 0 ? '+z' : '-z');
    };

    /** A billboard on a face of the box x0..x1, z0..z1, between heights y0 and y1. */
    const billboard = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, face: '+x' | '-x' | '+z' | '-z') => {
      const alongX = face === '+z' || face === '-z';
      const span = alongX ? x1 - x0 : z1 - z0;
      const mega = span > 12 && r() < 0.4; // now and then a screen the whole width of the tower
      const w = mega ? span - 0.6 : Math.min(span * 0.85, 10 + r() * 14), h = Math.min(y1 - y0, w * (mega ? 0.7 : 0.55));
      const mid = alongX ? (x0 + x1) / 2 : (z0 + z1) / 2, yc = y0 + (y1 - y0 - h) * r();
      const min = alongX ? { x: mid - w / 2, y: yc, z: face === '+z' ? z1 - 0.1 : z0 } : { x: face === '+x' ? x1 - 0.1 : x0, y: yc, z: mid - w / 2 };
      const max = alongX ? { x: mid + w / 2, y: yc + h, z: face === '+z' ? z1 : z0 + 0.1 } : { x: face === '+x' ? x1 : x0 + 0.1, y: yc + h, z: mid + w / 2 };
      b.screens.push({ min, max, face, style: style++ });
      // a neon frame round it
      const c = pick(), t = 0.15, out = 0.12;
      const fx0 = face === '+x' ? x1 : x0 - out, fx1 = face === '+x' ? x1 + out : x0;
      const fz0 = face === '+z' ? z1 : z0 - out, fz1 = face === '+z' ? z1 + out : z0;
      if (alongX) {
        b.glow(min.x - t, yc - t, fz0, max.x + t, yc, fz1, c);
        b.glow(min.x - t, yc + h, fz0, max.x + t, yc + h + t, fz1, c);
      } else {
        b.glow(fx0, yc - t, min.z - t, fx1, yc, max.z + t, c);
        b.glow(fx0, yc + h, min.z - t, fx1, yc + h + t, max.z + t, c);
      }
    };

    // ---- the floor's neon seams: real strips of light on a 2 m grid (lined up with the panels' texture),
    // an LED at every joint. Geometry, not texture, so they stay sharp however far off.
    for (const f of b.floors) {
      if (f.mat !== 'panel' && f.mat !== 'panelAlt') continue;
      const c = f.mat === 'panel' ? 0x2ee8ff : 0xff2e88, t = 0.05, y0 = f.y + 0.004, y1 = f.y + 0.02;
      for (let x = Math.ceil(f.x0 / 2) * 2; x <= f.x1 + 1e-6; x += 2) b.glow(Math.max(f.x0, x - t), y0, f.z0, Math.min(f.x1, x + t), y1, f.z1, c);
      for (let z = Math.ceil(f.z0 / 2) * 2; z <= f.z1 + 1e-6; z += 2) b.glow(f.x0, y0, Math.max(f.z0, z - t), f.x1, y1, Math.min(f.z1, z + t), c);
      for (let x = Math.ceil(f.x0 / 2) * 2; x <= f.x1 + 1e-6; x += 2) {
        for (let z = Math.ceil(f.z0 / 2) * 2; z <= f.z1 + 1e-6; z += 2) b.glow(x - 0.09, y0, z - 0.09, x + 0.09, y1 + 0.004, z + 0.09, 0xffffff);
      }
    }

    // ---- under the course: a tower under every floor, neon up its corners and along the floor's edges
    let k = 0;
    for (const f of [...b.floors]) {
      const c = NEON[k++ % NEON.length];
      const w = f.x1 - f.x0, d = f.z1 - f.z0;
      if (Math.max(w, d) > 3 && Math.min(w, d) > 1.5) {
        const t = 0.12;
        if (w >= d) {
          b.glow(f.x0, f.y - 0.3, f.z0 - t, f.x1, f.y - 0.05, f.z0, c);
          b.glow(f.x0, f.y - 0.3, f.z1, f.x1, f.y - 0.05, f.z1 + t, c);
        } else {
          b.glow(f.x0 - t, f.y - 0.3, f.z0, f.x0, f.y - 0.05, f.z1, c);
          b.glow(f.x1, f.y - 0.3, f.z0, f.x1 + t, f.y - 0.05, f.z1, c);
        }
      }
      if (!f.under || b.covered(f) || w < 2.5 || d < 2.5) continue;
      const base = baseOf(b, f);
      b.block(f.x0 + 0.3, f.x1 - 0.3, f.z0 + 0.3, f.z1 - 0.3, base, 'glass', base - street);
      if (w > 4 && d > 4) {
        for (const [cx, cz] of [[f.x0 + 0.3, f.z0 + 0.3], [f.x1 - 0.3, f.z1 - 0.3]]) b.glow(cx - 0.12, base - 30, cz - 0.12, cx + 0.12, base, cz + 0.12, c);
      }
    }

    // ---- holographic frames over the checkpoints
    for (const t of b.triggers) {
      if (t.type !== 'checkpoint' && t.type !== 'finish') continue;
      const y = t.min.y, c = t.type === 'finish' ? 0xffd23a : 0x2ee8ff;
      const { min: lo, max: hi } = t;
      b.glow(lo.x, y, lo.z, lo.x + 0.2, y + 5, lo.z + 0.2, c);
      b.glow(hi.x - 0.2, y, hi.z - 0.2, hi.x, y + 5, hi.z, c);
      b.glow(lo.x, y + 5, lo.z, hi.x, y + 5.2, lo.z + 0.2, c);
      b.glow(lo.x, y + 5, hi.z - 0.2, hi.x, y + 5.2, hi.z, c);
    }

    // ---- the skyline: stepped skyscrapers wherever the course is not
    for (const p of spots(b, r, 15, 110, 9)) {
      if (r() < 0.12) continue;
      const { x, z } = p;
      let w = 4 + r() * 6, d = 4 + r() * 6;
      if (b.clearance(x, z) < Math.max(w, d) + 4) continue;
      const near = b.clearance(x, z) < 50;
      let top = b.y0 - 20 + r() * 60 + (near ? 0 : r() * 40);
      b.block(x - w, x + w, z - d, z + d, top, 'glass', top - street);
      const c = pick();
      outline(x - w, x + w, z - d, z + d, top, c, near ? 40 : 0);
      // a billboard on the face looking at the course, and sometimes a tall glyph sign on a corner
      if (near && r() < 0.55) billboard(x - w, x + w, z - d, z + d, Math.max(top - 40, b.y0 - 25), top - 2, faceTo(x, z));
      if (near && r() < 0.22) {
        const face = faceTo(x, z), sh = 10 + r() * 10, sy = top - sh - 2 - r() * 15;
        const sx = face === '-x' ? x - w - 1.6 : face === '+x' ? x + w : x - 0.6 + (r() - 0.5) * w;
        const sz = face === '-z' ? z - d - 1.6 : face === '+z' ? z + d : z - 0.6 + (r() - 0.5) * d;
        b.screens.push({ min: { x: sx, y: sy, z: sz }, max: { x: sx + 1.6, y: sy + sh, z: sz + 1.6 }, face, style: style++ });
      }
      // setbacks: a narrower tier or two on top, each with its own neon roof line
      for (let tier = 0; tier < 2 && r() < 0.65; tier++) {
        w *= 0.65; d *= 0.65;
        const h = 8 + r() * 18;
        b.block(x - w, x + w, z - d, z + d, top + h, 'glass', h);
        top += h;
        outline(x - w, x + w, z - d, z + d, top, pick(), 0);
      }
      // an antenna spire with a red light
      if (r() < 0.45) {
        const ah = 6 + r() * 12;
        b.block(x - 0.25, x + 0.25, z - 0.25, z + 0.25, top + ah, 'metal', ah);
        b.glow(x - 0.5, top + ah, z - 0.5, x + 0.5, top + ah + 0.8, z + 0.5, 0xff2020);
      }
    }

    // ---- elevated highways under the course, full of traffic both ways
    const bb = b.bounds();
    const hy = lowest - 24;
    for (let i = 0; i < 3; i++) {
      const alongX = i % 2 === 0;
      const at = alongX ? bb.z0 + (bb.z1 - bb.z0) * (0.2 + 0.3 * i) : bb.x0 + (bb.x1 - bb.x0) * (0.3 + 0.2 * i);
      const a0 = (alongX ? bb.x0 : bb.z0) - 150, a1 = (alongX ? bb.x1 : bb.z1) + 150, y = hy - i * 6;
      if (alongX) b.block(a0, a1, at - 4, at + 4, y, 'concrete', 1.2);
      else b.block(at - 4, at + 4, a0, a1, y, 'concrete', 1.2);
      for (const [off, col, rev] of [[-2.5, 0xfff2d0, false], [-1, 0xfff2d0, false], [1, 0xff3040, true], [2.5, 0xff3040, true]] as const) {
        const s = { x: alongX ? a0 : at + off, y: y + 0.4, z: alongX ? at + off : a0 };
        const e = { x: alongX ? a1 : at + off, y: y + 0.4, z: alongX ? at + off : a1 };
        b.traffic.push({ a: rev ? e : s, b: rev ? s : e, color: col, count: 26, speed: 24 + r() * 8 });
      }
      // neon rails along both sides
      const c = pick();
      if (alongX) { b.glow(a0, y, at - 4.2, a1, y + 0.3, at - 4, c); b.glow(a0, y, at + 4, a1, y + 0.3, at + 4.2, c); }
      else { b.glow(at - 4.2, y, a0, at - 4, y + 0.3, a1, c); b.glow(at + 4, y, a0, at + 4.2, y + 0.3, a1, c); }
    }

    // ---- flying traffic: lanes of lights crossing high over the city
    for (let i = 0; i < 10; i++) {
      const y = b.y0 + 22 + r() * 30, alongX = r() < 0.5;
      const at = alongX ? bb.z0 - 60 + r() * (bb.z1 - bb.z0 + 120) : bb.x0 - 60 + r() * (bb.x1 - bb.x0 + 120);
      const s = alongX ? { x: bb.x0 - 200, y, z: at } : { x: at, y, z: bb.z0 - 200 };
      const e = alongX ? { x: bb.x1 + 200, y, z: at } : { x: at, y, z: bb.z1 + 200 };
      b.traffic.push({ a: r() < 0.5 ? s : e, b: r() < 0.5 ? e : s, color: r() < 0.5 ? 0xff4a8a : 0x8af2ff, count: 8, speed: 30 + r() * 20 });
    }

    // ---- holograms turning in the sky
    for (const p of spots(b, r, 70, 40, 25)) {
      if (r() < 0.55) continue;
      b.holos.push({ pos: { x: p.x, y: b.y0 + 25 + r() * 25, z: p.z }, size: 7 + r() * 8, color: pick(), kind: Math.floor(r() * 4) });
    }
  },
};

function neonSprawl(): Course {
  const b = new Builder(CITY, 100);
  b.signs = NEON;
  b.start();
  b.beamsBoost(); b.checkpoint(); // girders between towers
  b.iceBeltGrav(); b.checkpoint(); // a slick roof, a belt, an anti-gravity field
  b.turn(1);
  b.padsWallrun(); b.checkpoint(); // up the pads, along a billboard
  b.portalDive(); b.checkpoint(); // a portal to a spire, and a dive
  b.turn(-1);
  b.sweepers(); b.checkpoint(); // security shutters
  b.drop(9); b.checkpoint(); // off a skybridge
  b.wallruns([1, -1, 1]); b.checkpoint(); // a billboard alley
  b.turn(-1);
  b.movingStones(); b.checkpoint(); // hover pads
  b.ferryLift(); b.checkpoint(); // a hover-platform and a lift
  b.slalom(); b.checkpoint(); // ledges
  b.turn(1);
  b.crawlPad(); b.checkpoint(); // a vent duct
  b.cascade(4); b.checkpoint(); // down the fire escapes
  b.turn(1);
  b.hurdles(); b.checkpoint(); // barriers
  b.spiral(); b.checkpoint(); // round a tower
  b.turn(-1);
  b.wallruns([-1]); b.checkpoint();
  b.turn(-1);
  b.chimney(); b.checkpoint(); // up a light well...
  b.chimney(); b.checkpoint(); // ...and up again
  b.padsWallrun(); b.checkpoint();
  b.portalDive(); b.checkpoint(); // another spire
  b.turn(1);
  b.iceBeltGrav(); b.checkpoint();
  b.drop(9); b.checkpoint();
  b.movingStones(); b.checkpoint();
  b.pillars(); b.finish(); // rooftop vents
  return b.build({ id: 'neonsprawl', name: 'NEON SPRAWL', difficulty: 'HARD',
    blurb: 'A megacity at night, block after block: girders, an anti-gravity field, billboard wall runs, a portal to a spire, a skybridge drop, hover pads, a vent duct, fire escapes and a spiral round a tower.' });
}

export const COURSES: Course[] = [blocklands(), duneTemple(), neonSprawl()];

export const courseById = (id: string): Course | undefined => COURSES.find((c) => c.id === id);
