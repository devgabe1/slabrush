import type { Vec3 } from '../core/vec';
import { box, type MapDef, type MatId, type MoverDef, type Palette, type Solid, type Surface, type Trigger } from '../sim/map';

// PARKOUR: hand-built obstacle courses in the sky. Jump, bunny hop, crouch,
// wall run, wall jump and ride platforms from the start to the finish as fast
// as you can. Every course runs roughly along +x.
//
// Each course also carries a `route`: where to go and how, piece by piece. The
// autopilot in scripts/parkourtest.ts follows it to prove every course can be
// finished; the game itself does not use it.

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
  /** Below this you have fallen: back to your last checkpoint. */
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

class Builder {
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  route: Waypoint[] = [];
  spawns: { pos: Vec3; yaw: number }[] = [];
  private cps = 0;
  get checkpoints(): number { return this.cps; }

  /** A block whose top is at y (1 m thick unless `depth` says otherwise). */
  block(x0: number, x1: number, z0: number, z1: number, y: number, mat: MatId = 'concrete', surface: Surface = 'normal', depth = 1): Solid {
    const s = box(x0, y - depth, z0, x1, y, z1, mat, surface);
    this.solids.push(s);
    return s;
  }

  go(x: number, y: number, z: number, move: Move, extra: Partial<Waypoint> = {}): void {
    this.route.push({ x, y, z, move, ...extra });
  }

  /**
   * A platform, top at y. `boost` lays a booster strip across its far (+x) end
   * that sends you off at that speed. `role` makes it the start, a checkpoint
   * or the finish.
   */
  platform(x0: number, x1: number, z0: number, z1: number, y: number,
    o: { boost?: number; role?: 'start' | 'checkpoint' | 'finish'; mat?: MatId; spawn?: { x: number; z: number }; yaw?: number } = {}): void {
    this.block(x0, x1, z0, z1, y, o.mat ?? (o.role === 'finish' ? 'hazard' : o.role ? 'tile' : 'concrete'), 'normal', 2);
    const zc = (z0 + z1) / 2;
    // Where you come back after a fall: the near (-x) end, facing on along +x, unless told otherwise.
    const spawn = { pos: { x: o.spawn?.x ?? x0 + 1.5, y: y + 0.02, z: o.spawn?.z ?? zc }, yaw: o.yaw ?? -Math.PI / 2 };
    const vol = { min: { x: x0, y, z: z0 }, max: { x: x1, y: y + 4, z: z1 } };
    if (o.role === 'start') {
      // Room for a whole race on the start: the middle first (solo runs use that one), then out to both sides.
      const gap = Math.min(1.2, (z1 - z0 - 1) / 6);
      this.spawns = [0, -1, 1, -2, 2, -3].map((k) => ({ pos: { x: x0 + 1.5, y: y + 0.02, z: zc + k * gap }, yaw: spawn.yaw }));
      this.triggers.push({ type: 'start', ...vol });
    } else if (o.role === 'checkpoint') {
      this.triggers.push({ type: 'checkpoint', ...vol, index: ++this.cps, spawn: spawn.pos, yaw: spawn.yaw });
    } else if (o.role === 'finish') {
      this.triggers.push({ type: 'finish', ...vol });
      this.block(x1, x1 + 1, z0 - 0.5, z1 + 0.5, y + 4, 'concreteDark', 'normal', 6); // the end: a wall to stop against
    }
    if (o.boost) {
      this.solids.push(box(x1 - 5, y - 0.02, z0 + 0.5, x1 - 0.5, y + 0.03, z1 - 0.5, 'conveyor'));
      this.triggers.push({ type: 'boost', min: { x: x1 - 5, y, z: z0 }, max: { x: x1, y: y + 2, z: z1 }, vel: { x: o.boost, y: 0, z: 0 } });
    }
  }

  /** A jump pad on a floor at y, x0..x1 across z0..z1. */
  pad(x0: number, x1: number, z0: number, z1: number, y: number, up = 13): void {
    this.triggers.push({ type: 'jumppad', min: { x: x0, y, z: z0 }, max: { x: x1, y: y + 0.5, z: z1 }, vel: { x: 0, y: up, z: 0 } });
  }

  /**
   * A wall beside a gap, at z = zw, x0..x1, from y-2 to y+6: run along it to get
   * across (z0..z1 is its thickness).
   */
  wall(x0: number, x1: number, z0: number, z1: number, y: number, mat: MatId = 'concreteDark'): void {
    this.solids.push(box(x0, y - 2, z0, x1, y + 6, z1, mat));
  }

  /** A teleporter pad on a floor at y: step in and you are at `dest`, still moving as you were. */
  portal(x0: number, x1: number, z0: number, z1: number, y: number, dest: Vec3, pair = 0): void {
    this.triggers.push({ type: 'teleporter', min: { x: x0, y, z: z0 }, max: { x: x1, y: y + 2, z: z1 }, dest, pair });
  }

  /** A platform that travels (dx, dy, dz) and back, waiting at each end. */
  mover(x0: number, x1: number, z0: number, z1: number, y: number, m: MoverDef, mat: MatId = 'metal', depth = 0.6): MoverDef {
    const s = box(x0, y - depth, z0, x1, y, z1, mat);
    s.mover = m;
    this.solids.push(s);
    return m;
  }

  build(c: Omit<Course, 'map' | 'checkpoints' | 'route'>, palette: Palette): Course {
    const map: MapDef = {
      name: c.name, seed: 0, solids: this.solids, triggers: this.triggers,
      spawns: this.spawns, pickups: [], bots: [],
      killY: c.fallY - 200, palette, extent: 40,
    };
    return { ...c, map, checkpoints: this.cps, route: this.route };
  }
}

const NOON: Palette = { // clear noon over a city
  sky: 0x8fc4e8, fogNear: 60, fogFar: 260, sun: 0xffffff, ambientSky: 0xd8ecf8, ambientGround: 0x4a5866,
  mats: { concrete: '#b9bec4', concreteDark: '#5d6670', tile: '#3f8a6f', metal: '#3a7fc0', hazard: '#f0c020', ice: '#c4e6f0', conveyor: '#2a2d32', lava: '#ff5a2a' },
};
const DUSK: Palette = { // orange dusk
  sky: 0xf0a070, fogNear: 55, fogFar: 240, sun: 0xffe0b0, ambientSky: 0xf8d0b0, ambientGround: 0x503a38,
  mats: { concrete: '#c4b4a4', concreteDark: '#6a5a54', tile: '#3a8a6a', metal: '#c0503a', hazard: '#f0d020', ice: '#9ab4d0', conveyor: '#2e2a30', lava: '#ff7a1a' },
};
const NIGHT: Palette = { // violet night
  sky: 0x2a2848, fogNear: 50, fogFar: 230, sun: 0xd0c0ff, ambientSky: 0x9088c8, ambientGround: 0x201c30,
  mats: { concrete: '#8c88a0', concreteDark: '#403c54', tile: '#3a8a7a', metal: '#7a4ae0', hazard: '#40f0c0', ice: '#a0d0f0', conveyor: '#2a2834', lava: '#ff3a8a' },
};

/**
 * ROOFTOPS: across a city at noon. Stepping stones, a crawlspace, a jump pad,
 * a roof of hurdles with a limbo bar, zigzag stones, a spiral round a tower,
 * a booster leap and two bounce pads over the street to the finish.
 */
function rooftops(): Course {
  const b = new Builder();
  const Y = 40;
  b.platform(-8, 6, -4, 4, Y, { role: 'start' });
  // stepping stones, 3 m apart, then steps up
  for (const [x, y] of [[9, Y], [16, Y], [23, Y], [30, Y + 1], [37, Y + 2], [44, Y + 3]]) {
    b.block(x, x + 4, -2, 2, y);
    b.go(x + 2, y, 0, 'run');
  }
  b.platform(51, 63, -4, 4, Y + 3, { role: 'checkpoint' });
  b.go(60, Y + 3, 0, 'run');
  // a crawlspace: 1.3 m high, crouch (or slide) through
  const T = Y + 3;
  b.block(63, 88, -2, 2, T, 'concrete', 'normal', 2);
  b.block(66, 78, -2, 2, T + 2.2, 'concreteDark', 'normal', 0.9); // the ceiling, 1.3 m up
  b.wall(66, 78, -2.6, -2, T - 4);
  b.wall(66, 78, 2, 2.6, T - 4);
  b.go(65, T, 0, 'run');
  b.go(79, T, 0, 'crouch');
  // a jump pad up to the next roof
  b.pad(83, 85, -2, 2, T);
  b.go(84, T, 0, 'run', { reach: 0.8 });
  const H = T + 3.5;
  b.platform(91, 103, -4, 4, H, { role: 'checkpoint' });
  b.go(95, H, 0, 'run', { reach: 2 });
  // a long roof of hurdles (jump them) and a limbo bar at the end (crouch under it)
  b.block(103, 140, -3, 3, H, 'concrete', 'normal', 2);
  for (const x of [109, 117, 125]) b.block(x, x + 0.4, -3, 3, H + 0.8, 'hazard', 'normal', 0.8);
  b.block(131, 134, -3, 3, H + 2.2, 'hazard', 'normal', 0.9); // the limbo bar, 1.3 m up
  b.go(129, H, 0, 'run', { reach: 1.5 });
  b.go(136, H, 0, 'crouch', { reach: 1.5 });
  // zigzag stones, each a little lower
  b.block(143, 146, 0.5, 3.5, H - 0.5);
  b.go(144.5, H - 0.5, 2, 'run');
  b.block(149, 152, -3.5, -0.5, H - 1);
  b.go(150.5, H - 1, -2, 'run');
  b.block(155, 158, 0.5, 3.5, H - 1.5);
  b.go(156.5, H - 1.5, 2, 'run');
  const C = H - 1.5;
  b.platform(161, 173, -4, 4, C, { role: 'checkpoint' });
  b.go(170, C, 0, 'run', { reach: 1.5 });
  // a spiral round a tower: thirteen roofs, each 0.9 m higher, all the way round and on
  const cx = 186, R = 7;
  b.block(cx - 2.5, cx + 2.5, -2.5, 2.5, C + 14, 'concreteDark', 'normal', 34); // the tower
  let top = C;
  for (let i = 0; i <= 12; i++) {
    const a = Math.PI - (i * Math.PI) / 4; // from the west side, clockwise seen from above
    const x = cx + Math.cos(a) * R, z = Math.sin(a) * R;
    top = C + 0.9 * (i + 1);
    b.block(x - 1.6, x + 1.6, z - 1.6, z + 1.6, top, 'metal');
    b.go(x, top, z, 'run', { reach: 1 });
  }
  // (the last roof is due east of the tower)
  const S = top;
  b.platform(cx + R + 4, cx + R + 16, -4, 4, S, { role: 'checkpoint', boost: 12 });
  b.go(cx + R + 7, S, 0, 'run', { reach: 1.5 });
  // a booster leap over the street, then two bounce pads, island to island
  const L = cx + R + 16; // 209
  b.platform(L + 7, L + 19, -4, 4, S - 1);
  b.go(L + 10, S - 1, 0, 'run', { reach: 2 });
  b.pad(L + 16, L + 18, -1.5, 1.5, S - 1);
  b.go(L + 17, S - 1, 0, 'run', { reach: 0.8 });
  b.block(L + 26, L + 32, -3, 3, S - 1);
  b.go(L + 28, S - 1, 0, 'run', { reach: 1.2 });
  b.pad(L + 29.5, L + 31.5, -1.5, 1.5, S - 1);
  b.go(L + 30.5, S - 1, 0, 'run', { reach: 0.8 });
  b.platform(L + 40, L + 54, -5, 5, S - 1, { role: 'finish' });
  b.go(L + 46, S - 1, 0, 'run');
  // Buildings under every roof (right under each one: no new ledges to land on). Not under bars or ceilings.
  for (const r of [...b.solids]) {
    if (r.mover || r.mat !== 'concrete' && r.mat !== 'tile' && r.mat !== 'hazard' || r.max.y - r.min.y > 2.5 || r.max.x - r.min.x < 2.5 || r.max.z - r.min.z < 2.5) continue;
    if (b.solids.some((o) => o !== r && o.max.y <= r.min.y + 0.01 && o.max.y > r.min.y - 3 && o.min.x < r.max.x && o.max.x > r.min.x && o.min.z < r.max.z && o.max.z > r.min.z)) continue; // something right below
    b.solids.push(box(r.min.x + 0.3, Y - 60, r.min.z + 0.3, r.max.x - 0.3, r.min.y, r.max.z - 0.3, 'concreteDark'));
  }
  return b.build({ id: 'rooftops', name: 'ROOFTOPS', difficulty: 'EASY', fallY: Y - 8,
    blurb: 'Stones, a crawlspace, hurdles and a limbo bar, a spiral round a tower, a booster leap and bounce pads over the street.' }, NOON);
}

/**
 * WALLWORKS: wall runs over gaps, a wall-jump chimney, a ferry and a lift on
 * the same beat, a bridge swept by sliding blocks, and a gauntlet of wall runs.
 */
function wallworks(): Course {
  const b = new Builder();
  const Y = 60;
  b.platform(-8, 6, -3, 3, Y, { role: 'start' });
  // the run-up, then a gap with a wall along its right: run along the wall to get across
  b.block(6, 20, -3, 3, Y, 'concrete', 'normal', 2);
  b.wall(19, 36, 3, 3.6, Y);
  b.go(13, Y, 2.55, 'hop', { reach: 1.5 });
  b.go(19.5, Y, 2.55, 'hop', { reach: 1.5 });
  b.block(30, 46, -3, 3, Y, 'concrete', 'normal', 2);
  b.go(33, Y, 2.4, 'wallrun', { reach: 2 });
  // and another, along a wall on the left
  b.wall(45, 64, -3.6, -3, Y);
  b.go(39, Y, -2.55, 'hop', { reach: 1.5 });
  b.go(45.5, Y, -2.55, 'hop', { reach: 1.5 });
  b.platform(56, 68, -3, 3, Y, { role: 'checkpoint' });
  b.go(59, Y, -2.4, 'wallrun', { reach: 2 });
  b.go(68, Y, 0, 'run', { reach: 1.5 });
  // a chimney: two walls close together and a ledge at its end, 3.2 m up. Wall jump up it.
  b.block(68, 72, -1.3, 1.3, Y, 'concrete', 'normal', 2);
  b.wall(68, 74, -2, -1.3, Y);
  b.wall(68, 74, 1.3, 2, Y);
  b.platform(72, 84, -3, 3, Y + 3.2, { role: 'checkpoint' });
  b.go(70, Y, 0, 'run', { reach: 0.6 });
  b.go(75, Y + 3.2, 0, 'climb', { reach: 1.5 });
  // a ferry over the void: it waits at each end
  const F = Y + 3.2;
  const ferry = b.mover(84.2, 88.2, -2, 2, F, { dx: 14, dy: 0, dz: 0, moveTime: 2, waitA: 1.2, waitB: 1.2, phase: 0 });
  b.go(83, F, 0, 'run', { reach: 0.8 });
  b.go(86, F, 0, 'run', { reach: 0.8, wait: (t) => restLeft(ferry, t, 0) > 0.5 });
  b.go(101, F, 0, 'run', { reach: 0.8, wait: (t) => restLeft(ferry, t, 1) > 0.5 });
  b.block(102.4, 112, -3, 3, F, 'concrete', 'normal', 2);
  // a lift: on the ferry's beat, so getting straight off one and onto the other works
  const lift = b.mover(112.2, 116.2, -2, 2, F, { dx: 0, dy: 5, dz: 0, moveTime: 2, waitA: 1.2, waitB: 1.2, phase: 1.5 });
  b.go(111, F, 0, 'run', { reach: 0.8 });
  b.go(114.2, F, 0, 'run', { reach: 0.8, wait: (t) => restLeft(lift, t, 0) > 0.4 });
  b.go(118, F + 5, 0, 'run', { reach: 0.8, wait: (t) => moverAt(lift, t) > 0.999 });
  const U = F + 5;
  b.platform(116.4, 128, -4, 4, U, { role: 'checkpoint' });
  b.go(124, U, 0, 'run', { reach: 1 });
  // a bridge swept by blocks sliding across it: cross each lane while its block rests off to one side
  b.block(128, 162, -1.5, 1.5, U, 'concrete', 'normal', 2);
  for (const [x, phase] of [[137, 0], [149, 1.1]] as const) {
    const m = b.mover(x, x + 2, -8.5, -6, U + 2.4, { dx: 0, dy: 0, dz: 14.5, moveTime: 1.1, waitA: 1.1, waitB: 1.1, phase }, 'hazard', 2.4);
    b.go(x - 2.5, U, 0, 'run', { reach: 0.6 });
    b.go(x + 4, U, 0, 'run', { reach: 1, wait: (t) => restLeft(m, t, 0) > 0.75 || restLeft(m, t, 1) > 0.75 });
  }
  b.platform(162, 174, -4, 4, U, { role: 'checkpoint' });
  b.go(166, U, 0, 'run', { reach: 1.5 });
  // the gauntlet: three wall runs in a row, right, left, right, with a roof to land on between each
  let edge = 186; // the end of the roof we run off
  b.block(174, edge, -3, 3, U, 'concrete', 'normal', 2);
  [1, -1, 1].forEach((side, k, all) => {
    b.wall(edge - 1, edge + 18, side > 0 ? 3 : -3.6, side > 0 ? 3.6 : -3, U);
    b.go(edge - 7, U, side * 2.55, 'hop', { reach: 1.5 });
    b.go(edge - 0.5, U, side * 2.55, 'hop', { reach: 1.5 });
    const land = edge + 10;
    const last = k === all.length - 1;
    if (last) b.platform(land, land + 14, -5, 5, U, { role: 'finish' });
    else b.block(land, land + 18, -3, 3, U, 'concrete', 'normal', 2);
    b.go(land + 3, U, side * 2.4, 'wallrun', { reach: 2 });
    if (last) b.go(land + 8, U, 0, 'run');
    edge = land + 18;
  });
  return b.build({ id: 'wallworks', name: 'WALLWORKS', difficulty: 'MEDIUM', fallY: Y - 8,
    blurb: 'Wall runs, a wall-jump chimney, a ferry and a lift, a bridge swept by sliding blocks and a gauntlet of three wall runs.' }, DUSK);
}

/**
 * SKYLINE: beams, a booster gap, ice, a belt running the wrong way, a
 * low-gravity leap, a chain of pads, a wall run, a portal up to a spire, a
 * long dive and a line of pillars to the finish.
 */
function skyline(): Course {
  const b = new Builder();
  const Y = 80;
  b.platform(-8, 6, -3, 3, Y, { role: 'start' });
  // beams, under a metre wide
  b.block(9, 21, -0.4, 0.4, Y, 'metal');
  b.go(12, Y, 0, 'run', { reach: 0.6 });
  b.go(20, Y, 0, 'run', { reach: 0.6 });
  b.block(24, 36, -0.4, 0.4, Y + 0.5, 'metal');
  b.go(27, Y + 0.5, 0, 'run', { reach: 0.6 });
  b.go(35, Y + 0.5, 0, 'run', { reach: 0.6 });
  // a booster and an 8 m gap
  b.platform(39, 49, -3, 3, Y + 0.5, { boost: 13 });
  b.go(41, Y + 0.5, 0, 'run');
  b.platform(57, 67, -3, 3, Y, { role: 'checkpoint' });
  b.go(60, Y, 0, 'run');
  // ice: no grip to stop, then a belt running back at you
  b.block(67, 81, -3, 3, Y, 'ice', 'ice', 2);
  b.go(80, Y, 0, 'run', { reach: 1.5 });
  const belt = b.block(85, 97, -2, 2, Y + 0.5, 'conveyor');
  belt.push = { x: -4, y: 0, z: 0 };
  b.go(96, Y + 0.5, 0, 'run', { reach: 1.5 });
  // a gap with low gravity: a long, floaty jump
  b.platform(97, 106, -3, 3, Y + 0.5);
  b.triggers.push({ type: 'lowgrav', min: { x: 104, y: Y - 6, z: -6 }, max: { x: 121, y: Y + 12, z: 6 }, scale: 0.35 });
  b.go(104, Y + 0.5, 0, 'run', { reach: 1 });
  b.platform(119, 129, -3, 3, Y + 1.5, { role: 'checkpoint' });
  b.go(122, Y + 1.5, 0, 'run', { reach: 2 });
  // pads up, from one to the next
  const P = Y + 1.5;
  b.pad(126, 128, -1.5, 1.5, P);
  b.go(127, P, 0, 'run', { reach: 0.8 });
  b.block(133, 138, -2.5, 2.5, P + 3.5);
  b.go(134.5, P + 3.5, 0, 'run', { reach: 1 });
  b.pad(135.5, 137.5, -1.5, 1.5, P + 3.5);
  b.go(136.5, P + 3.5, 0, 'run', { reach: 0.8 });
  b.block(143, 156, -3, 3, P + 7);
  b.go(146, P + 7, 2.2, 'run', { reach: 1.5 });
  // a wall run over a gap
  const W = P + 7;
  b.wall(155, 174, 3, 3.6, W);
  b.go(150, W, 2.55, 'hop', { reach: 1.5 });
  b.go(155.5, W, 2.55, 'hop', { reach: 1.5 });
  b.platform(165, 177, -4, 4, W, { role: 'checkpoint' });
  b.go(170, W, 2.4, 'wallrun', { reach: 2 });
  b.go(172, W, 0, 'run', { reach: 1.5 });
  // a portal at the end of the roof: up to the top of a spire
  b.block(177, 183, -3, 3, W, 'concrete', 'normal', 2);
  b.block(183, 184, -3, 3, W + 4, 'concreteDark', 'normal', 6); // a wall behind the portal
  b.portal(180.5, 182.5, -1, 1, W, { x: 190, y: W + 18.02, z: 0 }, 1);
  b.go(181.5, W, 0, 'run', { reach: 0.4 });
  // the spire: from its top, dive onto the roof far below
  const T = W + 18;
  b.block(187, 197, -3, 3, T, 'metal', 'normal', 2);
  b.block(189, 195, -2, 2, T - 2, 'concreteDark', 'normal', 30);
  b.go(195, T, 0, 'run', { reach: 1 });
  const D = W - 2;
  b.platform(208, 222, -4, 4, D, { role: 'checkpoint' });
  b.go(212, D, 0, 'run', { reach: 2 });
  // pillars: 3.5 m long and 2 m wide, 2 m apart, up and down: a run of jumps, no stopping
  let px = 224;
  for (const dy of [0, 0.5, 1, 0.5, 0, -0.5, 0, 0.6]) {
    b.block(px, px + 3.5, -1, 1, D + dy, 'metal');
    b.go(px + 1.75, D + dy, 0, 'run', { reach: 1.2, land: true });
    px += 5.5;
  }
  b.platform(px + 0.5, px + 14.5, -5, 5, D, { role: 'finish' });
  b.go(px + 7, D, 0, 'run');
  return b.build({ id: 'skyline', name: 'SKYLINE', difficulty: 'HARD', fallY: Y - 8,
    blurb: 'Beams, ice, a belt running the wrong way, low gravity, pads, a wall run, a portal to a spire, a dive and a line of pillars.' }, NIGHT);
}

export const COURSES: Course[] = [rooftops(), wallworks(), skyline()];

export const courseById = (id: string): Course | undefined => COURSES.find((c) => c.id === id);
