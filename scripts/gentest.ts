// Map generator + map mechanics tests: `npm run test:gen`.
import { DT, PLAYER, RULES_PRACTICE } from '../src/config/game';
import { v3, type Vec3 } from '../src/core/vec';
import { MAP_SIZES, generateMap, pickMapSize } from '../src/maps/generator';
import { THEMES } from '../src/maps/themes';
import { GameSim, makePlayer } from '../src/sim/game';
import { pmove } from '../src/sim/pmove';
import type { MapDef, Solid, Trigger } from '../src/sim/map';
import { BTN, type InputCmd, type Player } from '../src/sim/types';
import { World } from '../src/sim/world';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number) => n.toFixed(2);

// ---------------------------------------------------------------- mechanics
// Tiny hand-made maps, one mechanic each, run through the real simulation.
function lab(solids: Solid[], triggers: Trigger[] = []): MapDef {
  return {
    name: 'LAB', seed: 1, solids, triggers, spawns: [{ pos: v3(0, 0, 0), yaw: 0 }], pickups: [], bots: [],
    killY: -20, palette: THEMES[0],
  };
}
const floor = (x0 = -20, z0 = -20, x1 = 20, z1 = 20): Solid => ({ type: 'box', mat: 'concrete', min: v3(x0, -1, z0), max: v3(x1, 0, z1) });
function start(map: MapDef, pos: Vec3): { sim: GameSim; p: Player } {
  const sim = new GameSim(map, 1, { ...RULES_PRACTICE, respawnPlayers: false });
  const p = sim.addPlayer(1, 'T', 1);
  p.pos = { ...pos };
  return { sim, p };
}
function run(sim: GameSim, seconds: number, cmd: Partial<InputCmd> = {}, each?: () => void): void {
  for (let i = 0; i < seconds / DT; i++) {
    sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, yaw: 0, pitch: 0, ...cmd });
    sim.step();
    each?.();
  }
}

{ // a jump pad throws you along the way YOU are moving, not the way it was built
  const pad: Trigger = { type: 'jumppad', min: v3(-0.9, 0, -0.9), max: v3(0.9, 0.5, 0.9), vel: v3(4, 13, 0) };
  for (const [yaw, label] of [[0, 'running -z'], [Math.PI / 2, 'running -x'], [2.4, 'diagonally']] as const) {
    const from = v3(Math.sin(yaw) * 5, 0.01, Math.cos(yaw) * 5);
    const { sim, p } = start(lab([floor()], [pad]), from);
    let launched = false, hsIn = 0, hsOut = 0, maxY = 0;
    for (let i = 0; i < 60 * 3; i++) {
      const before = Math.hypot(p.vel.x, p.vel.z);
      sim.setInput(1, { seq: i, buttons: 0, moveF: launched ? 0 : 1, moveR: 0, yaw, pitch: 0 });
      sim.step();
      if (!launched && sim.events.some((e) => e.t === 'pad')) { launched = true; hsIn = before; hsOut = Math.hypot(p.vel.x, p.vel.z); }
      sim.events.length = 0;
      maxY = Math.max(maxY, p.pos.y);
    }
    const heading = Math.atan2(p.pos.x - from.x, p.pos.z - from.z), want = Math.atan2(-from.x, -from.z);
    const off = Math.abs(Math.atan2(Math.sin(heading - want), Math.cos(heading - want)));
    check(`jump pad bounces you the way you were going, 2.5 m/s faster (${label})`,
      launched && maxY > 3.5 && off < 0.05 && Math.abs(hsOut - (hsIn + 2.5)) < 0.01 && p.grounded,
      `in ${f(hsIn)} out ${f(hsOut)} m/s, up ${f(maxY)} m, off course ${f(off * 57.3)} deg`);
  }
  const still = start(lab([floor()], [pad]), v3(0, 0.02, 0));
  let maxY = 0, drift = 0;
  run(still.sim, 2.2, {}, () => { maxY = Math.max(maxY, still.p.pos.y); drift = Math.max(drift, Math.hypot(still.p.pos.x, still.p.pos.z)); });
  check('standing still on a jump pad bounces you straight up', maxY > 3.5 && drift < 0.01, `up ${f(maxY)} m, drift ${f(drift)} m`);
  const slow = start(lab([floor()], [pad]), v3(0, 0.02, 1.2)); // already on its edge
  slow.p.vel = v3(0, 0, -1.5); // creeping on at 1.5 m/s
  run(slow.sim, 1 / 60);
  const slowHs = Math.hypot(slow.p.vel.x, slow.p.vel.z);
  check('a slow approach gets the 2.5 m/s boost and the full bounce', slowHs > 3.5 && slowHs < 4.1 && slow.p.vel.z < 0 && slow.p.vel.y > 12.5,
    `speed ${f(slowHs)} m/s, up ${f(slow.p.vel.y)} m/s`);
  const fast = start(lab([floor()], [pad]), v3(0, 0.3, 1.2)); // in the air, so no ground friction first
  fast.p.vel = v3(0, -1, -20); // arriving faster than the 14 m/s cap
  run(fast.sim, 1 / 60);
  check('a jump pad never slows you down', Math.hypot(fast.p.vel.x, fast.p.vel.z) > 19, `speed ${f(Math.hypot(fast.p.vel.x, fast.p.vel.z))}`);
  const steer = start(lab([floor()], [pad]), v3(0, 0.02, 0));
  run(steer.sim, 0.1);
  run(steer.sim, 0.6, { moveR: 1 });
  check('you can steer straight after a pad', Math.abs(steer.p.pos.x) > 0.5, `x=${f(steer.p.pos.x)}`);
}
{ // teleporter keeps velocity and does not bounce back
  const tp = (x: number, to: number): Trigger => ({ type: 'teleporter', min: v3(x - 0.7, 0, -0.7), max: v3(x + 0.7, 2, 0.7), dest: v3(to, 0.05, 0), pair: 0 });
  const { sim, p } = start(lab([floor()], [tp(-10, 10), tp(10, -10)]), v3(-10, 0.01, 4));
  let jumps = 0;
  run(sim, 1.2, { moveF: 1 }, () => { for (const e of sim.events) if (e.t === 'tele') jumps++; sim.events.length = 0; });
  check('teleporter moves the player once', jumps === 1 && p.pos.x > 9 && p.pos.z < -1, `jumps=${jumps} pos=${f(p.pos.x)},${f(p.pos.z)}`);
}
{ // low gravity
  const jump = (triggers: Trigger[]) => {
    const { sim, p } = start(lab([floor()], triggers), v3(0, 0.01, 0));
    let maxY = 0;
    run(sim, 0.1);
    run(sim, 3, { buttons: BTN.JUMP }, () => { maxY = Math.max(maxY, p.pos.y); });
    return maxY;
  };
  const normal = jump([]), low = jump([{ type: 'lowgrav', min: v3(-5, -1, -5), max: v3(5, 12, 5), scale: 0.35 }]);
  check('low gravity raises the jump', low > normal * 2.2, `normal=${f(normal)} low=${f(low)}`);
}
{ // conveyor drags a standing player, and stops at a wall
  const belt: Solid = { type: 'box', mat: 'conveyor', surface: 'conveyor', push: v3(4, 0, 0), min: v3(-6, -1, -2), max: v3(6, 0.02, 2) };
  const wall: Solid = { type: 'box', mat: 'concrete', min: v3(5, 0, -3), max: v3(6, 3, 3) };
  const { sim, p } = start(lab([floor(), belt, wall]), v3(-4, 0.05, 0));
  run(sim, 1);
  const mid = p.pos.x;
  run(sim, 3);
  check('conveyor carries the player', mid > -0.5 && mid < 0.5, `x after 1s=${f(mid)}`);
  check('and a wall still stops them', p.pos.x < 5 - PLAYER.radius + 0.01 && p.pos.x > 4.5, `x=${f(p.pos.x)}`);
}
{ // deadly floor
  const lava: Solid = { type: 'box', mat: 'lava', surface: 'deadly', min: v3(-2, -1, -8), max: v3(2, 0.01, -4) };
  const { sim, p } = start(lab([floor(), lava]), v3(0, 0.02, 0));
  run(sim, 1.5, { moveF: 1 });
  check('deadly floor kills', !p.alive);
}
{ // horizontal moving platform over a gap: stand still and get ferried across
  const plat: Solid = {
    type: 'box', mat: 'hazard', min: v3(-1.4, -0.4, -1.4), max: v3(1.4, 0, 1.4),
    mover: { dx: 9, dy: 0, dz: 0, moveTime: 3, waitA: 1, waitB: 1, phase: 0 },
  };
  const { sim, p } = start(lab([floor(-12, -5, -1.5, 5), floor(10.5, -5, 20, 5), plat]), v3(0, 0.02, 0));
  let maxX = 0;
  run(sim, 4.5, {}, () => { maxX = Math.max(maxX, p.pos.x); });
  check('platform carries a standing player', maxX > 8.9 && p.alive && Math.abs(p.pos.y) < 0.05, `maxX=${f(maxX)} y=${f(p.pos.y)}`);
  run(sim, 0.2, { moveF: 0, moveR: 1 }); // step off sideways onto the far ledge? (platform is at the far end)
  check('player can still move while riding', p.pos.x > maxX - 0.2);
}
{ // elevator up, and crushing someone underneath on the way down
  const lift: Solid = {
    type: 'box', mat: 'hazard', min: v3(-1.3, 0, -1.3), max: v3(1.3, 0.3, 1.3),
    mover: { dx: 0, dy: 3, dz: 0, moveTime: 1.5, waitA: 1, waitB: 1, phase: 0 },
  };
  const { sim, p } = start(lab([floor(), lift]), v3(0, 0.35, 0));
  let maxY = 0;
  run(sim, 3, {}, () => { maxY = Math.max(maxY, p.pos.y); });
  check('elevator lifts a standing player', maxY > 3.25 && maxY < 3.4, `maxY=${f(maxY)}`);

  const b = start(lab([floor(), lift]), v3(4, 0.02, 0));
  run(b.sim, 2.6, {}); // wait until the lift is at the top
  b.p.pos = v3(0, 0.02, 0); // walk under it
  run(b.sim, 2.5, {});
  check('standing under a descending elevator is fatal', !b.p.alive);
}
{ // a timed door pushes you out of the way instead of trapping you
  const door: Solid = {
    type: 'box', mat: 'hazard', min: v3(-1.5, -3.06, -0.25), max: v3(1.5, 0, 0.25),
    mover: { dx: 0, dy: 3.06, dz: 0, moveTime: 0.9, waitA: 1, waitB: 2, phase: 0 },
  };
  const { sim, p } = start(lab([floor(), door]), v3(0, 0.02, 0));
  let maxY = 0;
  run(sim, 2.5, {}, () => { maxY = Math.max(maxY, p.pos.y); });
  check('a door rising under a player lifts them', p.alive && maxY > 2.9, `maxY=${f(maxY)}`);
}

{ // Client prediction on movers: replaying inputs from a mid-ride snapshot must reproduce the host exactly.
  const plat: Solid = {
    type: 'box', mat: 'hazard', min: v3(-1.4, -0.4, -1.4), max: v3(1.4, 0, 1.4),
    mover: { dx: 9, dy: 2, dz: 0, moveTime: 3, waitA: 0.5, waitB: 0.5, phase: 0 },
  };
  const map = lab([floor(-12, -5, -1.5, 5), plat]);
  const { sim, p } = start(map, v3(0, 0.02, 0));
  const world = new World(map.solids, map.triggers); // the client's own copy of the world
  const cmdAt = (i: number): InputCmd => ({ seq: i, buttons: i % 50 === 0 ? BTN.JUMP : 0, moveF: Math.sin(i * 0.1) * 0.2, moveR: Math.cos(i * 0.07) * 0.2, yaw: 0, pitch: 0 });
  let snap: Player | null = null;
  let worst = 0;
  let compared = 0;
  for (let i = 0; i < 300; i++) {
    if (i === 90) {
      // what a snapshot carries: only the synchronised movement fields
      snap = makePlayer(1, 'C', 1);
      Object.assign(snap, {
        pos: { ...p.pos }, vel: { ...p.vel }, crouched: p.crouched, sliding: p.sliding, slideBoostTimer: p.slideBoostTimer,
        wallJumpsLeft: p.wallJumpsLeft, wallJumpTimer: p.wallJumpTimer, teleTimer: p.teleTimer, groundTime: p.groundTime, launchTimer: p.launchTimer, rooted: p.rooted, stun: p.stun, prevButtons: p.prevButtons,
      });
    }
    const cmd = cmdAt(i);
    sim.setInput(1, cmd);
    sim.step();
    if (!p.alive) break;
    if (snap) {
      pmove(snap, cmd, world, DT, sim.tick);
      snap.prevButtons = cmd.buttons;
      compared++;
      worst = Math.max(worst, Math.hypot(snap.pos.x - p.pos.x, snap.pos.y - p.pos.y, snap.pos.z - p.pos.z));
    }
  }
  // (the rider may eventually hop off the edge; what matters is that both sides agree until then)
  check('prediction on a moving platform is exact (walking and hopping on it)', worst < 1e-9 && compared > 50, `worst error=${worst.toExponential(1)} over ${compared} ticks`);
}

// ---------------------------------------------------------------- generator
{
  const SEEDS = 600;
  const t0 = Date.now();
  const types: Record<string, number> = {};
  const feat: Record<string, number> = {};
  const count = (k: string, n = 1) => { if (n) feat[k] = (feat[k] ?? 0) + 1; };
  const landmarks: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  let open = 0, rich = 0;
  let fallback = 0, worstAttempt = 0, attempts = 0, minPickups = 99, minSpawnGap = 99, badGeometry = 0, maxSolids = 0;
  const hullMin = v3(-PLAYER.radius, 0.02, -PLAYER.radius), hullMax = v3(PLAYER.radius, PLAYER.height, PLAYER.radius);

  for (let s = 1; s <= SEEDS; s++) {
    const m = generateMap(s * 2654435761 >>> 0);
    const a = m.info!.archetype;
    types[a] = (types[a] ?? 0) + 1;
    if (a === 'FALLBACK') { fallback++; continue; }
    worstAttempt = Math.max(worstAttempt, m.info!.attempt);
    attempts += m.info!.attempt + 1;
    maxSolids = Math.max(maxSolids, m.solids.length);
    const size = MAP_SIZES.find((z) => z.cells === m.info!.cells)!;
    sizes[size.name] = (sizes[size.name] ?? 0) + 1;
    const wantGap = Math.min(12, size.cells * 3 * 0.28);
    for (let i = 0; i < m.spawns.length; i++) {
      for (let j = i + 1; j < m.spawns.length; j++) {
        const p = m.spawns[i].pos, q = m.spawns[j].pos;
        // relative to what this size promises (12 m on the big maps)
        minSpawnGap = Math.min(minSpawnGap, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) / wantGap);
      }
    }
    minPickups = Math.min(minPickups, m.pickups.length - Math.min(9, size.spawns + 3));
    // Independent re-check with the collision world, over a whole mover cycle.
    const world = new World(m.solids, m.triggers);
    for (let tick = 0; tick < 60 * 12; tick += 7) {
      world.setTick(tick);
      for (const sp of m.spawns) if (world.traceBox(sp.pos, sp.pos, hullMin, hullMax).startSolid) badGeometry++;
    }
    world.setTick(0);
    for (const pk of m.pickups) if (world.traceBox(pk.pos, pk.pos, v3(-0.2, 0.05, -0.2), v3(0.2, 0.6, 0.2)).startSolid) badGeometry++;
    if (m.spawns.length !== size.spawns) badGeometry++;

    for (const st of m.info!.structures) landmarks[st] = (landmarks[st] ?? 0) + 1;
    if ((a === 'ARENA' || a === 'TERRACES') && size.cells >= 14) { open++; if (m.info!.structures.length >= 2) rich++; }
    count('jump pads', m.triggers.filter((t) => t.type === 'jumppad').length);
    count('teleporters', m.triggers.filter((t) => t.type === 'teleporter').length);
    count('low gravity', m.triggers.filter((t) => t.type === 'lowgrav').length);
    count('dark areas', m.triggers.filter((t) => t.type === 'dark').length);
    count('movers (platforms/elevators/doors)', m.solids.filter((x) => x.mover).length);
    count('conveyors', m.solids.filter((x) => x.surface === 'conveyor').length);
    count('deadly floor', m.solids.filter((x) => x.surface === 'deadly').length);
    count('ice', m.solids.filter((x) => x.surface === 'ice').length);
    count('ramps', m.solids.filter((x) => x.type === 'ramp').length);
  }
  const ms = (Date.now() - t0) / SEEDS;
  console.log('  archetypes:', JSON.stringify(types));
  console.log('  maps containing:', JSON.stringify(feat));
  console.log(`  avg attempts ${f(attempts / (SEEDS - fallback))}, worst ${worstAttempt}, ${f(ms)} ms per map, max solids ${maxSolids}`);
  console.log('  landmarks:', JSON.stringify(landmarks));
  console.log('  sizes:', JSON.stringify(sizes));
  check('all six landmarks appear', Object.keys(landmarks).length === 6 && Object.values(landmarks).every((n) => n > SEEDS * 0.05));
  check('big open maps get at least two landmarks nearly always', rich > open * 0.85, `${rich}/${open}`);
  check('every map size appears', MAP_SIZES.every((z) => (sizes[z.name] ?? 0) > SEEDS * 0.04), JSON.stringify(sizes));
  check(`${SEEDS} seeds: no fallbacks`, fallback === 0, `fallbacks=${fallback}`);
  check('all four archetypes appear', ['ARENA', 'TERRACES', 'ROOMS', 'ISLANDS'].every((a) => (types[a] ?? 0) > SEEDS * 0.08));
  check('every mechanic appears in some maps', Object.keys(feat).length === 9 && Object.values(feat).every((n) => n > SEEDS * 0.03));
  check('spawns are far apart (12 m on big maps, less on small ones)', minSpawnGap >= 1, `worst ${f(minSpawnGap * 100)}% of the promise`);
  check('enough weapons for the size', minPickups >= 0, `worst ${minPickups} over the minimum`);
  check('nothing spawns inside geometry', badGeometry === 0, `bad=${badGeometry}`);
  check('generation is fast', ms < 25, `${f(ms)} ms`);
}
{
  // Map size follows the room: few players mostly get small maps, a full room big ones.
  const tally = (players: number) => {
    const t: Record<number, number> = {};
    for (let s = 1; s <= 2000; s++) { const c = pickMapSize(s * 7919, players); t[c] = (t[c] ?? 0) + 1; }
    return t;
  };
  const avg = (t: Record<number, number>) => Object.entries(t).reduce((a, [c, n]) => a + Number(c) * n, 0) / 2000;
  const two = tally(2), four = tally(4), six = tally(6);
  check('two players: mostly tiny and small maps, the odd big one', (two[8] ?? 0) + (two[10] ?? 0) > 1000 && (two[16] ?? 0) > 0, JSON.stringify(two));
  check('the more players, the bigger the map on average', avg(two) < avg(four) && avg(four) < avg(six), `${f(avg(two))} < ${f(avg(four))} < ${f(avg(six))} cells`);
  const fits = [2, 3, 4, 5, 6].every((p) => Object.keys(tally(p)).every((c) => MAP_SIZES.find((z) => z.cells === Number(c))!.spawns >= p));
  check('never a map with fewer spawns than players', fits);
  check('the same seed and room always pick the same size', pickMapSize(1234, 3) === pickMapSize(1234, 3));
  // Every size, many seeds: valid, on its own grid, never the fallback.
  let bad = '';
  for (const z of MAP_SIZES) {
    for (let s = 1; s <= 120; s++) {
      const m = generateMap(s * 104729 >>> 0, z.cells);
      if (m.info!.archetype === 'FALLBACK') { bad += `${z.name}#${s} fallback; `; continue; }
      if (m.extent !== z.cells * 1.5 || m.spawns.length !== z.spawns) bad += `${z.name}#${s}; `;
      const far = Math.max(...m.spawns.map((sp) => Math.max(Math.abs(sp.pos.x), Math.abs(sp.pos.z))));
      if (far > m.extent!) bad += `${z.name}#${s} spawn outside; `;
    }
  }
  check('every size generates cleanly (120 seeds each)', !bad, bad.slice(0, 200));
}
{
  let same = true;
  for (let s = 1; s <= 60; s++) if (JSON.stringify(generateMap(s * 977)) !== JSON.stringify(generateMap(s * 977))) same = false;
  check('same seed, same map (60 seeds)', same);
  check('different seeds differ', JSON.stringify(generateMap(11)) !== JSON.stringify(generateMap(12)));
}

// Every jump pad in real generated maps, flown by the real movement code.
// A pad is a trampoline: it bounces you, it does not aim you. So the question
// is whether a player who WANTS to get where the pad leads can: holding the
// key towards it (or braking), from a standstill or a run-up, at least one way
// must land them there. And standing still must drop you back on the pad.
{
  let pads = 0, bad = 0, badStill = 0;
  const why: string[] = [];
  const ways = { 'standing, W': 0, 'jogging, W': 0, 'running, hands off': 0, 'running, braking': 0 };
  for (let s = 1; s <= 250; s++) {
    const m = generateMap(s * 7919);
    for (const t of m.triggers) {
      if (t.type !== 'jumppad') continue;
      pads++;
      const from = v3((t.min.x + t.max.x) / 2, t.min.y + 0.03, (t.min.z + t.max.z) / 2);
      const hs = Math.hypot(t.vel.x, t.vel.z);
      const dx = t.vel.x / hs, dz = t.vel.z / hs; // towards where the pad leads
      const yaw = Math.atan2(-dx, -dz);
      const fly = (speed: number, moveF: number) => {
        const sim = new GameSim({ ...m, pickups: [], triggers: m.triggers.filter((x) => x.type !== 'teleporter') }, 1, { ...RULES_PRACTICE, respawnPlayers: false });
        const p = sim.addPlayer(1, 'T', 1);
        p.pos = { ...from };
        p.vel = v3(dx * speed, 0, dz * speed);
        let up = false;
        for (let i = 0; i < 60 * 4 && p.alive; i++) {
          sim.setInput(1, { seq: i, buttons: 0, moveF: up ? moveF : 0, moveR: 0, yaw, pitch: 0 });
          sim.step();
          if (p.pos.y > from.y + 0.5) up = true;
          // landing on the next pad of a trampoline group counts as arriving
          const again = up && sim.events.some((e) => e.t === 'pad');
          sim.events.length = 0;
          if (again) { p.grounded = true; break; }
          if (up && p.grounded) break;
        }
        return p;
      };
      const arrived = (p: ReturnType<typeof fly>) => {
        const along = (p.pos.x - from.x) * dx + (p.pos.z - from.z) * dz;
        return p.alive && p.grounded && along >= 2.5 && p.pos.y >= from.y - 0.2;
      };
      const tries: [keyof typeof ways, number, number][] = [
        ['standing, W', 0, 1], ['jogging, W', 4, 1], ['running, hands off', 8, 0], ['running, braking', 8, -1],
      ];
      const ok = tries.find(([, speed, moveF]) => arrived(fly(speed, moveF)));
      if (ok) ways[ok[0]]++;
      else {
        bad++;
        if (why.length < 4) why.push(`seed ${s * 7919} pad at ${f(from.x)},${f(from.z)}`);
      }
      const st = fly(0, 0);
      if (!st.alive || Math.hypot(st.pos.x - from.x, st.pos.z - from.z) > 0.3) badStill++;
    }
  }
  console.log('  first way that reached the target:', JSON.stringify(ways));
  check('every generated jump pad can take a player where it leads', pads > 40 && bad === 0, `pads=${pads} bad=${bad} ${why.join('; ')}`);
  check('and drops one who stands still back where they were', badStill === 0, `bad=${badStill}`);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('generator tests failed');
