import type { Vec3 } from '../core/vec';
import { box, surfRidge, type MapDef, type Palette, type Solid, type Trigger } from '../sim/map';

// PARKOUR: hand-built surf courses. Ride the steep ramps (hold the strafe key
// towards the ramp to stay on it), drop from one to the next, and get from the
// start platform to the finish as fast as you can. Every course runs along +x.
//
// Each course also carries a `line`: where on it to be, piece by piece. The
// autopilot in scripts/parkourtest.ts rides that line to prove the course can
// be finished; the game itself does not use it.

export interface CourseLine {
  /** 'surf': ride a ramp face; 'floor': run along a platform. */
  kind: 'surf' | 'floor';
  x0: number;
  x1: number;
  /** surf: the face's middle (z) and which way it faces (+1: its slope looks towards +z) */
  z: number;
  face: 1 | -1;
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
  line: CourseLine[];
}

class Builder {
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  line: CourseLine[] = [];
  spawn: { pos: Vec3; yaw: number } | null = null;
  private cps = 0;
  get checkpoints(): number { return this.cps; }

  /**
   * A flat platform, top at y. `boost` lays a booster strip across its far (+x)
   * end that sends you off at that speed. `role` makes it the start, a
   * checkpoint or the finish.
   */
  platform(x0: number, x1: number, z0: number, z1: number, y: number, o: { boost?: number; role?: 'start' | 'checkpoint' | 'finish' } = {}): void {
    this.solids.push(box(x0, y - 2, z0, x1, y, z1, o.role === 'finish' ? 'hazard' : 'concrete'));
    // a low rim on the sides, so the run-up stays on the platform
    this.solids.push(box(x0, y, z0 - 0.6, x1, y + 0.5, z0, 'concreteDark'));
    this.solids.push(box(x0, y, z1, x1, y + 0.5, z1 + 0.6, 'concreteDark'));
    const zc = (z0 + z1) / 2;
    const spawn = { pos: { x: x0 + 2.5, y: y + 0.02, z: zc }, yaw: -Math.PI / 2 };
    const vol = (a: number, b: number) => ({ min: { x: a, y, z: z0 }, max: { x: b, y: y + 4, z: z1 } });
    if (o.role === 'start') {
      this.spawn = spawn;
      this.triggers.push({ type: 'start', ...vol(x0, x1) });
    } else if (o.role === 'checkpoint') {
      this.triggers.push({ type: 'checkpoint', ...vol(x0, x1), index: ++this.cps, spawn: spawn.pos, yaw: spawn.yaw });
    } else if (o.role === 'finish') {
      this.triggers.push({ type: 'finish', ...vol(x0, x1) });
      this.solids.push(box(x1, y - 2, z0 - 0.6, x1 + 1, y + 5, z1 + 0.6, 'concreteDark')); // the end: a wall to stop against
    }
    if (o.boost) {
      this.solids.push(box(x1 - 7, y - 0.02, z0 + 1, x1 - 1, y + 0.03, z1 - 1, 'conveyor'));
      this.triggers.push({ type: 'boost', min: { x: x1 - 7, y, z: z0 }, max: { x: x1, y: y + 2, z: z1 }, vel: { x: o.boost, y: 0, z: 0 } });
    }
    this.line.push({ kind: 'floor', x0, x1, z: zc, face: 1 });
  }

  /**
   * A surf ramp along x: its crest goes from (x0, y0) to (x1, y1) at z = zc;
   * each slope is w across and h high. `ride` is the face the line uses.
   */
  ridge(x0: number, y0: number, x1: number, y1: number, zc: number, w: number, h: number, sides: 'both' | '-z' | '+z', ride: 1 | -1 = -1): void {
    this.solids.push(surfRidge(x0, y0, x1, y1, zc, w, h, 'metal', sides));
    const face = sides === 'both' ? ride : sides === '+z' ? 1 : -1;
    this.line.push({ kind: 'surf', x0, x1, z: zc + face * w / 2, face });
  }

  build(c: Omit<Course, 'map' | 'checkpoints' | 'line'>, palette: Palette, killY: number): Course {
    const map: MapDef = {
      name: c.name, seed: 0, solids: this.solids, triggers: this.triggers,
      spawns: [this.spawn!], pickups: [], bots: [],
      killY, palette, extent: 40,
    };
    return { ...c, map, checkpoints: this.cps, line: this.line };
  }
}

const SKY: Palette = { // clear noon
  sky: 0x8fc4e8, fogNear: 120, fogFar: 520, sun: 0xffffff, ambientSky: 0xd8ecf8, ambientGround: 0x4a5866,
  mats: { concrete: '#b9bec4', concreteDark: '#5d6670', tile: '#3f6f8a', metal: '#3a7fc0', hazard: '#f0c020', ice: '#c4e6f0', conveyor: '#2a2d32', lava: '#ff5a2a' },
};
const DUSK: Palette = { // orange dusk
  sky: 0xf0a070, fogNear: 110, fogFar: 480, sun: 0xffe0b0, ambientSky: 0xf8d0b0, ambientGround: 0x503a38,
  mats: { concrete: '#c4b4a4', concreteDark: '#6a5a54', tile: '#a03a3a', metal: '#c0503a', hazard: '#f0d020', ice: '#9ab4d0', conveyor: '#2e2a30', lava: '#ff7a1a' },
};
const NIGHT: Palette = { // violet night
  sky: 0x2a2848, fogNear: 100, fogFar: 460, sun: 0xd0c0ff, ambientSky: 0x9088c8, ambientGround: 0x201c30,
  mats: { concrete: '#8c88a0', concreteDark: '#403c54', tile: '#5a3a8a', metal: '#7a4ae0', hazard: '#40f0c0', ice: '#a0b8e0', conveyor: '#2a2834', lava: '#ff3a8a' },
};

/** FIRST WAVE: wide two-sided ramps, a platform between each. Learn to hold on. */
function firstWave(): Course {
  const b = new Builder();
  b.platform(-12, 12, -8, 8, 80, { role: 'start', boost: 16 });
  b.ridge(16, 77, 136, 60, 0, 8, 10, 'both');
  b.platform(144, 184, -12, 12, 44, { role: 'checkpoint', boost: 20 });
  b.ridge(188, 41, 330, 18, 0, 8, 10, 'both');
  b.platform(340, 380, -12, 12, 2, { role: 'checkpoint', boost: 22 });
  b.ridge(384, -1, 484, -16, 0, 8, 10, 'both');
  b.ridge(494, -20, 604, -36, 0, 8, 10, 'both');
  b.platform(616, 656, -14, 14, -52, { role: 'finish' });
  return b.build({ id: 'firstwave', name: 'FIRST WAVE', difficulty: 'EASY', fallY: -80,
    blurb: 'Wide ramps and a platform after each. Hold the strafe key towards the ramp to stay on it.' }, SKY, -400);
}

/**
 * ZIGZAG: one-sided ramps that face each other across a gap, each lower than
 * the last. Ride one, then steer across to the next.
 */
function zigzag(): Course {
  const b = new Builder();
  b.platform(-12, 12, -6, 6, 90, { role: 'start', boost: 18 });
  // Left ramp (crest at z -4, sloping down towards +z), right ramp (crest at z 22, sloping towards -z), ...
  // Each starts 30 m before the last one ends, its crest about level with the bottom of the
  // last one's face: across the gap you fall that far, so you land on its face.
  const W = 8, H = 12;
  let x = 16, y = 88;
  const leg = (zc: number, sides: '+z' | '-z', len: number, drop: number) => {
    b.ridge(x, y, x + len, y - drop, zc, W, H, sides);
    const next = x + len - 30;
    y = y - drop * ((next - x) / len) - 10;
    x = next;
  };
  leg(-4, '+z', 100, 12);
  leg(22, '-z', 100, 12);
  leg(-4, '+z', 100, 12);
  // checkpoint
  const cpY = y - 6;
  b.platform(x + 30, x + 70, -8, 18, cpY, { role: 'checkpoint', boost: 22 });
  x += 74; y = cpY - 2;
  leg(-4, '+z', 100, 14);
  leg(22, '-z', 100, 14);
  leg(-4, '+z', 100, 14);
  leg(22, '-z', 100, 14);
  const finY = y - 6;
  b.platform(x + 32, x + 72, -10, 30, finY, { role: 'finish' });
  return b.build({ id: 'zigzag', name: 'ZIGZAG', difficulty: 'MEDIUM', fallY: finY - 30,
    blurb: 'Ramps facing each other across a gap. Ride one, let go and steer across to the next, lower one.' }, DUSK, -600);
}

/** FREEFALL: narrow, steep, fast. Long drops between ramps and few places to rest. */
function freefall(): Course {
  const b = new Builder();
  b.platform(-12, 12, -5, 5, 120, { role: 'start', boost: 20 });
  // a steep dive to build speed
  b.ridge(16, 117, 136, 88, 0, 6, 10, 'both');
  // kinks: each ramp shifted sideways and 8 m lower, so you drop from one ramp's
  // face onto the facing slope of the next
  b.ridge(142, 80, 232, 62, -6, 6, 10, 'both', 1);
  b.ridge(238, 54, 328, 36, 0, 6, 10, 'both');
  b.platform(340, 376, -8, 12, 20, { role: 'checkpoint', boost: 24 });
  // a long gap: you need the booster's speed and the dive to cross it
  b.ridge(380, 17, 462, -2, 4, 6, 10, 'both');
  b.ridge(488, -20, 588, -42, 4, 6, 10, 'both');
  b.ridge(594, -50, 694, -72, -2, 6, 10, 'both', 1);
  b.ridge(700, -80, 800, -104, 4, 6, 10, 'both');
  b.platform(812, 852, -16, 22, -120, { role: 'finish' });
  return b.build({ id: 'freefall', name: 'FREEFALL', difficulty: 'HARD', fallY: -150,
    blurb: 'Narrow, steep ramps, sideways hops between them and one long gap. Keep your speed.' }, NIGHT, -800);
}

export const COURSES: Course[] = [firstWave(), zigzag(), freefall()];

export const courseById = (id: string): Course | undefined => COURSES.find((c) => c.id === id);
