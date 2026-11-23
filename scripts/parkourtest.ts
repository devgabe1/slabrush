// PARKOUR tests: `npm run test:parkour`.
// The clock and checkpoints, and an autopilot that runs every course's route
// from the start to the finish (so each course is known to be finishable
// without a fall).
import { DT } from '../src/config/game';
import { COURSES } from '../src/maps/parkour';
import { newPilot, pilot } from '../src/maps/parkourPilot';
import { ParkourSession, formatTime } from '../src/net/parkourSession';
import { GameSim } from '../src/sim/game';
import type { InputCmd } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number) => n.toFixed(2);
const YAW = -Math.PI / 2; // looking along +x: forward is +x, right is +z

for (const c of COURSES) {
  const s = new ParkourSession(c, 'BOT');
  const p = s.player;
  const sim = (s as unknown as { sim: GameSim }).sim;
  const st = newPilot();
  const probe = {
    floor: (x: number, y: number, z: number) => sim.world.traceBox({ x, y: y + 0.1, z }, { x, y: y - 0.5, z }, { x: -0.3, y: 0, z: -0.3 }, { x: 0.3, y: 0.1, z: 0.3 }).fraction < 1,
    solid: (x: number, y: number, z: number) => sim.world.traceBox({ x, y, z }, { x, y, z }, { x: -0.05, y: 0, z: -0.05 }, { x: 0.05, y: 0.05, z: 0.05 }).startSolid,
  };
  let i = 0, minY = Infinity, top = 0;
  for (; i < 600 / DT && s.run.phase !== 'finished'; i++) {
    sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW, ...pilot(c, p, sim.tick + 1, st, probe) });
    s.step();
    minY = Math.min(minY, p.pos.y);
    top = Math.max(top, Math.hypot(p.vel.x, p.vel.z));
    if (s.run.falls > 0) break;
  }
  const r = s.run;
  check(`${c.name}: the autopilot finishes without falling`, r.phase === 'finished' && r.falls === 0,
    `${r.phase}, ${formatTime(r.ticks)}, checkpoints ${r.cp}/${c.checkpoints}, falls ${r.falls}, top speed ${f(top)} m/s, waypoint ${st.i}/${c.route.length}, at x ${f(p.pos.x)} y ${f(p.pos.y)} z ${f(p.pos.z)}`);
  check(`${c.name}: every checkpoint was passed`, r.cp === c.checkpoints);
}

// ------------------------------------------------------------ scenery stays clear of the course
for (const c of COURSES) {
  const m = c.map;
  // Fires (braziers, obelisk tops) never sit inside or under anything solid, nor on the course itself.
  const flames = (m.life ?? []).flatMap((l) => (l.kind === 'flame' ? [l.pos] : []));
  const buried = flames.filter((f) => m.solids.some((s) => f.x > s.min.x - 0.3 && f.x < s.max.x + 0.3 && f.z > s.min.z - 0.3 && f.z < s.max.z + 0.3
    && s.max.y > f.y + 0.05 && s.min.y < f.y + 3));
  const onCourse = flames.filter((f) => m.triggers.some((t) => (t.type === 'checkpoint' || t.type === 'finish' || t.type === 'start')
    && f.x > t.min.x && f.x < t.max.x && f.z > t.min.z && f.z < t.max.z));
  check(`${c.name}: no fire comes up through the course`, buried.length === 0 && onCourse.length === 0, `${flames.length} fires, ${buried.length} under something, ${onCourse.length} on a platform`);
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
