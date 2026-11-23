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
}

/** A floor the course runs on, remembered so the theme can build under and around it. */
interface Floor { x0: number; x1: number; z0: number; z1: number; y: number; under: boolean }

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

class Builder {
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  route: Waypoint[] = [];
  spawns: { pos: Vec3; yaw: number }[] = [];
  decor: { min: Vec3; max: Vec3; color: number }[] = [];
  floors: Floor[] = [];
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

  constructor(readonly t: Theme, y: number) { this.y = this.y0 = y; }

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
    this.floors.push({ x0: a.min.x, x1: a.max.x, z0: a.min.z, z1: a.max.z, y, under: o.under ?? true });
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

  /** Thirteen steps round a tower, each 0.9 m up: all the way round and on. */
  spiral(): void {
    const { x, y } = this;
    const cx = x + 13, R = 7;
    this.block(cx - 2.5, cx + 2.5, -2.5, 2.5, y + 14, this.t.tower, 40);
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI - (i * Math.PI) / 4; // from the west side, clockwise seen from above
      const sx = cx + Math.cos(a) * R, sz = Math.sin(a) * R;
      const top = y + 0.9 * (i + 1);
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

  /** A chimney: two walls close together; wall jump up 3.2 m to the next checkpoint. */
  chimney(): void {
    const { x, y } = this;
    this.floor(x, x + 4, -1.3, 1.3, y, { depth: 2 });
    this.block(x, x + 6, -2, -1.3, y + 6, this.t.wall, 8);
    this.block(x, x + 6, 1.3, 2, y + 6, this.t.wall, 8);
    this.go(x + 2, y, 0, 'run', { reach: 0.6 });
    this.go(x + 7, y + 3.2, 0, 'climb', { reach: 1.5 });
    this.x = x + 4;
    this.y = y + 3.2;
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

  // ------------------------------------------------------------ dressing helpers
  /** Neon themes put a glowing sign on the face of every wall you run along. */
  signs: number[] | null = null;
  private signCount = 0;
  /** A neon line and signs along the face of a wall (in the leg's frame: u0..u1 along it, its face at v = face, beside a floor at y). */
  private wallSign(u0: number, u1: number, face: number, side: 1 | -1, y: number): void {
    if (!this.signs) return;
    const c = this.signs[this.signCount++ % this.signs.length];
    const v0 = Math.min(face - side * 0.02, face - side * 0.07), v1 = Math.max(face - side * 0.02, face - side * 0.07);
    this.glow(u0 + 1, y + 2.6, v0, u1 - 1, y + 2.75, v1, c); // a light line along it
    for (let su = u0 + 2; su < u1 - 3; su += 6) this.glow(su, y + 3.2, v0, su + 4, y + 5.2, v1, this.signs[(this.signCount + Math.round(su)) % this.signs.length]);
  }

  /** Is any other floor below this one, overlapping it? (Then nothing may be built under it.) */
  covered(f: Floor): boolean {
    return this.floors.some((o) => o !== f && o.y < f.y - 0.01 && o.x0 < f.x1 && o.x1 > f.x0 && o.z0 < f.z1 && o.z1 > f.z0);
  }

  build(c: Omit<Course, 'map' | 'checkpoints' | 'route' | 'fallY'>): Course {
    this.checkLayout();
    this.world(); // scenery is placed in world coordinates
    this.t.dress(this);
    const lowest = Math.min(...this.floors.map((f) => f.y));
    const fallY = lowest - 10;
    const map: MapDef = {
      name: c.name, seed: 0, solids: this.solids, triggers: this.triggers, decor: this.decor,
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

/** The tall solids the spirals climb round (their centres and tops). */
const towers = (b: Builder, mat: MatId) => b.solids.filter((s) => s.mat === mat && s.max.y - s.min.y >= 39)
  .map((s) => ({ x: (s.min.x + s.max.x) / 2, z: (s.min.z + s.max.z) / 2, top: s.max.y }));

/** The height of the base of the floor block whose top is `f` (what the theme builds under). */
const baseOf = (b: Builder, f: Floor) => b.solids.find((s) => s.max.y === f.y && s.min.x === f.x0 && s.max.x === f.x1 && s.min.z === f.z0)?.min.y ?? f.y - 1;

// ================================================================ BLOCKLANDS
/** Floating grass islands over a lava sea: stepped earth under every floor, blocky trees, clouds, mountains. */
const BLOCKS: Theme = {
  palette: {
    sky: 0x8cc8ff, fogNear: 90, fogFar: 360, sun: 0xfff4d8, ambientSky: 0xdcefff, ambientGround: 0x5a4a38,
    mats: {
      concrete: '#8d8d8d', concreteDark: '#5c5c5c', tile: '#b08a52', metal: '#7a7a7a', hazard: '#e0b020', ice: '#9cd2f0', conveyor: '#3a3a3a', lava: '#ff6a10',
      grass: '#5da83a', dirt: '#7a5232', stone: '#8a8a8a', planks: '#a77b46', leaves: '#3f8f2c',
    },
  },
  floor: 'dirt', cap: 'grass', checkpoint: 'planks', finish: 'hazard', wall: 'stone', beam: 'planks', accent: 'planks',
  mover: 'planks', tower: 'planks', spiral: 'leaves',
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
    }
    // The leaves crowning each spiral tower: a giant tree.
    for (const t of towers(b, 'planks')) {
      b.block(t.x - 6, t.x + 6, t.z - 6, t.z + 6, t.top + 3, 'leaves', 3);
      b.block(t.x - 4, t.x + 4, t.z - 4, t.z + 4, t.top + 5, 'leaves', 2);
    }
    // Clouds above, blocky mountains all round, the lava sea far below.
    for (const p of spots(b, r, 40, 80, 0)) {
      if (r() < 0.5) continue;
      const y = b.y0 + 24 + r() * 16;
      b.glow(p.x, y, p.z, p.x + 10 + r() * 14, y + 2, p.z + 6 + r() * 8, 0xffffff);
    }
    const bb = b.bounds();
    for (let k = 0; k < 26; k++) {
      const a = (k / 26) * Math.PI * 2, rad = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2 + 110 + r() * 60;
      const x = (bb.x0 + bb.x1) / 2 + Math.cos(a) * rad, z = (bb.z0 + bb.z1) / 2 + Math.sin(a) * rad;
      const h = 30 + r() * 50, w = 18 + r() * 16;
      for (let s = 0; s < 4; s++) {
        const half = w * (1 - s * 0.22), top = lowest - 45 + h * ((s + 1) / 4);
        b.block(x - half, x + half, z - half, z + half, top, s === 3 ? 'grass' : 'stone', h / 4 + 30);
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
  b.pillars(); b.finish(); // fence posts
  return b.build({ id: 'blocklands', name: 'BLOCKLANDS', difficulty: 'EASY',
    blurb: 'A blocky world of floating grass islands over a lava sea, winding through a mine, over lava and fences, up a giant tree, down cliffs and across floating logs.' });
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
  dress(b) {
    const r = rand(23);
    const lowest = Math.min(...b.floors.map((f) => f.y));
    const ground = lowest - 26;
    // Columns from every floor down to the sand, with a wider capital on top.
    for (const f of [...b.floors]) {
      if (!f.under || b.covered(f) || f.x1 - f.x0 < 2.5 || f.z1 - f.z0 < 2.5) continue;
      const base = baseOf(b, f);
      const w = Math.min(f.x1 - f.x0, f.z1 - f.z0);
      const cs = w > 5 ? 1.4 : w / 2 - 0.5;
      const long = Math.max(f.x1 - f.x0, f.z1 - f.z0) > 10, alongX = f.x1 - f.x0 >= f.z1 - f.z0;
      const cx = (f.x0 + f.x1) / 2, cz = (f.z0 + f.z1) / 2;
      const at = !long ? [[cx, cz]] : alongX ? [[f.x0 + 2.5, cz], [f.x1 - 2.5, cz]] : [[cx, f.z0 + 2.5], [cx, f.z1 - 2.5]];
      for (const [px, pz] of at) {
        b.block(px - cs - 0.4, px + cs + 0.4, pz - cs - 0.4, pz + cs + 0.4, base, 'sandstone', 0.8);
        b.block(px - cs, px + cs, pz - cs, pz + cs, base - 0.8, 'sandstone', base - 0.8 - ground);
      }
    }
    // Gold capping the obelisks the spirals climb.
    for (const t of towers(b, 'sandstone')) b.glow(t.x - 1.5, t.top, t.z - 1.5, t.x + 1.5, t.top + 2, t.z + 1.5, 0xffc23a);
    // The desert: the floor, then dunes, broken columns and palms off the course, pyramids all round.
    const bb = b.bounds();
    b.block(bb.x0 - 400, bb.x1 + 400, bb.z0 - 400, bb.z1 + 400, ground, 'sand', 4);
    for (const p of spots(b, r, 22, 60, 10)) {
      const { x, z } = p, k = r();
      if (k < 0.4) {
        const w = 8 + r() * 10;
        b.block(x - w, x + w, z - w * 0.6, z + w * 0.6, ground + 2 + r() * 2, 'sand', 3);
        b.block(x - w * 0.6, x + w * 0.6, z - w * 0.35, z + w * 0.35, ground + 4 + r() * 2, 'sand', 3);
      } else if (k < 0.7) {
        const h = 6 + r() * 16;
        b.block(x - 1.2, x + 1.2, z - 1.2, z + 1.2, ground + h, 'sandstone', h);
      } else {
        const h = 7 + r() * 4;
        b.block(x - 0.4, x + 0.4, z - 0.4, z + 0.4, ground + h, 'planks', h);
        b.block(x - 3, x + 3, z - 0.8, z + 0.8, ground + h + 0.6, 'leaves', 0.8);
        b.block(x - 0.8, x + 0.8, z - 3, z + 3, ground + h + 0.6, 'leaves', 0.8);
      }
    }
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.4, rad = Math.max(bb.x1 - bb.x0, bb.z1 - bb.z0) / 2 + 120 + r() * 60;
      const px = (bb.x0 + bb.x1) / 2 + Math.cos(a) * rad, pz = (bb.z0 + bb.z1) / 2 + Math.sin(a) * rad, sz = 30 + r() * 30;
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
  b.pillars(); b.finish(); // column tops
  return b.build({ id: 'dunetemple', name: 'DUNE TEMPLE', difficulty: 'MEDIUM',
    blurb: 'Sandstone ruins over the desert at golden hour: wall runs along the temple, two shafts to climb, a leap off the roof, sliding stone blocks, a spiral round an obelisk and terraces down.' });
}

// ================================================================ NEON SPRAWL
const NEON = [0xff2e88, 0x2ee8ff, 0xffd23a, 0x9a5aff, 0x3aff9a];

/** A megacity at night: glass towers under every floor, neon on every edge, signs on every wall. */
const CITY: Theme = {
  palette: {
    sky: 0x0b0718, fogNear: 60, fogFar: 320, sun: 0xb0a0ff, ambientSky: 0x8070c0, ambientGround: 0x201830,
    mats: {
      concrete: '#3a3f52', concreteDark: '#20232f', tile: '#3a2a5a', metal: '#4a5878', hazard: '#ff2e88', ice: '#7ae8ff', conveyor: '#22242e', lava: '#ff3a8a',
      glass: '#ffd890',
    },
  },
  floor: 'metal', checkpoint: 'tile', finish: 'hazard', wall: 'concreteDark', beam: 'metal', accent: 'hazard',
  mover: 'concrete', tower: 'glass', spiral: 'metal',
  dress(b) {
    const r = rand(37);
    const lowest = Math.min(...b.floors.map((f) => f.y));
    const street = lowest - 60;
    // A tower under every floor, down to the street, and a neon line along each long edge.
    let k = 0;
    for (const f of [...b.floors]) {
      const c = NEON[k++ % NEON.length];
      const alongX = f.x1 - f.x0 >= f.z1 - f.z0;
      if (Math.max(f.x1 - f.x0, f.z1 - f.z0) > 3 && Math.min(f.x1 - f.x0, f.z1 - f.z0) > 1.5) {
        if (alongX) {
          b.glow(f.x0, f.y - 0.25, f.z0 - 0.06, f.x1, f.y - 0.05, f.z0, c);
          b.glow(f.x0, f.y - 0.25, f.z1, f.x1, f.y - 0.05, f.z1 + 0.06, c);
        } else {
          b.glow(f.x0 - 0.06, f.y - 0.25, f.z0, f.x0, f.y - 0.05, f.z1, c);
          b.glow(f.x1, f.y - 0.25, f.z0, f.x1 + 0.06, f.y - 0.05, f.z1, c);
        }
      }
      if (!f.under || b.covered(f) || f.x1 - f.x0 < 2.5 || f.z1 - f.z0 < 2.5) continue;
      const base = baseOf(b, f);
      b.block(f.x0 + 0.3, f.x1 - 0.3, f.z0 + 0.3, f.z1 - 0.3, base, 'glass', base - street);
    }
    // Holographic frames over the checkpoints.
    for (const t of b.triggers) {
      if (t.type !== 'checkpoint' && t.type !== 'finish') continue;
      const y = t.min.y, c = t.type === 'finish' ? 0xffd23a : 0x2ee8ff;
      const { min: lo, max: hi } = t;
      b.glow(lo.x, y, lo.z, lo.x + 0.2, y + 5, lo.z + 0.2, c);
      b.glow(hi.x - 0.2, y, hi.z - 0.2, hi.x, y + 5, hi.z, c);
      b.glow(lo.x, y + 5, lo.z, hi.x, y + 5.2, lo.z + 0.2, c);
      b.glow(lo.x, y + 5, hi.z - 0.2, hi.x, y + 5.2, hi.z, c);
    }
    // The skyline: towers wherever the course is not, signs up their faces, light bands round their tops.
    for (const p of spots(b, r, 16, 90, 9)) {
      if (r() < 0.2) continue;
      const { x, z } = p, w = 3 + r() * 5, d = 3 + r() * 5;
      if (b.clearance(x, z) < Math.max(w, d) + 4) continue;
      const top = b.y0 - 15 + r() * 75;
      b.block(x - w, x + w, z - d, z + d, top, 'glass', top - street);
      b.block(x - w - 0.4, x + w + 0.4, z - d - 0.4, z + d + 0.4, top + 0.6, 'concreteDark', 0.6);
      b.glow(x - w - 0.45, top - 1.2, z - d - 0.45, x + w + 0.45, top - 0.9, z + d + 0.45, NEON[Math.floor(r() * NEON.length)]);
      if (r() < 0.55) {
        const sy = top - 8 - r() * 20, side = r() < 0.5 ? -1 : 1;
        const fz = side > 0 ? z + d + 0.1 : z - d - 0.3;
        b.glow(x - 1, sy, fz, x + 1, sy + 6 + r() * 6, fz + 0.2, NEON[Math.floor(r() * NEON.length)]);
      }
    }
    // Air traffic: lines of light crossing far off.
    const bb = b.bounds();
    for (let i = 0; i < 24; i++) {
      const y = b.y0 + 15 + r() * 40, x = bb.x0 - 60 + r() * (bb.x1 - bb.x0 + 120), z = bb.z0 - 60 + r() * (bb.z1 - bb.z0 + 120);
      const col = r() < 0.5 ? 0xff4a6a : 0xfff2c0;
      if (r() < 0.5) b.glow(x, y, z, x + 40 + r() * 60, y + 0.15, z + 0.15, col);
      else b.glow(x, y, z, x + 0.15, y + 0.15, z + 40 + r() * 60, col);
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
