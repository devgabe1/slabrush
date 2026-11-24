// PARKOUR tests: `npm run test:parkour`.
// The clock and checkpoints, and an autopilot that runs every course's route
// from the start to the finish (so each course is known to be finishable
// without a fall).
import { DT } from '../src/config/game';
import { COURSES } from '../src/maps/parkour';
import { newPilot, pilot } from '../src/maps/parkourPilot';
import { ParkourSession, formatTime } from '../src/net/parkourSession';
import { GameSim } from '../src/sim/game';
import { BTN, type InputCmd } from '../src/sim/types';

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
  // (spears and spikes are not floor: the pilot jumps them)
  const probe = {
    floor: (x: number, y: number, z: number) => { const tr = sim.world.traceBox({ x, y: y + 0.1, z }, { x, y: y - 0.5, z }, { x: -0.3, y: 0, z: -0.3 }, { x: 0.3, y: 0.1, z: 0.3 }); return tr.fraction < 1 && tr.surface !== 'deadly'; }, 
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

// ------------------------------------------------------------ torches stand on their plinths
{
  const c = COURSES.find((x) => x.id === 'dunetemple')!;
  const sand = Math.max(...c.map.solids.filter((x) => x.mat === 'sand' && x.max.x - x.min.x > 500).map((x) => x.max.y));
  // the braziers beside the checkpoints (size 0.75; the statue's fire, the tomb's torches and its gate fires are other sizes)
  const fires = (c.map.life ?? []).flatMap((l) => (l.kind === 'flame' && l.size === 0.75 ? [l.pos] : []));
  // each brazier's post: the slim block right under its fire
  const posts = fires.map((f) => c.map.solids.find((x) => x.max.x - x.min.x < 1 && f.x > x.min.x && f.x < x.max.x && f.z > x.min.z && f.z < x.max.z && x.max.y <= f.y + 0.01 && x.max.y > f.y - 0.5)).filter((x) => !!x);
  // ...stands on a wider plinth right under it, which floats: short, nowhere near the sand
  const plinth = (p: (typeof posts)[number]) => c.map.solids.find((x) => Math.abs(x.max.y - p!.min.y) < 0.01 && x.min.x < p!.min.x && x.max.x > p!.max.x && x.min.z < p!.min.z && x.max.z > p!.max.z);
  const bad = posts.filter((p) => { const q = plinth(p); return !q || p!.max.y - p!.min.y > 2 || q.min.y < sand + 10; });
  check('DUNE TEMPLE: every torch stands on its own floating plinth', posts.length >= 12 && bad.length === 0, `${posts.length} posts, ${bad.length} without one`);
}

// ------------------------------------------------------------ the tomb's traps kill
{
  const c = COURSES.find((x) => x.id === 'dunetemple')!;
  const trap = (name: string, place: (p: { pos: { x: number; y: number; z: number } }, sim: GameSim) => void) => {
    const s = new ParkourSession(c, 'T');
    const p = s.player;
    const sim = (s as unknown as { sim: GameSim }).sim;
    // as if running: on the checkpoint before the tomb's traps
    const cp = c.map.triggers.filter((t) => t.type === 'checkpoint').at(-5)!;
    s.run.phase = 'running'; s.run.cp = cp.type === 'checkpoint' ? cp.index : 0;
    place(p, sim);
    let i = 0;
    for (; i < 240 && s.run.falls === 0; i++) { sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW }); s.step(); }
    check(`DUNE TEMPLE: ${name}`, s.run.falls === 1, `back on a checkpoint after ${f(i * DT)} s`);
  };
  const movers = c.map.solids.filter((x) => x.mover);
  const crusher = movers.find((x) => x.mover!.dy === -3.5)!;
  trap('a crusher coming down on you kills you', (p, sim) => {
    p.pos = { x: (crusher.min.x + crusher.max.x) / 2, y: crusher.min.y - 3.5 + 0.02, z: (crusher.min.z + crusher.max.z) / 2 };
  });
  const bed = c.map.solids.find((x) => x.surface === 'deadly' && x.mat === 'stone')!;
  trap('falling into a pit of spikes kills you', (p) => {
    // over a spike pit: a spike under the middle of the first pit
    const spike = c.map.solids.find((x) => x.surface === 'deadly' && x.mat === 'iron' && x.min.x > bed.min.x && x.max.x < bed.max.x && x.min.z > bed.min.z && x.max.z < bed.max.z)!;
    p.pos = { x: (spike.min.x + spike.max.x) / 2, y: spike.max.y + 2, z: (spike.min.z + spike.max.z) / 2 };
  });
  const fires = c.map.triggers.filter((t) => t.type === 'fire');
  const wall = fires.find((f) => f.max.y - f.min.y > 2.5)!, high = fires.find((f) => f.min.y - wall.min.y > 1)!;
  trap('stand in a jet of fire as it lights and you burn', (p) => {
    p.pos = { x: (wall.min.x + wall.max.x) / 2, y: wall.min.y + 0.02, z: (wall.min.z + wall.max.z) / 2 };
  });
  {
    // crouched under a high jet: it burns over you, you live
    const s = new ParkourSession(c, 'T');
    const sim = (s as unknown as { sim: GameSim }).sim;
    s.run.phase = 'running'; s.run.cp = 40;
    s.player.pos = { x: (high.min.x + high.max.x) / 2, y: high.min.y - 1.3 + 0.02, z: (high.min.z + high.max.z) / 2 };
    for (let i = 0; i < 240; i++) { sim.setInput(1, { seq: i, buttons: BTN.CROUCH, moveF: 0, moveR: 0, pitch: 0, yaw: YAW }); s.step(); }
    check('DUNE TEMPLE: crouched under a high jet of fire, it burns over you and you live', s.run.falls === 0 && s.player.alive);
  }
}

// ------------------------------------------------------------ the great pyramid: Giza-sized, not a mountain
{
  const c = COURSES.find((x) => x.id === 'dunetemple')!;
  const rings = c.map.solids.filter((x) => x.mat === 'sandstone' && x.max.x - x.min.x > 60);
  const wide = Math.max(...rings.map((x) => Math.max(x.max.x - x.min.x, x.max.z - x.min.z)));
  check('DUNE TEMPLE: the pyramid round the tomb is a sensible size', rings.length > 0 && wide < 420, `${wide.toFixed(0)} m across`);
}

// ------------------------------------------------------------ BLOCKLANDS: through the gate, into the underrealm
{
  const c = COURSES.find((x) => x.id === 'blocklands')!;
  const gate = c.map.triggers.find((t) => t.type === 'teleporter');
  const lands = gate?.type === 'teleporter' && c.map.triggers.some((t) => t.type === 'checkpoint'
    && gate.dest.x > t.min.x && gate.dest.x < t.max.x && gate.dest.z > t.min.z && gate.dest.z < t.max.z && Math.abs(gate.dest.y - t.min.y) < 0.1);
  const far = gate ? Math.hypot(gate.dest.x - gate.min.x, gate.dest.z - gate.min.z) : 0;
  const cavern = c.map.triggers.some((t) => t.type === 'dark' && gate?.type === 'teleporter' && gate.dest.x > t.min.x && gate.dest.x < t.max.x && gate.dest.z > t.min.z && gate.dest.z < t.max.z);
  check('BLOCKLANDS: the gate leads onto a checkpoint in the underrealm, far off, in its haze', lands && far > 600 && cavern, `${far.toFixed(0)} m away`);
  // a stone sinking into the lava takes you with it
  const s = new ParkourSession(c, 'T');
  const p = s.player;
  const sim = (s as unknown as { sim: GameSim }).sim;
  s.run.phase = 'running'; s.run.cp = c.checkpoints - 5;
  const stone = c.map.solids.find((x) => x.mover && x.mover.dy < 0)!;
  p.pos = { x: (stone.min.x + stone.max.x) / 2, y: stone.max.y + 0.02, z: (stone.min.z + stone.max.z) / 2 };
  let i = 0;
  for (; i < 600 && s.run.falls === 0; i++) { sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW }); s.step(); }
  check('BLOCKLANDS: standing on a stone as it sinks into the lava kills you', s.run.falls === 1, `after ${f(i * DT)} s`);
}

// ------------------------------------------------------------ BLOCKLANDS: the second gate, the starreach, the dragon
{
  const c = COURSES.find((x) => x.id === 'blocklands')!;
  const gates = c.map.triggers.filter((t) => t.type === 'teleporter');
  const second = gates[1];
  const lands = second?.type === 'teleporter' && c.map.triggers.some((t) => t.type === 'checkpoint'
    && second.dest.x > t.min.x && second.dest.x < t.max.x && second.dest.z > t.min.z && second.dest.z < t.max.z);
  const voidHaze = second?.type === 'teleporter' && c.map.triggers.some((t) => t.type === 'dark' && t.fog && second.dest.x > t.min.x && second.dest.x < t.max.x && second.dest.z > t.min.z && second.dest.z < t.max.z);
  check('BLOCKLANDS: a second gate, at the end of the underrealm, leads into the starreach', gates.length === 2 && lands && voidHaze);
  const fin = c.map.triggers.find((t) => t.type === 'finish')!;
  const dragon = (c.map.life ?? []).find((l) => l.kind === 'dragon');
  const over = dragon?.kind === 'dragon' && Math.hypot(dragon.center.x - (fin.min.x + fin.max.x) / 2, dragon.center.z - (fin.min.z + fin.max.z) / 2) < 12 && dragon.center.y > fin.min.y + 10;
  check('BLOCKLANDS: the dragon waits at the end, circling over the finish', !!over);
}

// ------------------------------------------------------------ DUNE TEMPLE's own obstacles
{
  const c = COURSES.find((x) => x.id === 'dunetemple')!;
  const fresh = () => {
    const s = new ParkourSession(c, 'T');
    const sim = (s as unknown as { sim: GameSim }).sim;
    s.run.phase = 'running'; s.run.cp = 3;
    return { s, p: s.player, sim };
  };
  const tick = (x: ReturnType<typeof fresh>, n: number) => {
    for (let i = 0; i < n && x.s.run.falls === 0; i++) { x.sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, yaw: YAW }); x.s.step(); }
  };
  // The boulder: stand in the hall in its path, and it crushes you against the end.
  const boulder = c.map.solids.find((x) => x.mover && Math.abs(x.mover.dx) + Math.abs(x.mover.dz) > 25)!;
  const b = fresh();
  const along = Math.abs(boulder.mover!.dx) > 0 ? 'x' : 'z', sg = Math.sign(boulder.mover!.dx || boulder.mover!.dz);
  const mid = { x: (boulder.min.x + boulder.max.x) / 2, z: (boulder.min.z + boulder.max.z) / 2 };
  b.p.pos = { ...mid, [along]: mid[along] + sg * 14, y: boulder.min.y + 0.02 } as { x: number; y: number; z: number };
  tick(b, 600);
  check('DUNE TEMPLE: the rolling boulder crushes you if you do not get out of its way', b.s.run.falls === 1);
  // The sand river drags you sideways off a causeway if you just stand on it.
  const belt = c.map.solids.find((x) => x.push && x.mat === 'sand')!;
  const r = fresh();
  r.p.pos = { x: (belt.min.x + belt.max.x) / 2, y: belt.max.y + 0.02, z: (belt.min.z + belt.max.z) / 2 };
  tick(r, 300);
  check('DUNE TEMPLE: the river of sand drags you off the causeway if you stand still', r.s.run.falls === 1);
  // Its own sections: rising columns, ramps of sand (the shared sections have neither).
    check('DUNE TEMPLE: at least 30 checkpoints before the pyramid, and over 12 inside it', (() => {
    const inTomb = c.map.triggers.filter((t) => t.type === 'checkpoint' && c.map.triggers.some((d) => d.type === 'dark' && (d as { level?: number }).level !== undefined && t.min.x >= d.min.x && t.max.x <= d.max.x && t.min.z >= d.min.z && t.max.z <= d.max.z && t.min.y >= d.min.y && t.min.y <= d.max.y)).length;
    return c.checkpoints - inTomb >= 30 && inTomb >= 12;
  })());
  check('DUNE TEMPLE: built from its own sections (rising columns, dunes to slide)', c.map.solids.filter((x) => x.mover && x.mover.dy !== 0 && x.max.y - x.min.y > 10).length >= 4
    && c.map.solids.filter((x) => x.type === 'ramp').length >= 4);
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
