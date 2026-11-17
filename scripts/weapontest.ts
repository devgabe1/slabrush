// Weapon behaviour tests + balance table: `npm run test:weapons`.
import { AIM, DT, RULES_PRACTICE } from '../src/config/game';
import { TRAPS, WEAPON_TIERS, WEAPONS, type WeaponId } from '../src/config/weapons';
import { v3, type Vec3 } from '../src/core/vec';
import { THEMES } from '../src/maps/themes';
import { FACES, LEGS, TORSOS, cleanLook } from '../src/config/looks';
import { LOOK_COUNTS, buildCharacter, buildProjectileModel, buildWeaponModel } from '../src/render/models';
import { GameSim, canAim, isDual } from '../src/sim/game';
import type { MapDef, Solid } from '../src/sim/map';
import { BTN, type InputCmd, type Player, type SimEvent } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number, d = 2) => n.toFixed(d);
const ALL = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => id !== 'fists');

const floor: Solid = { type: 'box', mat: 'concrete', min: v3(-40, -1, -40), max: v3(40, 0, 40) };
function arena(extra: Solid[] = []): MapDef {
  return {
    name: 'RANGE', seed: 1, solids: [floor, ...extra], triggers: [], spawns: [{ pos: v3(0, 0, 0), yaw: 0 }],
    pickups: [], bots: [], killY: -20, palette: THEMES[0],
  };
}

interface Range { sim: GameSim; me: Player; foe: Player; events: SimEvent[] }
/** Shooter at the origin looking down -Z, a target `dist` metres in front. */
function range(weapon: WeaponId | null, dist = 6, extra: Solid[] = []): Range {
  const sim = new GameSim(arena(extra), 7, { ...RULES_PRACTICE, respawnPlayers: false });
  const me = sim.addPlayer(1, 'ME', 1), foe = sim.addPlayer(2, 'FOE', 2);
  me.pos = v3(0, 0.01, 0);
  foe.pos = v3(0, 0.01, -dist);
  if (weapon) me.weapons[0] = { type: weapon, ammo: WEAPONS[weapon].ammo };
  me.cooldown = [0, 0];
  return { sim, me, foe, events: [] };
}
const cmd = (c: Partial<InputCmd>): InputCmd => ({ seq: 0, buttons: 0, moveF: 0, moveR: 0, yaw: 0, pitch: 0, ...c });
function step(r: Range, n: number, mine: Partial<InputCmd> = {}, theirs: Partial<InputCmd> = { yaw: Math.PI }): void {
  for (let i = 0; i < n; i++) {
    r.sim.setInput(1, cmd(mine));
    r.sim.setInput(2, cmd(theirs)); // by default the target faces the shooter
    r.sim.step();
    r.events.push(...r.sim.events);
    r.sim.events.length = 0;
  }
}
/** Press and release the trigger once. */
function pull(r: Range, mine: Partial<InputCmd> = {}, theirs?: Partial<InputCmd>): void {
  step(r, 1, { ...mine, buttons: BTN.FIRE }, theirs);
  step(r, 1, mine, theirs);
}
const BODY = -0.103, HEAD = 0; // pitch to hit chest / head of a target 6 m away
const count = (r: Range, t: SimEvent['t']) => r.events.filter((e) => e.t === t).length;

// ------------------------------------------------------------------ data
const TOTAL = 35;
check(`${TOTAL} weapons plus fists`, ALL.length === TOTAL, `have ${ALL.length}`);
check('every weapon is in exactly one tier', WEAPON_TIERS.flat().length === TOTAL && new Set(WEAPON_TIERS.flat()).size === TOTAL,
  WEAPON_TIERS.map((t) => t.length).join('/'));
{
  let bad = '';
  for (const id of [...ALL, 'fists' as WeaponId]) {
    const m = buildWeaponModel(id);
    if (m.children.length < 2 || typeof m.userData.muzzle !== 'number') bad += id + ' ';
    if (WEAPONS[id].kind === 'projectile' && buildProjectileModel(id).children.length < 1) bad += id + '(proj) ';
  }
  check('every weapon has its own model', !bad, bad);
  const names = new Set(ALL.map((id) => WEAPONS[id].name));
  check('names are unique and fit the HUD', names.size === TOTAL && ALL.every((id) => WEAPONS[id].name.length <= 9));
}

// ------------------------------------------------------------ characters
{
  check('every named look has a model', LOOK_COUNTS.join() === [FACES.length, TORSOS.length, LEGS.length].join(), LOOK_COUNTS.join('/'));
  let thin = '';
  const base = buildCharacter(0xe8503a, [0, 0, 0]).parts.length;
  for (let slot = 0; slot < 3; slot++) {
    for (let n = 0; n < LOOK_COUNTS[slot]; n++) {
      const look = [0, 0, 0];
      look[slot] = n;
      const c = buildCharacter(0x3aa6e8, look);
      // each option must be a real, distinct build with limbs to animate and pieces to scatter
      if (c.parts.length < 6 || !c.legL || !c.legR || !c.head || (n > 0 && c.look === '0,0,0')) thin += `${slot}:${n} `;
    }
  }
  check(`all ${LOOK_COUNTS[0] + LOOK_COUNTS[1] + LOOK_COUNTS[2]} options build a complete character`, !thin && base >= 6, thin);
  check('a nonsense look falls back to the default', cleanLook([99, -1, 'x']).join() === '0,0,0' && cleanLook(undefined).join() === '0,0,0'
    && buildCharacter(1, [99, -3, 2.5]).look === '99,-3,2.5');
}

// ------------------------------------------------------------- behaviours
{ // burst
  const r = range('pepper');
  pull(r, { pitch: BODY });
  step(r, 20, { pitch: BODY });
  check('PEPPER fires a three-round burst per pull', count(r, 'fire') === 3 && r.me.weapons[0]!.ammo === 18, `shots=${count(r, 'fire')}`);
}
{ // headshot kills
  for (const id of ['magnate', 'needle'] as WeaponId[]) {
    const r = range(id);
    pull(r, { pitch: HEAD });
    check(`${WEAPONS[id].name} kills with one headshot`, !r.foe.alive);
    const b = range(id);
    pull(b, { pitch: BODY });
    check(`${WEAPONS[id].name} does not kill with one body shot`, b.foe.alive && b.foe.health === 100 - WEAPONS[id].damage, `hp=${b.foe.health}`);
  }
}
{ // double barrel throws the shooter
  const r = range('twins', 30);
  pull(r, { pitch: -1.3 }); // at the floor
  check('TWINS recoil launches the shooter', r.me.vel.y > 5, `vy=${f(r.me.vel.y)}`);
  const c = range('twins', 3);
  pull(c, { pitch: BODY * 2 });
  check('TWINS kills point blank', !c.foe.alive);
}
{ // ricochet around a wall
  const block: Solid = { type: 'box', mat: 'concrete', min: v3(-2, 0, -5.5), max: v3(2, 4, -4.5) };
  const side: Solid = { type: 'box', mat: 'concrete', min: v3(6, 0, -20), max: v3(7, 6, 20) };
  const r = range('bouncer', 10, [block, side]);
  const yaw = Math.atan2(-12, 10); // aim at the target's mirror image in the side wall
  pull(r, { yaw, pitch: -0.04 });
  const hit = r.events.find((e) => e.t === 'hit');
  check('BOUNCER hits round a corner, harder after the bounce', !!hit && hit.t === 'hit' && hit.damage >= Math.round(28 * 1.35),
    hit && hit.t === 'hit' ? `damage=${hit.damage}` : 'no hit');
  check('and draws one tracer per segment', count(r, 'tracer') === 2);
  const direct = range('bouncer', 10, [block, side]);
  pull(direct, { pitch: -0.06 });
  check('the wall blocks the direct shot', direct.foe.health === 100);
}
{ // swap
  const r = range('swapper');
  pull(r, { pitch: BODY });
  check('SWAPPER trades places', Math.abs(r.me.pos.z + 6) < 0.3 && Math.abs(r.foe.pos.z) < 0.3 && r.foe.health === 88,
    `me.z=${f(r.me.pos.z)} foe.z=${f(r.foe.pos.z)}`);
}
{ // gust
  const r = range('gust', 4);
  pull(r, { pitch: BODY });
  step(r, 2);
  check('GUST shoves the target and barely hurts', Math.hypot(r.foe.vel.x, r.foe.vel.z) > 10 && r.foe.health > 80,
    `speed=${f(Math.hypot(r.foe.vel.x, r.foe.vel.z))} hp=${r.foe.health}`);
  const far = range('gust', 14);
  pull(far, { pitch: -0.04 });
  check('GUST is short range', far.foe.health === 100 && Math.hypot(far.foe.vel.x, far.foe.vel.z) < 0.1);
}
{ // knife
  const front = range('shiv', 1.6);
  step(front, 2); // let the target turn to face us
  pull(front, { pitch: -0.3 });
  const back = range('shiv', 1.6);
  step(back, 2, {}, { yaw: 0 }); // target looks away
  pull(back, { pitch: -0.3 }, { yaw: 0 });
  check('SHIV: 34 from the front, a kill from behind', front.foe.health === 66 && !back.foe.alive, `front=${front.foe.health}`);
  const wear = range('shiv', 30);
  step(wear, 60 * 8, { buttons: BTN.FIRE });
  check('melee weapons wear out', wear.me.weapons[0]?.ammo === 0, `left=${wear.me.weapons[0]?.ammo}`);
  const thrown = range('shiv', 5);
  step(thrown, 1, { buttons: BTN.THROW, pitch: 0.02 });
  step(thrown, 40, { pitch: 0.02 });
  check('a thrown SHIV does 80', thrown.foe.health === 20, `hp=${thrown.foe.health}`);
}
{ // bat
  const r = range('slugger', 2);
  pull(r, { pitch: -0.25 });
  step(r, 1);
  check('SLUGGER sends the target flying', Math.hypot(r.foe.vel.x, r.foe.vel.z) > 7 && r.foe.vel.y > 1 && r.foe.health === 55,
    `speed=${f(Math.hypot(r.foe.vel.x, r.foe.vel.z))} hp=${r.foe.health}`);
}
{ // zapper
  const near = range('zapper', 11);
  step(near, 30, { buttons: BTN.FIRE, pitch: -0.056 });
  const far = range('zapper', 14.5);
  step(far, 30, { buttons: BTN.FIRE, pitch: -0.043 });
  check('ZAPPER reaches 11 m but not 14.5 m', near.foe.health < 100 && far.foe.health === 100, `near=${near.foe.health}`);
}
{ // grenade launcher
  const direct = range('lobber', 8);
  pull(direct, { pitch: -0.02 });
  step(direct, 30);
  const when = direct.events.findIndex((e) => e.t === 'explosion');
  check('LOBBER explodes at once on a direct hit', when >= 0 && direct.foe.health < 30, `hp=${direct.foe.health}`);
  const lob = range('lobber', 35);
  pull(lob, { yaw: Math.PI / 2, pitch: -0.5 }); // into the floor, away from everyone
  let ticks = 0;
  while (!lob.events.some((e) => e.t === 'explosion') && ticks < 300) { step(lob, 1); ticks++; }
  const fuse = WEAPONS.lobber.projectile!.fuse!;
  check('otherwise it bounces and goes off on its fuse', Math.abs(ticks * DT - fuse) < 0.1 && count(lob, 'thud') >= 1, `t=${f(ticks * DT)}s bounces=${count(lob, 'thud')}`);
}
{ // hand grenades
  const r = range('pineapple', 30);
  pull(r, { pitch: 0.3 });
  check('PINEAPPLE: one left after the first throw', r.me.weapons[0]?.ammo === 1);
  step(r, 50);
  pull(r, { pitch: 0.3 });
  check('and the weapon is gone after the second', r.me.weapons[0] === null);
  let ticks = 0;
  while (count(r, 'explosion') < 2 && ticks < 400) { step(r, 1); ticks++; }
  check('both grenades explode', count(r, 'explosion') === 2);
}
{ // mines
  const wall: Solid = { type: 'box', mat: 'concrete', min: v3(-4, 0, -9), max: v3(4, 5, -8) };
  const r = range('clinger', 30, [wall]);
  pull(r, { pitch: 0.15 });
  step(r, 60 * 3);
  const mine = r.sim.projectiles[0];
  check('CLINGER sticks to a wall and waits', !!mine && mine.stuck && mine.pos.y > 0.5 && mine.pos.z < -7.9 && count(r, 'explosion') === 0,
    mine ? `y=${f(mine.pos.y)} z=${f(mine.pos.z)}` : 'gone');
  r.foe.pos = v3(0.5, 0.01, -6.5); // someone wanders past
  step(r, 3);
  check('and goes off when someone comes close', count(r, 'explosion') === 1 && r.foe.health < 70, `hp=${r.foe.health}`);
  const own = range('clinger', 30);
  pull(own, { pitch: -1.2 }); // at your own feet
  step(own, 90);
  check('it does not spare its owner', own.me.health < 100, `hp=${own.me.health}`);
}
{ // moving platform carries a mine
  const plat: Solid = {
    type: 'box', mat: 'hazard', min: v3(-1.5, 0, -6), max: v3(1.5, 0.4, -3),
    mover: { dx: 8, dy: 0, dz: 0, moveTime: 3, waitA: 0.5, waitB: 0.5, phase: 0 },
  };
  const r = range('clinger', 30, [plat]);
  pull(r, { pitch: -0.3 });
  step(r, 150);
  const mine = r.sim.projectiles[0];
  check('a mine rides the platform it is stuck to', !!mine && mine.stuck && mine.pos.x > 3, mine ? `x=${f(mine.pos.x)}` : 'gone');
}

// ---------------------------------------------------------- second batch
{ // minigun spin-up
  const r = range('kingpin');
  step(r, 30, { buttons: BTN.FIRE, pitch: BODY }); // half a second: still spinning
  const early = count(r, 'fire');
  step(r, 60, { buttons: BTN.FIRE, pitch: BODY });
  check('KINGPIN spins up before it fires, then shreds', early === 0 && count(r, 'fire') > 5 && !r.foe.alive, `early=${early} shots=${count(r, 'fire')}`);
}
{ // railgun pierces
  const r = range('verdict');
  const third = r.sim.addPlayer(3, 'BEHIND', 3);
  third.pos = v3(0, 0.01, -12);
  pull(r, { pitch: BODY });
  check('VERDICT goes through everyone in line', !r.foe.alive && !third.alive && count(r, 'tracer') === 1);
}
{ // the big one
  const r = range('bigone', 9);
  r.me.pos = v3(0, 0.01, 30); // fire from far away, at the floor in front of the target
  pull(r, { pitch: -0.045 });
  let ticks = 0;
  while (!count(r, 'explosion') && ticks < 600) { step(r, 1); ticks++; }
  const boom = r.events.find((e) => e.t === 'explosion');
  check('BIG ONE: slow rocket, enormous blast', ticks * DT > 1.5 && !!boom && boom.t === 'explosion' && boom.radius === 11 && !r.foe.alive,
    `flight=${f(ticks * DT)}s`);
  check('and it leaves your hand empty-handed', r.me.weapons[0]?.ammo === 0);
}
{ // cluster
  const r = range('pinata', 35);
  pull(r, { yaw: Math.PI / 2, pitch: -0.3 });
  step(r, 60 * 4);
  check('PINATA bursts into bomblets', count(r, 'explosion') === 1 + WEAPONS.pinata.projectile!.cluster!, `explosions=${count(r, 'explosion')}`);
}
{ // hammer and fish
  const h = range('banhammer', 2);
  step(h, 2);
  pull(h, { pitch: -0.25 });
  check('BANHAMMER ends it in one swing', !h.foe.alive);
  const toll = h.events.find((e) => e.t === 'hit' && e.victim === 2);
  check('a BANHAMMER hit says it was the BANHAMMER (so the bell tolls)', toll?.t === 'hit' && toll.cause === 'banhammer');
  const fsh = range('fish', 1.8);
  step(fsh, 2);
  pull(fsh, { pitch: -0.3 });
  step(fsh, 1);
  check('FISH: six damage, one flying dazed opponent', fsh.foe.health === 94 && Math.hypot(fsh.foe.vel.x, fsh.foe.vel.z) > 6 && fsh.foe.stun > 0.5,
    `hp=${fsh.foe.health} stun=${f(fsh.foe.stun)}`);
}
{ // freeze, pull, gamble, flame
  const ice = range('icebox');
  pull(ice, { pitch: BODY });
  check('ICEBOX slows what it hits', ice.foe.stun > 1.4 && ice.foe.health === 91);
  const reel = range('reeler', 12);
  pull(reel, { pitch: -0.05 });
  step(reel, 1);
  check('REELER yanks the target towards you', reel.foe.vel.z > 9 && reel.foe.vel.y > 2, `vz=${f(reel.foe.vel.z)}`);
  const rolls: number[] = [];
  for (let n = 0; n < 12; n++) {
    const g = range('gambler');
    g.foe.health = 1000;
    for (let k = 0; k <= n; k++) { pull(g, { pitch: BODY }); step(g, 30, { pitch: BODY }); } // different seeds of luck
    const hits = g.events.filter((e) => e.t === 'hit');
    const last = hits[hits.length - 1];
    if (last && last.t === 'hit') rolls.push(last.damage);
    if (rolls.length >= 7) break;
  }
  check('GAMBLER rolls its damage between 1 and 140', rolls.length >= 5 && rolls.every((d) => d >= 1 && d <= 140) && new Set(rolls).size > 3, rolls.join(' '));
  const near = range('toaster', 4), far = range('toaster', 11);
  step(near, 30, { buttons: BTN.FIRE, pitch: -0.15 });
  step(far, 30, { buttons: BTN.FIRE, pitch: -0.056 });
  check('TOASTER burns up close and reaches nothing at 11 m', near.foe.health < 60 && far.foe.health === 100, `near=${near.foe.health}`);
}
{ // bolts
  const r = range('stapler');
  pull(r, { pitch: BODY });
  step(r, 20);
  check('STAPLER: a bolt, no blast', r.foe.health === 35 && count(r, 'explosion') === 0, `hp=${r.foe.health}`);
  const lob = range('stapler', 40);
  pull(lob, { pitch: -0.02 });
  step(lob, 60);
  check('and it drops over distance', lob.foe.health === 100);
}
{ // hot potato
  const r = range('potato', 6);
  const third = r.sim.addPlayer(3, 'BYSTANDER', 3);
  third.pos = v3(12, 0.01, -6);
  pull(r, { pitch: 0.02 });
  step(r, 40);
  const pr = r.sim.projectiles[0];
  check('POTATO sticks to whoever it hits', !!pr && pr.attached === 2);
  r.foe.pos = v3(11.2, 0.01, -6); // the victim runs up to someone else
  step(r, 20); // (it cannot be passed for the first 0.6 s)
  check('and is passed on by touch', r.sim.projectiles[0]?.attached === 3);
  r.foe.pos = v3(-15, 0.01, -6);
  step(r, 60 * 3);
  check('then goes off on its new owner', count(r, 'explosion') === 1 && !third.alive && r.foe.alive);
}

// ------------------------------------------------------------ dual wield
{
  const r = range('rivet');
  r.me.weapons[1] = { type: 'magnate', ammo: 6 };
  check('two one-handed weapons are dual wielded', isDual(r.me));
  step(r, 1, { buttons: BTN.FIRE, pitch: BODY });
  step(r, 1, { pitch: BODY });
  const left = r.events.filter((e) => e.t === 'fire');
  check('first button fires the left weapon', left.length === 1 && left[0].t === 'fire' && left[0].weapon === 'rivet' && left[0].hand === 0
    && r.me.weapons[0]!.ammo === 11 && r.me.weapons[1]!.ammo === 6);
  step(r, 1, { buttons: BTN.FIRE2, pitch: BODY });
  step(r, 1, { pitch: BODY });
  const fires = r.events.filter((e) => e.t === 'fire');
  const last = fires[fires.length - 1];
  check('second button fires the right weapon', fires.length === 2 && last.t === 'fire' && last.weapon === 'magnate' && last.hand === 1 && r.me.weapons[1]!.ammo === 5);
  r.foe.health = 1000;
  step(r, 40, { pitch: BODY }); // let both cool down
  r.events.length = 0;
  step(r, 1, { buttons: BTN.FIRE | BTN.FIRE2, pitch: BODY });
  check('both fire on the same tick, each on its own cooldown', count(r, 'fire') === 2);
  // swapping "active" while dual changes nothing about who fires
  step(r, 30, { pitch: BODY });
  step(r, 1, { buttons: BTN.SWAP, pitch: BODY });
  step(r, 1, { buttons: BTN.FIRE, pitch: BODY });
  const f2 = r.events.filter((e) => e.t === 'fire');
  const l2 = f2[f2.length - 1];
  check('the first button still means the left weapon after a swap', l2.t === 'fire' && l2.weapon === 'rivet');
}
{
  const r = range('rivet');
  r.me.weapons[1] = { type: 'slab', ammo: 6 }; // one-handed + two-handed: no dual wield
  const ONE = ['zapper', 'rivet', 'pepper', 'magnate', 'swapper', 'hornet', 'chatter', 'toaster', 'icebox', 'reeler', 'stapler', 'gambler', 'pineapple', 'fish', 'potato', 'shiv'];
  check('one-handed = the agreed sixteen plus the five traps', ALL.filter((id) => WEAPONS[id].hands === 1).sort().join() === [...ONE, ...TRAPS].sort().join());
  check('a two-handed weapon is not dual wielded', !isDual(r.me));
  step(r, 1, { buttons: BTN.FIRE2, pitch: BODY });
  step(r, 2, { pitch: BODY });
  check('second button does nothing then', count(r, 'fire') === 0 && r.me.weapons[1]!.ammo === 6);
  step(r, 1, { buttons: BTN.FIRE, pitch: BODY });
  const fr = r.events.find((e) => e.t === 'fire');
  check('and the first button fires the active weapon as before', !!fr && fr.t === 'fire' && fr.weapon === 'rivet' && fr.hand === -1);
}
{ // running dry in one hand, burst in the other
  const r = range('pepper');
  r.me.weapons[1] = { type: 'rivet', ammo: 0 };
  step(r, 1, { buttons: BTN.FIRE | BTN.FIRE2, pitch: BODY }); // burst left, throw the empty right gun
  step(r, 20, { pitch: BODY });
  check('an empty hand throws its gun while the other keeps firing', r.me.weapons[1] === null && count(r, 'throw') === 1 && count(r, 'fire') === 3 && !isDual(r.me),
    `fires=${count(r, 'fire')} throws=${count(r, 'throw')}`);
}

// ----------------------------------------------------------------- traps
check('five traps, all one-handed and used up when placed',
  TRAPS.length === 5 && TRAPS.every((id) => WEAPONS[id].hands === 1 && WEAPONS[id].consumed && !!WEAPONS[id].projectile?.sticky), TRAPS.join(' '));
/** Toss a trap in front of the shooter and wait for it to arm. Returns where it ended up. */
function place(r: Range): { x: number; y: number; z: number } {
  pull(r, { pitch: -0.3 });
  step(r, 90);
  const t = r.sim.projectiles[0];
  return { ...t.pos };
}
{ // bear trap
  const r = range('snapper', 30);
  const at = place(r);
  check('SNAPPER lands a couple of metres ahead and waits', r.sim.projectiles[0].stuck && at.z < -1.5 && at.z > -5 && count(r, 'trap') === 0, `z=${f(at.z)}`);
  r.foe.pos = v3(at.x, 0.01, at.z);
  step(r, 2);
  check('it bites: damage, and the trap is spent', r.foe.health === 70 && r.sim.projectiles.length === 0 && count(r, 'trap') === 1);
  const held = { ...r.foe.pos };
  step(r, 60, {}, { moveF: 1, buttons: BTN.JUMP, yaw: Math.PI });
  check('the victim cannot walk or jump out', Math.hypot(r.foe.pos.x - held.x, r.foe.pos.z - held.z) < 0.01 && r.foe.pos.y < 0.1);
  step(r, 120, {}, { moveF: 1, yaw: Math.PI });
  check('and is free again after 2.5 s', Math.hypot(r.foe.pos.x - held.x, r.foe.pos.z - held.z) > 2);
}
{ // its owner is not safe from it either
  const r = range('snapper', 30);
  const at = place(r);
  r.me.pos = v3(at.x, 0.01, at.z);
  step(r, 2);
  check('a SNAPPER catches its owner too', r.me.health === 70 && r.me.rooted > 2);
}
{ // spring plate
  const r = range('popper', 30);
  const at = place(r);
  r.foe.pos = v3(at.x, 0.01, at.z);
  step(r, 2);
  let maxY = 0;
  for (let i = 0; i < 120; i++) { step(r, 1); maxY = Math.max(maxY, r.foe.pos.y); }
  check('POPPER flings its victim into the air, unharmed', maxY > 6 && r.foe.health === 100, `maxY=${f(maxY)}`);
}
{ // sentry
  const r = range('sentry', 8);
  place(r);
  const shots0 = r.events.filter((e) => e.t === 'fire' && e.player === -1).length;
  step(r, 60 * 2);
  const shots = r.events.filter((e) => e.t === 'fire' && e.player === -1).length - shots0;
  check('SENTRY shoots the enemy in view', shots > 5 && r.foe.health < 70, `shots=${shots} hp=${r.foe.health}`);
  check('but never its owner, who is standing right next to it', r.me.health === 100);
  step(r, 60 * 30);
  check('it kills given time, credits its owner, and runs down', !r.foe.alive && r.me.kills === 1 && r.sim.projectiles.length === 0);
}
{ // gas
  const r = range('stinker', 30);
  const at = place(r);
  r.foe.pos = v3(at.x + 1.5, 0.01, at.z);
  step(r, 3);
  check('STINKER opens when someone walks past', count(r, 'trap') === 1 && r.sim.projectiles[0]?.gen === 2);
  step(r, 60 * 2);
  const mid = r.foe.health;
  check('everyone in the cloud takes damage over time', mid < 80 && mid > 30, `hp after 2 s=${mid}`);
  r.foe.pos = v3(at.x + 12, 0.01, at.z); // gets out
  step(r, 60 * 2);
  check('and stops once out of it', r.foe.health === mid);
  step(r, 60 * 5);
  check('the cloud clears after 7 s', r.sim.projectiles.length === 0);
}
{ // swap gun announces itself
  const r = range('swapper');
  pull(r, { pitch: BODY });
  const sw = r.events.find((e) => e.t === 'swap');
  check('a swap is reported with who did it to whom', !!sw && sw.t === 'swap' && sw.a === 1 && sw.b === 2);
}

// ---------------------------------------------------------- balance table
// Everything fired at a stationary 100 hp target 6 m away, aimed at the chest.
console.log('\n  weapon      tier  kind        uses  dmg/pickup   time to kill   empties in');
const ttks: Record<string, number> = {};
for (const id of ALL) {
  const def = WEAPONS[id];
  const r = range(id, def.kind === 'melee' ? 1.8 : 6);
  step(r, 2); // let the target turn to face us (no free backstabs)
  r.me.cooldown = [0, 0];
  r.foe.health = 1e6;
  const pitch = def.kind === 'melee' ? -0.3 : ['lobber', 'pineapple', 'clinger', 'pinata', 'potato'].includes(id) ? 0.02 : BODY;
  let ttk = -1, emptied = -1;
  for (let t = 0; t < 60 * 20; t++) {
    // hold for automatics, tap every other tick for the rest
    const fire = def.auto || t % 2 === 0 ? BTN.FIRE : 0;
    const w = r.me.weapons[0];
    step(r, 1, { buttons: w && w.ammo > 0 ? fire : 0, pitch });
    r.me.health = 100; // ignore self-damage here
    r.me.pos = v3(0, 0.01, 0); r.me.vel = v3();
    r.foe.pos = v3(0, 0.01, def.kind === 'melee' ? -1.8 : -6); r.foe.vel = v3();
    const dealt = 1e6 - r.foe.health;
    if (ttk < 0 && dealt >= 100) ttk = t * DT;
    if (emptied < 0 && (!w || w.ammo <= 0)) emptied = t * DT;
    if (emptied >= 0 && t * DT > emptied + 3) break;
  }
  const dealt = 1e6 - r.foe.health;
  ttks[id] = ttk;
  console.log(`  ${def.name.padEnd(10)}  ${def.tier}     ${def.kind.padEnd(10)}  ${String(def.ammo).padStart(4)}  ${f(dealt, 0).padStart(10)}   ${(ttk < 0 ? 'never' : f(ttk) + ' s').padStart(12)}   ${(f(emptied) + ' s').padStart(10)}`);
}
{
  const kills = ALL.filter((id) => !['gust', 'swapper', 'fish', 'reeler', 'snapper', 'popper', 'stinker', 'sentry'].includes(id)); // (the sentry's kill is tested on its own, above) // utility tools are not meant to kill
  check('every damage weapon can kill a full-health player with one pickup', kills.every((id) => ttks[id] >= 0),
    kills.filter((id) => ttks[id] < 0).join(' '));
  const basic = WEAPON_TIERS[0].filter((id) => WEAPONS[id].kind === 'hitscan').map((id) => ttks[id]);
  check('basic guns kill in 0.4-1.2 s at 6 m', basic.every((t) => t >= 0.4 && t <= 1.2), basic.map((t) => f(t)).join(' '));
}

// ------------------------------------------------------------ melee powers
{
  // SHIV: a cut keeps bleeding, cuts stack, and a bleed-out counts as the knifer's kill.
  const one = range('shiv', 1.6);
  step(one, 2);
  pull(one, { pitch: -0.3 });
  const afterCut = one.foe.health;
  step(one, 60 * 5);
  const bled = afterCut - one.foe.health;
  check('SHIV: a cut keeps bleeding for a few seconds', bled >= 22 && bled <= 26 && one.foe.bleed === 0, `hit to ${afterCut}, then bled ${bled}`);
  const three = range('shiv', 1.6);
  three.foe.health = 1000; // so the cuts do not kill outright
  step(three, 2);
  for (let i = 0; i < 3; i++) { pull(three, { pitch: -0.3 }); step(three, 16); }
  check('SHIV: cuts stack up to three', three.foe.bleedStacks === 3, `stacks=${three.foe.bleedStacks}`);
  const out = range('shiv', 1.6);
  step(out, 2);
  pull(out, { pitch: -0.3 });
  out.foe.health = 6;
  step(out, 60 * 3);
  const kill = out.events.find((e) => e.t === 'kill');
  check('SHIV: bleeding out is the knifer\'s kill', !out.foe.alive && kill?.t === 'kill' && kill.killer === 1 && kill.cause === 'shiv' && out.me.kills === 1);
  check('SHIV: bleed damage is marked as damage over time', out.events.filter((e) => e.t === 'hit' && e.dot).length >= 1);
}
{
  // FISH: a drenched target skids like on ice, and the ZAPPER hurts them double.
  const glide = (soak: boolean): number => {
    const r = range(null, 30);
    r.foe.pos = v3(0, 0.01, -10);
    step(r, 10); // settle on the floor
    if (soak) r.foe.soaked = 3;
    r.foe.vel = v3(0, 0, -8);
    const z0 = r.foe.pos.z;
    step(r, 60);
    return z0 - r.foe.pos.z;
  };
  const dry = glide(false), wet = glide(true);
  check('FISH: soaked players skid much further', wet > dry * 2, `dry ${f(dry)} m, soaked ${f(wet)} m`);
  const fsh = range('fish', 1.8);
  step(fsh, 2);
  pull(fsh, { pitch: -0.3 });
  check('FISH: a slap soaks', fsh.foe.soaked > 3, `soaked=${f(fsh.foe.soaked)}`);
  const zap = (soak: boolean): number => {
    const r = range('zapper', 6);
    step(r, 2);
    if (soak) r.foe.soaked = 3;
    pull(r, { pitch: BODY });
    return 100 - r.foe.health;
  };
  const z1 = zap(false), z2 = zap(true);
  check('FISH: water conducts, the ZAPPER does double to the soaked', z2 === z1 * 2 && z1 > 0, `${z1} vs ${z2}`);
}
{
  // SLUGGER: batted into a wall hurts a lot more than batted into the open.
  const swing = (wall: boolean): number => {
    const r = range('slugger', 2, wall ? [{ type: 'box', mat: 'concrete', min: v3(-6, 0, -6), max: v3(6, 4, -5) }] : []);
    pull(r, { pitch: -0.25 });
    step(r, 60);
    return r.foe.health;
  };
  const open = swing(false), wall = swing(true);
  check('SLUGGER: a wall splat adds heavy damage', open === 55 && wall < 15, `open field hp=${open}, into a wall hp=${wall}`);
}
{
  // FISTS: one, two, UPPERCUT: the third quick hit on the same target does double and launches.
  const r = range(null, 1.5);
  r.foe.health = 1000;
  step(r, 2);
  const hits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const before = r.foe.health;
    r.foe.pos = v3(0, 0.01, -1.5); r.foe.vel = v3(); // keep them in reach
    pull(r, { pitch: -0.3 });
    hits.push(before - r.foe.health);
    if (i === 2) break;
    step(r, 22);
  }
  check('FISTS: the third hit in a row is an uppercut', hits[0] === 18 && hits[1] === 18 && hits[2] >= 39 && r.foe.vel.y > 6 && r.foe.stun > 0.4,
    `hits ${hits.join(', ')} launch=${f(r.foe.vel.y)}`);
  const slow = range(null, 1.5);
  slow.foe.health = 1000;
  step(slow, 2);
  for (let i = 0; i < 3; i++) { slow.foe.pos = v3(0, 0.01, -1.5); slow.foe.vel = v3(); pull(slow, { pitch: -0.3 }); step(slow, 70); }
  check('FISTS: slow punches never combo', !slow.events.some((e) => e.t === 'status' && e.kind === 'combo'));
}

// ------------------------------------------------------------------ aiming
{
  // Average angle of the shots away from the aim line, with and without aiming.
  const scatter = (aim: boolean): number => {
    const r = range('chatter', 6);
    r.foe.pos = v3(30, 0.01, 0); // out of the line of fire
    r.me.infiniteAmmo = true;
    const buttons = BTN.FIRE | (aim ? BTN.FIRE2 : 0);
    let sum = 0, n = 0;
    for (let i = 0; i < 300; i++) {
      step(r, 1, { buttons });
      for (const e of r.events) {
        if (e.t !== 'tracer') continue;
        const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y, dz = e.to.z - e.from.z;
        sum += Math.acos(Math.max(-1, Math.min(1, -dz / Math.hypot(dx, dy, dz)))) * 180 / Math.PI;
        n++;
      }
      r.events.length = 0;
    }
    return sum / n;
  };
  const hip = scatter(false), aimed = scatter(true);
  check('aiming tightens the spread', aimed < hip * (AIM.spread + 0.15) && aimed > 0, `hip ${f(hip)}°, aimed ${f(aimed)}°`);

  const r = range('rivet', 6);
  step(r, 2, { buttons: BTN.FIRE2, pitch: BODY });
  check('one-handed gun: right click aims and does not shoot', r.me.aiming && count(r, 'fire') === 0);
  r.me.weapons[1] = { type: 'rivet', ammo: 12 };
  step(r, 1, { pitch: BODY }); // let go first: pistols fire on the press
  r.events.length = 0;
  step(r, 2, { buttons: BTN.FIRE2, pitch: BODY });
  check('dual wielding: right click still fires the right-hand gun, no aiming', !r.me.aiming && count(r, 'fire') === 1);

  const n = range('needle', 6);
  step(n, 1, { buttons: BTN.FIRE2 });
  check('the NEEDLE aims through a scope', n.me.aiming && (WEAPONS.needle.scope ?? 0) > 0 && (WEAPONS.needle.scope ?? 99) < 40);
  const noAim = (['fists', 'shiv', 'slugger', 'pineapple', 'clinger', 'snapper'] as WeaponId[]).filter((id) => canAim(WEAPONS[id]));
  check('fists, blades, grenades and traps cannot aim', noAim.length === 0, noAim.join(','));
  const f2 = range(null, 6);
  step(f2, 1, { buttons: BTN.FIRE2 });
  check('empty hands do not aim', !f2.me.aiming);
  n.me.health = 0; n.me.alive = false;
  step(n, 1, { buttons: BTN.FIRE2 });
  check('the dead do not aim', !n.me.aiming);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('weapon tests failed');
