// PARKOUR tests: `npm run test:parkour`.
// Surf mechanics on a test ramp, the clock and checkpoints, and an autopilot
// that rides every course's line from the start to the finish (so each course
// is known to be finishable without a fall).
import { DT } from '../src/config/game';
import { COURSES, type Course } from '../src/maps/parkour';
import { buildTestMap } from '../src/maps/testMap';
import { ParkourSession, formatTime } from '../src/net/parkourSession';
import { GameSim } from '../src/sim/game';
import { box, surfRidge, type MapDef } from '../src/sim/map';
import { RULES_PRACTICE } from '../src/config/game';
import type { InputCmd, Player } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number) => n.toFixed(2);
const YAW = -Math.PI / 2; // looking along +x: forward is +x, right is +z

// ------------------------------------------------------------ surf mechanics
function ramp(y0: number, y1: number): { sim: GameSim; p: Player } {
  const map: MapDef = { ...buildTestMap(), solids: [surfRidge(-10, y0, 300, y1, 0, 6, 8, 'metal'), box(-20, -80, -20, -10, -79, 20, 'metal')], triggers: [], pickups: [], bots: [], killY: -100 };
  const sim = new GameSim(map, 1, RULES_PRACTICE);
  sim.pickups.length = 0;
  const p = sim.addPlayer(1, 'T', 0xffffff);
  const top = y0 + (y1 - y0) * 10 / 310;
  p.pos = { x: 0, y: top - 4 + 0.7, z: -3 }; // on the -z face, halfway down
  p.vel = { x: 15, y: 0, z: 0 };
  return { sim, p };
}
function ride(sim: GameSim, p: Player, seconds: number, moveR: number): void {
  for (let i = 0; i < seconds / DT; i++) {
    sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR, pitch: 0, yaw: YAW });
    sim.step();
  }
}
{
  const { sim, p } = ramp(40, 40);
  ride(sim, p, 0.3, 1);
  check('a slope too steep to stand on is surfed', p.surfing && !p.grounded);
  ride(sim, p, 2.7, 1);
  check('holding towards the ramp keeps you on it, at speed', p.surfing && p.vel.x > 14, `x speed ${f(p.vel.x)}, y ${f(p.pos.y)}`);
}
{
  const { sim, p } = ramp(40, 40);
  ride(sim, p, 2, 0);
  check('letting go slides you down and off it', !p.surfing && p.pos.y < 30, `y ${f(p.pos.y)}`);
}
{
  const { sim, p } = ramp(40, 0);
  ride(sim, p, 4, 1);
  check('a ramp running downhill speeds you up', p.vel.x > 22, `x speed ${f(p.vel.x)}`);
}
{
  // Keep holding towards the ramp and you creep up and over the crest: you keep going (it is not a floor).
  const { sim, p } = ramp(40, 40);
  ride(sim, p, 0.5, 1);
  const vx = p.vel.x;
  let maxDrop = 0, crossed = false;
  for (let i = 0; i < 9 / DT && !crossed; i++) { ride(sim, p, DT, 1); maxDrop = Math.max(maxDrop, vx - p.vel.x); crossed = p.pos.z > 0.5; }
  check('crossing the crest keeps your speed', crossed && maxDrop < 2, `crossed ${crossed}, lost up to ${f(maxDrop)} m/s`);
}

// ------------------------------------------------------------ autopilot
/** Inputs that ride the course's line. */
function pilot(c: Course, p: Player): Partial<InputCmd> {
  // The piece to be on: the next one once we are a few metres into it (ramps that
  // overlap: transfer across), or once the one before it is about to end.
  const speed = Math.hypot(p.vel.x, p.vel.z), x = p.pos.x;
  let seg = c.line[0];
  c.line.forEach((s, k) => { if (x >= s.x0 + 6 || (k > 0 && x >= c.line[k - 1].x1 - speed * 0.2)) seg = s; });
  const dz = seg.z - p.pos.z;
  if (p.grounded) return { moveF: 1, moveR: Math.max(-1, Math.min(1, dz * 0.5)) };
  if (p.surfing) {
    if (seg.kind === 'surf' && Math.abs(dz) < 3) {
      // On the ramp we want: hold towards it while below the middle of the face, else let it slide.
      const low = (p.pos.z - seg.z) * seg.face > 0;
      return { moveR: low ? -seg.face : 0 };
    }
    return { moveR: Math.sign(dz) }; // leave it, towards the next one
  }
  return { moveF: 1, moveR: Math.max(-1, Math.min(1, dz * 0.15)) };
}

for (const c of COURSES) {
  const s = new ParkourSession(c, 'BOT');
  const p = s.player;
  let i = 0, minY = Infinity, top = 0;
  for (; i < 180 / DT && s.run.phase !== 'finished'; i++) {
    (s as unknown as { sim: GameSim }).sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW, ...pilot(c, p) });
    s.step();
    minY = Math.min(minY, p.pos.y);
    top = Math.max(top, Math.hypot(p.vel.x, p.vel.z));
    if (s.run.falls > 0) break;
  }
  const r = s.run;
  check(`${c.name}: the autopilot finishes without falling`, r.phase === 'finished' && r.falls === 0,
    `${r.phase}, ${formatTime(r.ticks)}, checkpoints ${r.cp}/${c.checkpoints}, falls ${r.falls}, top speed ${f(top)} m/s, at x ${f(p.pos.x)} y ${f(p.pos.y)} z ${f(p.pos.z)}`);
  check(`${c.name}: every checkpoint was passed`, r.cp === c.checkpoints);
}

// ------------------------------------------------------------ clock
{
  const c = COURSES[0];
  const s = new ParkourSession(c, 'T');
  const p = s.player;
  const sim = (s as unknown as { sim: GameSim }).sim;
  const tick = (cmd: Partial<InputCmd>) => { sim.setInput(1, { seq: 0, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW, ...cmd }); s.step(); };
  for (let i = 0; i < 30; i++) tick({});
  check('standing on the start, the clock does not run', s.run.phase === 'ready' && s.run.ticks === 0);
  for (let i = 0; i < 240 && s.run.phase === 'ready'; i++) tick({ moveF: 1 });
  check('leaving the start starts it', s.run.phase === 'running');
  // Fall before any checkpoint: back on the start, clock reset.
  p.pos.y = c.fallY - 1;
  tick({});
  check('a fall before the first checkpoint starts over', s.run.phase === 'ready' && s.run.ticks === 0 && Math.abs(p.pos.x - c.map.spawns[0].pos.x) < 0.5, `x ${f(p.pos.x)}`);
  // Jump to the first checkpoint, then fall: back there, clock still running.
  for (let i = 0; i < 240 && s.run.phase === 'ready'; i++) tick({ moveF: 1 });
  const cp = c.map.triggers.find((t) => t.type === 'checkpoint' && t.index === 1)!;
  if (cp.type === 'checkpoint') p.pos = { ...cp.spawn };
  tick({});
  check('a checkpoint is reached', s.run.cp === 1 && s.run.split?.cp === 1);
  p.pos.y = c.fallY - 1;
  const before = s.run.ticks;
  tick({});
  check('a fall after it puts you back on it, clock running', s.run.phase === 'running' && s.run.ticks > before && cp.type === 'checkpoint' && Math.abs(p.pos.x - cp.spawn.x) < 0.5);
  s.restart();
  check('restart: back on the start, clock reset', s.run.phase === 'ready' && s.run.ticks === 0 && s.run.cp === 0);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('parkour tests failed');
