// Headless sanity tests for the simulation: `npm run test:sim`.
// Runs the real GameSim with scripted inputs and checks movement + combat.
import { PLAYER, RULES_PRACTICE, DT } from '../src/config/game';
import { MOVE } from '../src/config/movement';
import { v3, type Vec3 } from '../src/core/vec';
import { buildTestMap } from '../src/maps/testMap';
import { GameSim } from '../src/sim/game';
import { box } from '../src/sim/map';
import { BTN, type InputCmd, type Player } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${info})`);
  if (!ok) failed++;
}

function fresh(pos?: Vec3, yaw = 0): { sim: GameSim; p: Player } {
  const sim = new GameSim(buildTestMap(), 1, { ...RULES_PRACTICE, respawnPickups: false });
  sim.pickups.length = 0;
  const p = sim.addPlayer(1, 'T', 0xffffff);
  if (pos) { p.pos = { ...pos }; p.yaw = yaw; }
  return { sim, p };
}

type Script = (t: number, p: Player) => Partial<InputCmd>;
function run(sim: GameSim, p: Player, seconds: number, script: Script, each?: () => void): void {
  let yaw = p.yaw;
  for (let i = 0; i < seconds / DT; i++) {
    const c = script(i * DT, p);
    if (c.yaw !== undefined) yaw = c.yaw;
    sim.setInput(1, { seq: i, buttons: 0, moveF: 0, moveR: 0, pitch: 0, ...c, yaw });
    sim.step();
    each?.();
  }
}
const hspeed = (p: Player) => Math.hypot(p.vel.x, p.vel.z);
const f = (n: number) => n.toFixed(2);

// 1. standing still
{
  const { sim, p } = fresh();
  run(sim, p, 1, () => ({}));
  check('rests on floor', p.grounded && Math.abs(p.pos.y) < 0.02, `y=${f(p.pos.y)}`);
}
// 2. run speed
{
  const { sim, p } = fresh();
  run(sim, p, 1.5, () => ({ moveF: 1 }));
  check('reaches run speed', Math.abs(hspeed(p) - MOVE.runSpeed) < 0.2, `speed=${f(hspeed(p))}`);
}
// 3. bunny hop + air strafe gains speed (circle strafe: hold strafe, turn into it)
{
  const { sim, p } = fresh(v3(19, 0.02, 23), Math.PI / 2);
  run(sim, p, 0.8, () => ({ moveF: 1 }));
  let yaw = p.yaw;
  let max = 0;
  run(sim, p, 2, () => {
    if (!p.grounded) yaw -= 2 * DT;
    return { buttons: BTN.JUMP, moveR: 1, yaw };
  }, () => { max = Math.max(max, hspeed(p)); });
  check('bhop + air strafe gains speed', max > MOVE.runSpeed + 2, `max=${f(max)}`);
}
// 4. bhop preserves speed without strafing (no friction between hops)
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 0.8, () => ({ moveF: 1 }));
  run(sim, p, 3, () => ({ buttons: BTN.JUMP }));
  check('bhop keeps momentum', hspeed(p) > MOVE.runSpeed - 0.3, `speed=${f(hspeed(p))}`);
}
// 5. walls stop the player
{
  const { sim, p } = fresh(v3(-8, 0.02, 26), Math.PI); // facing +z wall at z=30
  run(sim, p, 3, () => ({ moveF: 1, buttons: BTN.JUMP }));
  check('does not pass through wall', p.pos.z < 30 - 0.34, `z=${f(p.pos.z)}`);
}
// 6. corner: push diagonally into a corner, must not escape or get NaN
{
  const { sim, p } = fresh(v3(-27, 0.02, -2), Math.PI * 0.25); // towards -x,-z
  run(sim, p, 3, () => ({ moveF: 1, moveR: 0 }));
  const ok = p.pos.x > -30 && Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z);
  check('corner is stable', ok, `pos=${f(p.pos.x)},${f(p.pos.z)}`);
}
// 7. stairs to the hill top
{
  const { sim, p } = fresh(v3(-8, 0.02, -26), Math.PI / 2); // facing -x, up the stairs
  run(sim, p, 2, () => ({ moveF: 1 }));
  check('climbs stairs', p.pos.y > 4.9 && p.grounded, `y=${f(p.pos.y)} x=${f(p.pos.x)}`);
}
// 8. slide down the big ramp gains speed
{
  const { sim, p } = fresh(v3(-24, 5.02, -26), Math.PI); // on top, facing +z
  run(sim, p, 0.75, () => ({ moveF: 1 }));
  const before = hspeed(p);
  let max = 0;
  run(sim, p, 1.2, () => ({ moveF: 1, buttons: BTN.CROUCH }), () => { max = Math.max(max, hspeed(p)); });
  check('slide gains speed downhill', max > before + 3, `before=${f(before)} max=${f(max)}`);
}
// 9. slide on flat ground decays and ends
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 1, () => ({ moveF: 1 }));
  run(sim, p, 0.1, () => ({ moveF: 1, buttons: BTN.CROUCH }));
  const started = p.sliding;
  run(sim, p, 4, () => ({ buttons: BTN.CROUCH }));
  check('flat slide starts then ends', started && !p.sliding, `started=${started} speed=${f(hspeed(p))}`);
}
// 9b. the crouch-only key (Ctrl) crouches at full speed but never slides
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 1, () => ({ moveF: 1 }));
  let slid = false;
  run(sim, p, 0.6, () => ({ moveF: 1, buttons: BTN.DUCK }), () => { slid ||= p.sliding; });
  const ducked = p.crouched;
  run(sim, p, 0.3, () => ({ moveF: 1 }));
  check('crouch-only key crouches without sliding', ducked && !slid && !p.crouched, `crouched=${ducked} slid=${slid}`);
  // and switching from a slide to the crouch-only key ends the slide but stays down
  run(sim, p, 1, () => ({ moveF: 1 }));
  run(sim, p, 0.1, () => ({ moveF: 1, buttons: BTN.CROUCH }));
  const sliding = p.sliding;
  run(sim, p, 0.1, () => ({ moveF: 1, buttons: BTN.DUCK }));
  check('swapping slide for crouch-only stops the slide, stays crouched', sliding && !p.sliding && p.crouched, `was sliding=${sliding}`);
}
// 10. wall jump reaches the 3.2 m ledge
{
  const { sim, p } = fresh(v3(9.6, 0.02, -22), Math.PI / 2); // in the shaft, hugging the x=9 wall
  let maxY = 0;
  let i = 0;
  run(sim, p, 2.5, () => {
    i++;
    // tap jump every 12 ticks, drift into the left wall then back
    return { buttons: i % 12 < 2 ? BTN.JUMP : 0, moveF: i < 60 ? 1 : 0 };
  }, () => { maxY = Math.max(maxY, p.pos.y); });
  check('wall jump gains height', maxY > 2.2, `maxY=${f(maxY)}`);
}
// 11. crouch tunnel: cannot stand up inside
{
  const { sim, p } = fresh(v3(-18, 0.02, 18), 0); // facing -z into the tunnel
  run(sim, p, 0.3, () => ({ buttons: BTN.CROUCH }));
  run(sim, p, 1.2, () => ({ moveF: 1, buttons: BTN.CROUCH }));
  const inside = p.pos.z < 16 && p.pos.z > 10;
  run(sim, p, 0.3, () => ({}));
  check('stays crouched under low ceiling', inside && p.crouched, `z=${f(p.pos.z)} crouched=${p.crouched}`);
}
// 12. void kills
{
  const { sim, p } = fresh(v3(19.5, 0.5, -19.5));
  run(sim, p, 3, () => ({}));
  check('void kills', p.deaths === 1, `deaths=${p.deaths}`);
}
// 13. pistol damages and kills a dummy, headshots count
{
  const { sim, p } = fresh(v3(12, 0.02, 8), -Math.PI / 2); // facing +x at dummy (22,0,8)
  p.weapons[0] = { type: 'rivet', ammo: 12 };
  const bot = sim.getPlayer(100)!;
  let heads = 0;
  let i = 0;
  run(sim, p, 3, () => ({ buttons: i++ % 12 === 0 ? BTN.FIRE : 0 }), () => {
    for (const e of sim.events) if (e.t === 'hit' && e.head) heads++;
    sim.events.length = 0;
  });
  check('hitscan kills dummy with headshots', bot.deaths >= 1 && heads > 0, `deaths=${bot.deaths} heads=${heads}`);
}
// 14. thrown weapon hurts and stuns
{
  const { sim, p } = fresh(v3(16, 0.02, 8), -Math.PI / 2);
  p.weapons[0] = { type: 'slab', ammo: 0 };
  const bot = sim.getPlayer(100)!;
  run(sim, p, 0.05, () => ({}));
  run(sim, p, 1, (t) => ({ buttons: t < 0.05 ? BTN.THROW : 0, pitch: 0.05 }));
  check('thrown weapon damages', bot.health < PLAYER.maxHealth && p.weapons[0] === null, `health=${bot.health}`);
}
// 15. rocket splash + rocket jump
{
  const { sim, p } = fresh(v3(0, 0.02, 20), 0);
  p.weapons[0] = { type: 'postman', ammo: 3 };
  let maxY = 0;
  run(sim, p, 1.5, (t) => ({ buttons: (t > 0.4 && t < 0.45 ? BTN.FIRE : 0) | (t > 0.4 && t < 0.5 ? BTN.JUMP : 0), pitch: -1.4 }), () => {
    maxY = Math.max(maxY, p.pos.y);
  });
  check('rocket jump', maxY > 2.5 && p.health < PLAYER.maxHealth && p.alive, `maxY=${f(maxY)} health=${p.health}`);
}
// 16. walk-over pickup
{
  const sim = new GameSim(buildTestMap(), 1, RULES_PRACTICE);
  const p = sim.addPlayer(1, 'T', 0xffffff);
  run(sim, p, 1.5, () => ({ moveF: 1 }));
  check('walk-over pickup', p.weapons[0]?.type === 'rivet', `slot0=${p.weapons[0]?.type}`);
}
// 17. determinism: same inputs, same result
{
  const go = () => {
    const { sim, p } = fresh();
    let yaw = 0;
    run(sim, p, 5, (t) => { yaw += Math.sin(t * 3) * 0.05; return { moveF: 1, moveR: Math.sin(t), buttons: BTN.JUMP, yaw }; });
    return `${p.pos.x},${p.pos.y},${p.pos.z}`;
  };
  const a = go(), b = go();
  check('deterministic', a === b, a);
}

// 18. air control: a standing jump can go somewhere
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 0.3, () => ({}));
  let max = 0;
  run(sim, p, 0.6, (t) => ({ moveF: 1, buttons: t < 0.05 ? BTN.JUMP : 0 }), () => { if (!p.grounded) max = Math.max(max, hspeed(p)); });
  check('standing jump accelerates in the air', max > 4 && max <= MOVE.runSpeed + 0.01, `air speed=${f(max)}`);
}
// 19. air control steers without adding speed
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 1, () => ({ moveF: 1 }));
  const heading0 = Math.atan2(p.vel.z, p.vel.x);
  let max = 0;
  run(sim, p, 0.6, (t) => ({ moveR: 1, buttons: t < 0.05 ? BTN.JUMP : 0 }), () => { max = Math.max(max, hspeed(p)); });
  const turned = Math.abs(Math.atan2(p.vel.z, p.vel.x) - heading0);
  check('strafe key bends the trajectory in mid-air', turned > 0.5, `turned ${f(turned * 57.3)} deg`);
  check('but steering alone does not add speed', max < MOVE.runSpeed + 0.25, `max=${f(max)}`);
}
// 19b. W+A in the air: the trajectory swings to the diagonal of where you look, and stays there
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2); // looking along +x
  run(sim, p, 1, () => ({ moveF: 1 }));
  run(sim, p, 0.55, (t) => ({ moveF: 1, moveR: -1, buttons: t < 0.05 ? BTN.JUMP : 0 }));
  // forward is +x, left of that is -z: the diagonal is 45 degrees between them
  const heading = Math.atan2(-p.vel.z, p.vel.x) * 57.3;
  check('forward + strafe steers to the diagonal', Math.abs(heading - 45) < 4 && !p.grounded, `heading=${f(heading)} deg left`);
}
// 20. air brake
{
  const { sim, p } = fresh(v3(-25, 0.02, 25), -Math.PI / 2);
  run(sim, p, 1, () => ({ moveF: 1 }));
  run(sim, p, 0.3, (t) => ({ moveF: -1, buttons: t < 0.05 ? BTN.JUMP : 0 }));
  // facing +x: forward speed is vel.x
  check('holding back kills forward speed in the air', p.vel.x < 0.5 && !p.grounded, `vx=${f(p.vel.x)}`);
}
// 21. bunny hopping: hold forward + jump, every hop adds speed up to the cap
{
  const { sim, p } = fresh(v3(-19, 0.02, -16), -Math.PI / 2); // a clear 48 m lane
  let max = 0;
  const cap = MOVE.runSpeed * MOVE.hopSpeedCap;
  run(sim, p, 4, () => ({ moveF: 1, buttons: BTN.JUMP }), () => { max = Math.max(max, hspeed(p)); });
  check('chained hops build speed up to the hop cap', max > cap - 1 && max <= cap + 0.01, `max=${f(max)} cap=${f(cap)}`);
}

// Wall runs and glancing wall hits keep all your speed.
{
  const wallMap = { ...buildTestMap(), solids: [box(-10, -2, 3, 60, 8, 4, 'concrete'), box(-40, -1, -6, 0, 0, 6, 'concrete')], triggers: [], pickups: [], bots: [], killY: -50 };
  const trial = (entryDeg: number, lookInto: number) => {
    const sim = new GameSim(wallMap, 1, RULES_PRACTICE);
    sim.pickups.length = 0;
    const p = sim.addPlayer(1, 'T', 1);
    const a = (entryDeg * Math.PI) / 180;
    p.pos = { x: -4, y: 0.6, z: 2.2 - Math.tan(a) * 2 };
    p.vel = { x: 12 * Math.cos(a), y: 3, z: 12 * Math.sin(a) };
    let min = Infinity, max = 0, ran = false;
    for (let i = 0; i < 70; i++) {
      sim.setInput(1, { seq: i, buttons: 0, moveF: 1, moveR: 0, pitch: 0, yaw: -Math.PI / 2 - (lookInto * Math.PI) / 180 });
      sim.step();
      if (i > 15) { const hs = hspeed(p); min = Math.min(min, hs); max = Math.max(max, hs); }
      ran ||= p.wallRunning;
    }
    return { min, max, ran };
  };
  const run = trial(0, 15);
  check('a wall run keeps all its speed (looking into the wall)', run.ran && run.min > 11.95 && run.max < 12.05, `${f(run.min)}..${f(run.max)} m/s`);
  const glance = trial(30, 0);
  check('glancing off a wall at 30 degrees keeps all its speed', glance.min > 11.95 && glance.max < 12.05, `${f(glance.min)}..${f(glance.max)} m/s`);
}

// A narrow shaft is climbed on the move: a jump there is not turned into a wall run, and each
// wall jump carries you across to the other wall for the next.
{
  const shaft = { ...buildTestMap(), solids: [box(-10, -2, -1.3, 200, 0, 1.3, 'concrete'), box(-10, -2, -2, 200, 8, -1.3, 'concrete'), box(-10, -2, 1.3, 200, 8, 2, 'concrete')], triggers: [], pickups: [], bots: [], killY: -50 };
  const sim = new GameSim(shaft, 1, RULES_PRACTICE);
  sim.pickups.length = 0;
  const p = sim.addPlayer(1, 'T', 1);
  p.pos = { x: 0, y: 0.02, z: 0.85 };
  p.vel = { x: 12, y: 0, z: 0 };
  let peak = 0, ran = false, wj = 0, prev = false, minVx = Infinity;
  for (let i = 0; i < 150; i++) {
    const want = i === 0 || (!p.grounded && p.vel.y < 0.5);
    const press = want && !prev;
    prev = press;
    const left = p.wallJumpsLeft;
    sim.setInput(1, { seq: i, buttons: press ? BTN.JUMP : 0, moveF: 1, moveR: 0, pitch: 0, yaw: -Math.PI / 2 });
    sim.step();
    if (p.wallJumpsLeft < left) wj++;
    peak = Math.max(peak, p.pos.y);
    ran ||= p.wallRunning;
    minVx = Math.min(minVx, p.vel.x);
    if (p.grounded && i > 5) break;
  }
  check('in a narrow shaft a jump climbs (no wall run), two wall jumps, over 3 m up', !ran && wj === 2 && peak > 3.2, `peak ${f(peak)} m, ${wj} wall jumps, wall run ${ran}`);
  check('...without losing forward speed', minVx > 11.5, `slowest ${f(minVx)} m/s`);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('simulation tests failed');
