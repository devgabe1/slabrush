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
  /** The cursor: where the next section starts (the far end of the last floor) and at what height. */
  x = 0;
  y = 0;
  private cps = 0;
  get checkpoints(): number { return this.cps; }

  /** The height the course starts at (scenery is placed around it). */
  readonly y0: number;

  constructor(readonly t: Theme, y: number) { this.y = this.y0 = y; }

  // ------------------------------------------------------------ pieces
  /** A plain box, top at y. */
  block(x0: number, x1: number, z0: number, z1: number, y: number, mat: MatId, depth = 1, surface: Surface = 'normal'): Solid {
    const s = box(x0, y - depth, z0, x1, y, z1, mat, surface);
    this.solids.push(s);
    return s;
  }

  /** Something to stand on, top at y, in the theme's floor (with its cap). `under`: may the theme build beneath it. */
  floor(x0: number, x1: number, z0: number, z1: number, y: number, o: { depth?: number; mat?: MatId; under?: boolean } = {}): Solid {
    const depth = o.depth ?? 1, mat = o.mat ?? this.t.floor;
    this.floors.push({ x0, x1, z0, z1, y, under: o.under ?? true });
    if (this.t.cap && !o.mat) {
      this.block(x0, x1, z0, z1, y - 0.3, mat, depth - 0.3);
      return this.block(x0, x1, z0, z1, y, this.t.cap, 0.3);
    }
    return this.block(x0, x1, z0, z1, y, mat, depth);
  }

  go(x: number, y: number, z: number, move: Move, extra: Partial<Waypoint> = {}): void {
    this.route.push({ x, y, z, move, ...extra });
  }

  /** A jump pad on a floor at y. */
  pad(x0: number, x1: number, z0: number, z1: number, y: number, up = 13): void {
    this.triggers.push({ type: 'jumppad', min: { x: x0, y, z: z0 }, max: { x: x1, y: y + 0.5, z: z1 }, vel: { x: 0, y: up, z: 0 } });
  }

  /** A wall from y-2 to y+6 (z0..z1 its thickness). */
  wall(x0: number, x1: number, z0: number, z1: number, y: number): Solid {
    const s = box(x0, y - 2, z0, x1, y + 6, z1, this.t.wall);
    this.solids.push(s);
    return s;
  }

  /** A platform that travels (dx, dy, dz) and back, waiting at each end. */
  mover(x0: number, x1: number, z0: number, z1: number, y: number, m: MoverDef, depth = 0.6, mat = this.t.mover): MoverDef {
    const s = box(x0, y - depth, z0, x1, y, z1, mat);
    s.mover = m;
    this.solids.push(s);
    return m;
  }

  /** A booster strip across x0..x1, sending you along +x at `speed`. */
  booster(x0: number, x1: number, z0: number, z1: number, y: number, speed: number): void {
    this.solids.push(box(x0, y - 0.02, z0 + 0.5, x1, y + 0.03, z1 - 0.5, 'conveyor'));
    this.triggers.push({ type: 'boost', min: { x: x0, y, z: z0 }, max: { x: x1, y: y + 2, z: z1 }, vel: { x: speed, y: 0, z: 0 } });
  }

  /** Glowing scenery (not solid). */
  glow(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    this.decor.push({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, color });
  }

  // ------------------------------------------------------------ start, checkpoints, finish
  start(): void {
    const y = this.y;
    this.floor(-8, 6, -4, 4, y, { mat: this.t.checkpoint, depth: 2 });
    this.triggers.push({ type: 'start', min: { x: -8, y, z: -4 }, max: { x: 6, y: y + 4, z: 4 } });
    // Room for a whole race: the middle first (solo runs use that one), then out to both sides.
    this.spawns = [0, -1, 1, -2, 2, -3].map((k) => ({ pos: { x: -6.5, y: y + 0.02, z: k * 1.1 }, yaw: -Math.PI / 2 }));
    this.x = 6;
  }

  /** A checkpoint platform at the cursor: fall after this and you come back here. */
  checkpoint(len = 12): void {
    const { x, y } = this;
    this.floor(x, x + len, -4, 4, y, { mat: this.t.checkpoint, depth: 2 });
    this.triggers.push({ type: 'checkpoint', min: { x, y, z: -4 }, max: { x: x + len, y: y + 4, z: 4 }, index: ++this.cps, spawn: { x: x + 1.5, y: y + 0.02, z: 0 }, yaw: -Math.PI / 2 });
    this.go(x + len - 3, y, 0, 'run', { reach: 1.5 });
    this.x = x + len;
  }

  finish(): void {
    const { x, y } = this;
    this.floor(x, x + 14, -5, 5, y, { mat: this.t.finish, depth: 2 });
    this.triggers.push({ type: 'finish', min: { x, y, z: -5 }, max: { x: x + 14, y: y + 4, z: 5 } });
    this.block(x + 14, x + 15, -5.5, 5.5, y + 4, this.t.wall, 6); // the end: a wall to stop against
    this.go(x + 7, y, 0, 'run');
    this.x = x + 15;
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
      const w = this.wall(edge - 1, edge + 18, side > 0 ? 3 : -3.6, side > 0 ? 3.6 : -3, y);
      this.wallSign(w, side);
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
    this.triggers.push({ type: 'lowgrav', min: { x: x + 37, y: y - 6, z: -6 }, max: { x: x + 54, y: y + 12, z: 6 }, scale: 0.35 });
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
    const w = this.wall(p0 + 29, p0 + 48, 3, 3.6, y + 7);
    this.wallSign(w, 1);
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
    this.triggers.push({ type: 'teleporter', min: { x: x + 3.5, y, z: -1 }, max: { x: x + 5.5, y: y + 2, z: 1 }, dest: { x: x + 13, y: y + 18.02, z: 0 }, pair: 1 });
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

  // ------------------------------------------------------------ dressing helpers
  /** Neon themes put a glowing sign on the face of every wall you run along. */
  signs: number[] | null = null;
  private signCount = 0;
  private wallSign(w: Solid, side: 1 | -1): void {
    if (!this.signs) return;
    const c = this.signs[this.signCount++ % this.signs.length];
    const face = side > 0 ? w.min.z - 0.02 : w.max.z + 0.02;
    const z0 = Math.min(face, face - side * 0.05), z1 = Math.max(face, face - side * 0.05);
    const y = w.max.y - 6; // the floor the wall stands beside
    this.glow(w.min.x + 1, y + 2.6, z0, w.max.x - 1, y + 2.75, z1, c); // a light line along it
    for (let sx = w.min.x + 2; sx < w.max.x - 3; sx += 6) this.glow(sx, y + 3.2, z0, sx + 4, y + 5.2, z1, this.signs[(this.signCount + Math.round(sx)) % this.signs.length]);
  }

  /** Is any other floor below this one, overlapping it? (Then nothing may be built under it.) */
  covered(f: Floor): boolean {
    return this.floors.some((o) => o !== f && o.y < f.y - 0.01 && o.x0 < f.x1 && o.x1 > f.x0 && o.z0 < f.z1 && o.z1 > f.z0);
  }

  build(c: Omit<Course, 'map' | 'checkpoints' | 'route' | 'fallY'>): Course {
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

// ================================================================ BLOCKLANDS
/** Floating grass islands over a lava sea: stepped earth under every floor, blocky trees, clouds, mountains. */
const BLOCKS: Theme = {
  palette: {
    sky: 0x8cc8ff, fogNear: 90, fogFar: 340, sun: 0xfff4d8, ambientSky: 0xdcefff, ambientGround: 0x5a4a38,
    mats: {
      concrete: '#8d8d8d', concreteDark: '#5c5c5c', tile: '#b08a52', metal: '#7a7a7a', hazard: '#e0b020', ice: '#9cd2f0', conveyor: '#3a3a3a', lava: '#ff6a10',
      grass: '#5da83a', dirt: '#7a5232', stone: '#8a8a8a', planks: '#a77b46', leaves: '#3f8f2c',
    },
  },
  floor: 'dirt', cap: 'grass', checkpoint: 'planks', finish: 'hazard', wall: 'stone', beam: 'planks', accent: 'planks',
  mover: 'planks', tower: 'planks', spiral: 'leaves',
  dress(b) {
    const r = rand(11);
    // Every island hangs over the void on a stepped lump of earth and rock.
    for (const f of [...b.floors]) {
      if (!f.under || b.covered(f) || f.x1 - f.x0 < 2 || f.z1 - f.z0 < 2) continue;
      const base = b.solids.find((s) => s.max.y === f.y && s.min.x === f.x0 && s.max.x === f.x1)?.min.y ?? f.y - 1;
      let top = base;
      [[0.4, 'dirt'], [1.2, 'stone'], [2, 'stone']].forEach(([inset, mat], i) => {
        const ix = Math.min(inset as number, (f.x1 - f.x0) / 2 - 0.3), iz = Math.min(inset as number, (f.z1 - f.z0) / 2 - 0.3);
        b.block(f.x0 + ix, f.x1 - ix, f.z0 + iz, f.z1 - iz, top, mat as MatId, 1.5 + i * 0.5);
        top -= 1.5 + i * 0.5;
      });
    }
    // Islands with trees beside the course, now and then.
    const end = b.x;
    for (let x = 10; x < end; x += 18 + r() * 14) {
      const side = r() < 0.5 ? -1 : 1, z = side * (11 + r() * 8), y = b.y0 + (r() - 0.4) * 16;
      const w = 4 + Math.floor(r() * 3);
      b.block(x - w, x + w, z - w, z + w, y, 'grass', 0.3);
      b.block(x - w, x + w, z - w, z + w, y - 0.3, 'dirt', 2);
      b.block(x - w + 1, x + w - 1, z - w + 1, z + w - 1, y - 2.3, 'stone', 2.5);
      const tx = x + Math.round((r() - 0.5) * (w - 2)), tz = z + Math.round((r() - 0.5) * (w - 2));
      const h = 4 + Math.floor(r() * 3);
      b.block(tx - 0.5, tx + 0.5, tz - 0.5, tz + 0.5, y + h, 'planks', h);
      b.block(tx - 2.5, tx + 2.5, tz - 2.5, tz + 2.5, y + h + 1, 'leaves', 3);
      b.block(tx - 1.5, tx + 1.5, tz - 1.5, tz + 1.5, y + h + 2, 'leaves', 1);
      // a few flowers
      for (let k = 0; k < 3; k++) {
        const fx = x + (r() - 0.5) * (w * 2 - 1), fz = z + (r() - 0.5) * (w * 2 - 1);
        b.glow(fx - 0.15, y, fz - 0.15, fx + 0.15, y + 0.35, fz + 0.15, [0xff4a4a, 0xffe14a, 0xffffff][k]);
      }
    }
    // The leaves crowning each spiral tower: a giant tree.
    for (const s of b.solids.filter((x) => x.mat === 'planks' && x.max.y - x.min.y >= 39)) {
      const cx = (s.min.x + s.max.x) / 2, top = s.max.y;
      b.block(cx - 6, cx + 6, -6, 6, top + 3, 'leaves', 3);
      b.block(cx - 4, cx + 4, -4, 4, top + 5, 'leaves', 2);
    }
    // Clouds, and blocky mountains on the horizon.
    for (let x = -40; x < end + 60; x += 30 + r() * 25) {
      const y = b.y0 + 22 + r() * 14, z = (r() - 0.5) * 120;
      b.glow(x, y, z, x + 10 + r() * 14, y + 2, z + 6 + r() * 8, 0xffffff);
    }
    for (let x = -60; x < end + 80; x += 40 + r() * 30) {
      for (const side of [-1, 1]) {
        const z = side * (90 + r() * 40), h = 20 + r() * 40, w = 18 + r() * 14;
        for (let k = 0; k < 4; k++) {
          const s = w * (1 - k * 0.22), top = b.y0 - 50 + h * ((k + 1) / 4);
          b.block(x - s, x + s, z - s, z + s, top, k === 3 ? 'grass' : 'stone', h / 4 + 30);
        }
      }
    }
    // The lava sea far below.
    b.block(-200, end + 200, -200, 200, Math.min(...b.floors.map((f) => f.y)) - 40, 'lava', 2, 'deadly');
  },
};

function blocklands(): Course {
  const b = new Builder(BLOCKS, 40);
  b.start();
  b.stones([0, 0, 0]); b.checkpoint();
  b.crawlPad(); b.checkpoint(); // a mine tunnel
  b.stones([1, 2, 3]); b.checkpoint();
  b.stones([0, 0, 0, 0], true); b.checkpoint(); // over lava
  b.hurdles(); b.checkpoint(); // fences
  b.spiral(); b.checkpoint(); // round a giant tree
  b.padIslands(); b.checkpoint();
  b.stones([-1.5, -3, -4.5]); b.checkpoint(); // down the hillside
  b.ferryLift(); b.checkpoint(); // a raft and a lift
  b.pillars(); b.finish(); // fence posts
  return b.build({ id: 'blocklands', name: 'BLOCKLANDS', difficulty: 'EASY',
    blurb: 'A blocky world of floating grass islands over a lava sea: stepping stones, a mine tunnel, fences, a spiral up a giant tree, bounce pads, a raft and a lift.' });
}

// ================================================================ DUNE TEMPLE
/** Sandstone temple ruins in the desert at golden hour: columns down to the sand, pyramids and dunes. */
const DUNES: Theme = {
  palette: {
    sky: 0xf4c890, fogNear: 80, fogFar: 320, sun: 0xffd8a0, ambientSky: 0xffe2b8, ambientGround: 0x7a5a38,
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
      const base = b.solids.find((s) => s.max.y === f.y && s.min.x === f.x0 && s.max.x === f.x1)?.min.y ?? f.y - 1;
      const w = Math.min(f.x1 - f.x0, f.z1 - f.z0);
      const cs = w > 5 ? 1.4 : w / 2 - 0.5; // column half width
      for (const cx of f.x1 - f.x0 > 10 ? [f.x0 + 2.5, f.x1 - 2.5] : [(f.x0 + f.x1) / 2]) {
        const cz = (f.z0 + f.z1) / 2;
        b.block(cx - cs - 0.4, cx + cs + 0.4, cz - cs - 0.4, cz + cs + 0.4, base, 'sandstone', 0.8);
        b.block(cx - cs, cx + cs, cz - cs, cz + cs, base - 0.8, 'sandstone', base - 0.8 - ground);
      }
    }
    // Arches over the checkpoints.
    for (const t of b.triggers) {
      if (t.type !== 'checkpoint' && t.type !== 'finish') continue;
      const x = t.min.x + 1, y = t.min.y;
      for (const z of [-5.6, 4.6]) b.block(x, x + 1.4, z, z + 1, y + 6.5, 'sandstone', 6.5 + 2);
      b.block(x - 0.3, x + 1.7, -5.9, 5.9, y + 7.5, 'sandstone', 1);
    }
    // Gold capping the obelisks the spirals climb.
    for (const s of b.solids.filter((x) => x.mat === 'sandstone' && x.max.y - x.min.y >= 39)) {
      const cx = (s.min.x + s.max.x) / 2;
      b.glow(cx - 1.5, s.max.y, -1.5, cx + 1.5, s.max.y + 2, 1.5, 0xffc23a);
    }
    // The desert: the floor, dunes, pyramids, standing columns and palms.
    const end = b.x;
    b.block(-300, end + 300, -300, 300, ground, 'sand', 4);
    for (let x = -80; x < end + 100; x += 25 + r() * 20) {
      for (const side of [-1, 1]) {
        const z = side * (20 + r() * 50);
        if (r() < 0.5) { // a dune
          const w = 8 + r() * 10;
          b.block(x - w, x + w, z - w * 0.6, z + w * 0.6, ground + 2 + r() * 2, 'sand', 3);
          b.block(x - w * 0.6, x + w * 0.6, z - w * 0.35, z + w * 0.35, ground + 4 + r() * 2, 'sand', 3);
        } else if (r() < 0.6) { // a broken column
          const h = 6 + r() * 14;
          b.block(x - 1.2, x + 1.2, z - 1.2, z + 1.2, ground + h, 'sandstone', h);
        } else { // a palm
          const h = 7 + r() * 4;
          b.block(x - 0.4, x + 0.4, z - 0.4, z + 0.4, ground + h, 'planks', h);
          b.block(x - 3, x + 3, z - 0.8, z + 0.8, ground + h + 0.6, 'leaves', 0.8);
          b.block(x - 0.8, x + 0.8, z - 3, z + 3, ground + h + 0.6, 'leaves', 0.8);
        }
      }
    }
    for (const [px, pz, s] of [[60, -120, 40], [220, 140, 55], [420, -150, 48], [-60, 110, 30], [560, 120, 36]]) {
      for (let k = 0; k < 8; k++) {
        const w = s * (1 - k / 8);
        b.block(px - w, px + w, pz - w, pz + w, ground + (k + 1) * s / 7, 'sandstone', s / 7);
      }
    }
  },
};

function duneTemple(): Course {
  const b = new Builder(DUNES, 50);
  b.start();
  b.stones([0, 0.5, 1]); b.checkpoint(); // broken columns
  b.wallruns([1]); b.checkpoint(); // along the temple wall
  b.hurdles(); b.checkpoint(); // fallen columns and a lintel
  b.chimney(); b.checkpoint(); // up a temple shaft
  b.sweepers(); b.checkpoint(); // sliding stone blocks
  b.spiral(); b.checkpoint(); // round an obelisk
  b.boostLeap(); b.checkpoint();
  b.padIslands(); b.checkpoint();
  b.wallruns([-1, 1]); b.checkpoint();
  b.pillars(); b.finish();
  return b.build({ id: 'dunetemple', name: 'DUNE TEMPLE', difficulty: 'MEDIUM',
    blurb: 'Sandstone ruins over the desert at golden hour: broken columns, wall runs along the temple, a shaft to climb, sliding stone blocks and a spiral round an obelisk.' });
}

// ================================================================ NEON SPRAWL
const NEON = [0xff2e88, 0x2ee8ff, 0xffd23a, 0x9a5aff, 0x3aff9a];

/** A megacity at night: glass towers under every floor, neon on every edge, signs on every wall. */
const CITY: Theme = {
  palette: {
    sky: 0x0b0718, fogNear: 60, fogFar: 300, sun: 0xb0a0ff, ambientSky: 0x8070c0, ambientGround: 0x201830,
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
      if (f.x1 - f.x0 > 3 && f.z1 - f.z0 > 1.5) {
        b.glow(f.x0, f.y - 0.25, f.z0 - 0.06, f.x1, f.y - 0.05, f.z0, c);
        b.glow(f.x0, f.y - 0.25, f.z1, f.x1, f.y - 0.05, f.z1 + 0.06, c);
      }
      if (!f.under || b.covered(f) || f.x1 - f.x0 < 2.5 || f.z1 - f.z0 < 2.5) continue;
      const base = b.solids.find((s) => s.max.y === f.y && s.min.x === f.x0 && s.max.x === f.x1)?.min.y ?? f.y - 1;
      b.block(f.x0 + 0.3, f.x1 - 0.3, f.z0 + 0.3, f.z1 - 0.3, base, 'glass', base - street);
    }
    // Holographic frames over the checkpoints.
    for (const t of b.triggers) {
      if (t.type !== 'checkpoint' && t.type !== 'finish') continue;
      const x = t.min.x + 1, y = t.min.y, c = t.type === 'finish' ? 0xffd23a : 0x2ee8ff;
      for (const z of [-4.6, 4.4]) b.glow(x, y, z, x + 0.2, y + 5, z + 0.2, c);
      b.glow(x, y + 5, -4.6, x + 0.2, y + 5.2, 4.6, c);
    }
    // The skyline: rows of towers either side, signs up their faces, light bands round their tops.
    const end = b.x;
    for (let x = -60; x < end + 80; x += 14 + r() * 12) {
      for (const side of [-1, 1]) {
        const z = side * (18 + r() * 60), w = 4 + r() * 6, d = 4 + r() * 6;
        const top = b.y0 - 10 + r() * 70;
        b.block(x - w, x + w, z - d, z + d, top, 'glass', top - street);
        b.block(x - w - 0.4, x + w + 0.4, z - d - 0.4, z + d + 0.4, top + 0.6, 'concreteDark', 0.6);
        const c = NEON[Math.floor(r() * NEON.length)];
        b.glow(x - w - 0.45, top - 1.2, z - d - 0.45, x + w + 0.45, top - 0.9, z + d + 0.45, c);
        if (r() < 0.6) { // a tall sign on the face towards the course
          const fz = side > 0 ? z - d - 0.3 : z + d + 0.1;
          const sy = top - 8 - r() * 20;
          b.glow(x - 1, sy, fz, x + 1, sy + 6 + r() * 6, fz + 0.2, NEON[Math.floor(r() * NEON.length)]);
        }
      }
    }
    // Air traffic: lines of light crossing far off.
    for (let i = 0; i < 14; i++) {
      const y = b.y0 + 10 + r() * 40, z = (r() < 0.5 ? -1 : 1) * (40 + r() * 60), x = r() * end;
      b.glow(x, y, z, x + 40 + r() * 60, y + 0.15, z + 0.15, r() < 0.5 ? 0xff4a6a : 0xfff2c0);
    }
  },
};

function neonSprawl(): Course {
  const b = new Builder(CITY, 70);
  b.signs = NEON;
  b.start();
  b.beamsBoost(); b.checkpoint(); // girders between towers
  b.iceBeltGrav(); b.checkpoint(); // a slick roof, a belt, an anti-gravity field
  b.padsWallrun(); b.checkpoint(); // up the pads, along a billboard
  b.portalDive(); b.checkpoint(); // a portal to a spire, and a dive
  b.sweepers(); b.checkpoint(); // security shutters
  b.wallruns([1, -1, 1]); b.checkpoint(); // a billboard alley
  b.ferryLift(); b.checkpoint(); // a hover-platform and a lift
  b.crawlPad(); b.checkpoint(); // a vent duct
  b.hurdles(); b.checkpoint(); // barriers
  b.pillars(); b.finish(); // rooftop vents
  return b.build({ id: 'neonsprawl', name: 'NEON SPRAWL', difficulty: 'HARD',
    blurb: 'A megacity at night: girders, a slick roof and an anti-gravity field, billboard wall runs, a portal to a spire, security shutters, a hover-platform and a vent duct.' });
}

export const COURSES: Course[] = [blocklands(), duneTemple(), neonSprawl()];

export const courseById = (id: string): Course | undefined => COURSES.find((c) => c.id === id);
