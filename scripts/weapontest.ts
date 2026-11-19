// Weapon behaviour tests + balance table: `npm run test:weapons`.
import { AIM, DT, PLAYER, RULES_PRACTICE } from '../src/config/game';
import { LEGENDARIES, LEGENDARY_CHANCE, TRAPS, WEAPON_TIERS, WEAPONS, type WeaponId } from '../src/config/weapons';
import { World } from '../src/sim/world';
import { v3, type Vec3 } from '../src/core/vec';
import { THEMES } from '../src/maps/themes';
import { FACES, LEGS, TORSOS, cleanLook } from '../src/config/looks';
import { LOOK_COUNTS, MOUTH_OPEN, animateMouth, buildCharacter, buildProjectileModel, buildWeaponModel } from '../src/render/models';
import { WOUND_STAGES, showWounds } from '../src/render/wounds';
import { mouthOpenFor } from '../src/audio/voice';
import * as THREE from 'three';
import { FIRE_OWNER_GRACE, GameSim, canAim, clampLoud, isDual } from '../src/sim/game';
import { buildTestMap } from '../src/maps/testMap';
import type { MapDef, Solid } from '../src/sim/map';
import { BTN, type InputCmd, type Player, type SimEvent } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number, d = 2) => n.toFixed(d);
const HP = PLAYER.maxHealth; // full health
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
const TOTAL = 41;
check(`${TOTAL} weapons plus fists`, ALL.length === TOTAL, `have ${ALL.length}`);
const TIERED = TOTAL - LEGENDARIES.length;
check('every weapon but the legendaries is in exactly one tier', WEAPON_TIERS.flat().length === TIERED && new Set(WEAPON_TIERS.flat()).size === TIERED
  && !LEGENDARIES.some((id) => WEAPON_TIERS.flat().includes(id)), WEAPON_TIERS.map((t) => t.length).join('/'));
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

// ---------------------------------------------------------------- wounds
{
  /** Is this wound on the outside of the body: looking straight at it from outside, is it the first thing you see? */
  const inSight = (c: ReturnType<typeof buildCharacter>, g: THREE.Group): boolean => {
    c.root.updateMatrixWorld(true);
    const centre = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
    const out = new THREE.Vector3(0, 0, 1).transformDirection(g.matrixWorld);
    const rc = new THREE.Raycaster(centre.clone().addScaledVector(out, 1.5), out.clone().negate(), 0, 3);
    const solid: THREE.Object3D[] = [];
    c.root.traverse((o) => { if (o instanceof THREE.Mesh && o.visible && o !== c.shadow) solid.push(o); });
    const hit = rc.intersectObjects(solid, false)[0];
    return !!hit && !!g.getObjectById(hit.object.id);
  };
  const names = ['scuff', 'arm', 'shin', 'ribs', 'cheek', 'arm 2', 'shin 2'];
  const missing: string[] = [], hidden: string[] = [];
  const parts = ['face', 'torso', 'legs'];
  for (let slot = 0; slot < 3; slot++) {
    for (let n = 0; n < LOOK_COUNTS[slot]; n++) {
      const look = [0, 0, 0];
      look[slot] = n;
      const c = buildCharacter(0x3aa6e8, look);
      showWounds(c.wounds, 0, 1); // all open
      const have = new Set(c.wounds.list.map((w) => WOUND_STAGES.indexOf(w.below as typeof WOUND_STAGES[number])));
      // a stage that belongs to the slot being varied: the cheek to faces, scuff and ribs to torsos, shins to legs
      const mine = slot === 0 ? [4] : slot === 1 ? [0, 3] : [2, 6];
      for (const k of mine) if (!have.has(k)) missing.push(`${parts[slot]} ${n}: ${names[k]}`);
      for (const w of c.wounds.list) if (!inSight(c, w.group)) hidden.push(`${parts[slot]} ${n}: ${names[WOUND_STAGES.indexOf(w.below as typeof WOUND_STAGES[number])]}`);
    }
  }
  console.log('  outfits that leave a wound out (nothing to stick it to):', missing.join(', ') || 'none');
  check('every face and torso gets its wounds', !missing.some((m) => !m.startsWith('legs')), missing.join(', '));
  check('no wound is buried inside the body', hidden.length === 0, hidden.join(', '));
  const c = buildCharacter(0xe8503a, [0, 0, 0]);
  const shownAt = (hp: number) => { showWounds(c.wounds, hp, 1); return c.wounds.list.filter((w) => w.group.visible).length; };
  check('wounds open one by one as health falls', shownAt(100) === 0 && shownAt(84) === 1 && shownAt(50) === 3 && shownAt(30) === 5 && shownAt(5) === 7 && shownAt(100) === 0,
    [100, 84, 50, 30, 5].map((h) => `${h}hp:${shownAt(h)}`).join(' '));
}

// ---------------------------------------------------------------- mouths
{
  /**
   * The upper lip: the vertices along the bottom front of the head.
   * Returns a function giving their lowest height now, so it can be compared
   * before and after the mouth opens.
   */
  const upperLip = (c: ReturnType<typeof buildCharacter>): (() => number) => {
    c.root.updateMatrixWorld(true);
    const all: { m: THREE.Mesh; i: number; y: number; z: number }[] = [];
    const v = new THREE.Vector3();
    c.mouth.lid.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || c.mouth.palate.getObjectById(o.id)) return;
      const pos = o.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        all.push({ m: o, i, y: v.y, z: v.z });
      }
    });
    const minY = Math.min(...all.map((p) => p.y));
    const base = all.filter((p) => p.y < minY + 0.08);
    const zf = Math.min(...base.map((p) => p.z)), zb = Math.max(...base.map((p) => p.z));
    const lip = base.filter((p) => p.z <= zf + (zb - zf) * 0.3); // the front of the mouth, where you see it open
    return () => {
      c.root.updateMatrixWorld(true);
      let low = Infinity;
      for (const p of lip) low = Math.min(low, v.fromBufferAttribute(p.m.geometry.getAttribute('position'), p.i).applyMatrix4(p.m.matrixWorld).y);
      return low;
    };
  };
  let bad = '';
  for (let f = 0; f < LOOK_COUNTS[0]; f++) {
    const c = buildCharacter(0xe8503a, [f, 0, 0]);
    const lip = upperLip(c);
    const closed = lip();
    for (let i = 0; i < 60; i++) animateMouth(c.mouth, 0, 1 / 60);
    const shut = c.mouth.lid.rotation.x === 0 && !c.mouth.jaw.visible && !c.mouth.palate.visible;
    for (let i = 0; i < 20; i++) animateMouth(c.mouth, 1, 1 / 60);
    const lift = lip() - closed;
    const wide = Math.abs(c.mouth.lid.rotation.x - MOUTH_OPEN) < 0.02 && c.mouth.jaw.visible && c.mouth.palate.visible;
    for (let i = 0; i < 30; i++) animateMouth(c.mouth, 0, 1 / 60);
    const shutAgain = c.mouth.lid.rotation.x === 0 && !c.mouth.jaw.visible;
    if (!shut || !wide || lift < 0.12 || !shutAgain) bad += `${f}(lift ${lift.toFixed(2)}) `;
  }
  check(`all ${LOOK_COUNTS[0]} faces open their mouth wide when talking and shut when silent`, !bad, bad);
  const c = buildCharacter(0x3aa6e8, [0, 0, 0]);
  let frames = 0;
  while (c.mouth.open < 0.9 && frames < 60) { animateMouth(c.mouth, 1, 1 / 60); frames++; }
  check('a mouth snaps open within a syllable (under 0.1 s)', frames * (1000 / 60) < 100, `${frames} frames`);
  check('silence keeps it shut, a loud voice opens it fully', mouthOpenFor(0.004) === 0 && mouthOpenFor(0.2) === 1 && mouthOpenFor(0.05) > 0.3);
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
    const head = Math.round(WEAPONS[id].damage * WEAPONS[id].headMult);
    // At 150 health only the NEEDLE's headshot (170) is still a one-shot kill; the MAGNATE's (101) leaves 49.
    if (head >= HP) check(`${WEAPONS[id].name} kills with one headshot`, !r.foe.alive);
    else check(`${WEAPONS[id].name}: one headshot does ${head}, two kill`, r.foe.alive && r.foe.health === HP - head, `hp=${r.foe.health}`);
    const b = range(id);
    pull(b, { pitch: BODY });
    // The NEEDLE kills with any hit; the MAGNATE needs a few to the body.
    if (WEAPONS[id].damage >= HP) check(`${WEAPONS[id].name} kills with one body shot`, !b.foe.alive);
    else check(`${WEAPONS[id].name} does not kill with one body shot`, b.foe.alive && b.foe.health === HP - WEAPONS[id].damage, `hp=${b.foe.health}`);
  }
}
{ // double barrel throws the shooter
  const r = range('twins', 30);
  pull(r, { pitch: -1.3 }); // at the floor
  check('TWINS recoil launches the shooter', r.me.vel.y > 5, `vy=${f(r.me.vel.y)}`);
  const c = range('twins', 3);
  pull(c, { pitch: BODY * 2 });
  step(c, 20, { pitch: BODY * 2 });
  pull(c, { pitch: BODY * 2 });
  check('TWINS kills point blank with both barrels', !c.foe.alive);
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
  check('the wall blocks the direct shot', direct.foe.health === HP);
}
{ // swap
  const r = range('swapper');
  pull(r, { pitch: BODY });
  check('SWAPPER trades places', Math.abs(r.me.pos.z + 6) < 0.3 && Math.abs(r.foe.pos.z) < 0.3 && r.foe.health === HP - 12,
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
  check('GUST is short range', far.foe.health === HP && Math.hypot(far.foe.vel.x, far.foe.vel.z) < 0.1);
}
{ // knife
  const front = range('shiv', 1.6);
  step(front, 2); // let the target turn to face us
  pull(front, { pitch: -0.3 });
  const back = range('shiv', 1.6);
  step(back, 2, {}, { yaw: 0 }); // target looks away
  pull(back, { pitch: -0.3 }, { yaw: 0 });
  check('SHIV: 40 from the front, a kill from behind', front.foe.health === HP - 40 && !back.foe.alive, `front=${front.foe.health}`);
  const wear = range('shiv', 30);
  step(wear, 60 * 8, { buttons: BTN.FIRE });
  check('melee weapons wear out', wear.me.weapons[0]?.ammo === 0, `left=${wear.me.weapons[0]?.ammo}`);
  const thrown = range('shiv', 5);
  step(thrown, 1, { buttons: BTN.THROW, pitch: 0.02 });
  step(thrown, 40, { pitch: 0.02 });
  check('a thrown SHIV does 80', thrown.foe.health === HP - 80, `hp=${thrown.foe.health}`);
}
{ // bat
  const r = range('slugger', 2);
  pull(r, { pitch: -0.25 });
  step(r, 1);
  check('SLUGGER sends the target flying', Math.hypot(r.foe.vel.x, r.foe.vel.z) > 7 && r.foe.vel.y > 1 && r.foe.health === HP - 55,
    `speed=${f(Math.hypot(r.foe.vel.x, r.foe.vel.z))} hp=${r.foe.health}`);
}
{ // zapper
  const near = range('zapper', 11);
  step(near, 30, { buttons: BTN.FIRE, pitch: -0.056 });
  const far = range('zapper', 14.5);
  step(far, 30, { buttons: BTN.FIRE, pitch: -0.043 });
  check('ZAPPER reaches 11 m but not 14.5 m', near.foe.health < HP && far.foe.health === HP, `near=${near.foe.health}`);
}
{ // grenade launcher
  const direct = range('lobber', 8);
  pull(direct, { pitch: -0.02 });
  step(direct, 30);
  const when = direct.events.findIndex((e) => e.t === 'explosion');
  check('LOBBER explodes at once on a direct hit', when >= 0 && direct.foe.health < HP - 70, `hp=${direct.foe.health}`);
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
  check('and goes off when someone comes close', count(r, 'explosion') === 1 && r.foe.health < HP - 30, `hp=${r.foe.health}`);
  const own = range('clinger', 30);
  pull(own, { pitch: -1.2 }); // at your own feet
  step(own, 90);
  check('it does not spare its owner', own.me.health < HP, `hp=${own.me.health}`);
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
  check('KINGPIN spins up before it fires, then shreds', early === 0 && count(r, 'fire') > 5 && r.foe.health < HP / 2, `early=${early} shots=${count(r, 'fire')}`);
}
{ // railgun pierces
  const r = range('verdict');
  const third = r.sim.addPlayer(3, 'BEHIND', 3);
  third.pos = v3(0, 0.01, -12);
  pull(r, { pitch: BODY });
  check('VERDICT goes through everyone in line, killing each', !r.foe.alive && !third.alive && count(r, 'tracer') === 1);
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
  check('PINATA: the burst is a party (once, not per bomblet)', count(r, 'party') === 1, `party events=${count(r, 'party')}`);
  const festive = r.events.filter((e) => e.t === 'explosion' && e.festive).length;
  check('PINATA: every bomblet goes off as a party pop, the grenade itself does not', festive === WEAPONS.pinata.projectile!.cluster!, `festive=${festive}`);
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
  check('FISH: eight damage, one flying dazed opponent', fsh.foe.health === HP - 8 && Math.hypot(fsh.foe.vel.x, fsh.foe.vel.z) > 6 && fsh.foe.stun > 0.5,
    `hp=${fsh.foe.health} stun=${f(fsh.foe.stun)}`);
}
{ // freeze, pull, gamble, flame
  const ice = range('icebox');
  pull(ice, { pitch: BODY });
  check('ICEBOX slows what it hits', ice.foe.stun > 1.4 && ice.foe.health === HP - 9);
  for (const [dist, pitch] of [[12, -0.05], [30, -0.02]] as const) {
    const reel = range('reeler', dist);
    pull(reel, { pitch }, { yaw: Math.PI });
    let land = -1;
    for (let i = 0; i < 90 && land < 0; i++) { // they try to back away the whole time
      step(reel, 1, {}, { yaw: Math.PI, moveF: -1 });
      if (i > 5 && reel.foe.grounded) land = Math.hypot(reel.foe.pos.x, reel.foe.pos.z);
    }
    check(`REELER reels them all the way in from ${dist} m`, reel.foe.health === HP - 15 && land > 1 && land < 5, `landed ${f(land)} m away`);
  }
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
  check('TOASTER burns up close and reaches nothing at 11 m', near.foe.health < HP - 40 && far.foe.health === HP, `near=${near.foe.health}`);
}
{ // bolts
  const r = range('stapler');
  pull(r, { pitch: BODY });
  step(r, 20);
  check('STAPLER: a bolt, no blast', r.foe.health === HP - 65 && count(r, 'explosion') === 0, `hp=${r.foe.health}`);
  const lob = range('stapler', 40);
  pull(lob, { pitch: -0.02 });
  step(lob, 60);
  check('and it drops over distance', lob.foe.health === HP);
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
  check('then goes off on its new owner', count(r, 'explosion') === 1 && third.health < HP / 2 && r.foe.health === HP);
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
  check('it bites: damage, and the trap is spent', r.foe.health === HP - 30 && r.sim.projectiles.length === 0 && count(r, 'trap') === 1);
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
  check('a SNAPPER catches its owner too', r.me.health === HP - 30 && r.me.rooted > 2);
}
{ // spring plate
  const r = range('popper', 30);
  const at = place(r);
  r.foe.pos = v3(at.x, 0.01, at.z);
  step(r, 2);
  let maxY = 0;
  for (let i = 0; i < 120; i++) { step(r, 1); maxY = Math.max(maxY, r.foe.pos.y); }
  check('POPPER flings its victim into the air, unharmed', maxY > 6 && r.foe.health === HP, `maxY=${f(maxY)}`);
}
{ // sentry
  const r = range('sentry', 8);
  place(r);
  const shots0 = r.events.filter((e) => e.t === 'fire' && e.player === -1).length;
  step(r, 60 * 2);
  const shots = r.events.filter((e) => e.t === 'fire' && e.player === -1).length - shots0;
  check('SENTRY shoots the enemy in view', shots > 5 && r.foe.health < HP - 30, `shots=${shots} hp=${r.foe.health}`);
  check('but never its owner, who is standing right next to it', r.me.health === HP);
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
  check('everyone in the cloud takes damage over time', mid < HP - 20 && mid > HP - 70, `hp after 2 s=${mid}`);
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
    r.me.health = HP; // ignore self-damage here
    r.me.pos = v3(0, 0.01, 0); r.me.vel = v3();
    r.foe.pos = v3(0, 0.01, def.kind === 'melee' ? -1.8 : -6); r.foe.vel = v3();
    const dealt = 1e6 - r.foe.health;
    if (ttk < 0 && dealt >= HP) ttk = t * DT;
    if (emptied < 0 && (!w || w.ammo <= 0)) emptied = t * DT;
    if (emptied >= 0 && t * DT > emptied + 3) break;
  }
  const dealt = 1e6 - r.foe.health;
  ttks[id] = ttk;
  console.log(`  ${def.name.padEnd(10)}  ${def.tier}     ${def.kind.padEnd(10)}  ${String(def.ammo).padStart(4)}  ${f(dealt, 0).padStart(10)}   ${(ttk < 0 ? 'never' : f(ttk) + ' s').padStart(12)}   ${(f(emptied) + ' s').padStart(10)}`);
}
{
  const kills = ALL.filter((id) => !['gust', 'swapper', 'fish', 'reeler', 'snapper', 'popper', 'stinker', 'sentry', 'monologue', 'heckler', 'jethammer', 'rearview'].includes(id)); // (the sentry's kill is tested on its own, above; the MONOLOGUE kills by dropping people, the HECKLER by how loud you are, the JETHAMMER by running into you, the REARVIEW only sends back what others fired) // utility tools are not meant to kill
  // At 150 health a few weapons no longer finish a fresh player on their own: the TWINS (two shells),
  // the grenades (PINEAPPLE, POTATO) and the CLINGER mines. They still take a big chunk.
  const SHORT = ['twins', 'pineapple', 'clinger', 'potato'];
  check('every other damage weapon can kill a full-health player with one pickup', kills.filter((id) => !SHORT.includes(id)).every((id) => ttks[id] >= 0),
    kills.filter((id) => !SHORT.includes(id) && ttks[id] < 0).join(' '));
  const basic = WEAPON_TIERS[0].filter((id) => WEAPONS[id].kind === 'hitscan').map((id) => ttks[id]);
  check('basic guns kill in 0.5-1.5 s at 6 m', basic.every((t) => t >= 0.5 && t <= 1.5), basic.map((t) => f(t)).join(' '));
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
    return HP - r.foe.health;
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
  check('SLUGGER: a wall splat adds heavy damage', open === HP - 55 && wall < HP - 95, `open field hp=${open}, into a wall hp=${wall}`);
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
  check('FISTS: the third hit in a row is an uppercut', hits[0] === 24 && hits[1] === 24 && hits[2] >= 52 && r.foe.vel.y > 6 && r.foe.stun > 0.4,
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

// ------------------------------------------------------- the TIRADE
{
  const def = WEAPONS.tirade;
  const r = range('tirade', 6);
  r.foe.health = 100000; // so it lives through all of it
  r.me.weapons[1] = { type: 'rivet', ammo: 12 };
  step(r, 1, { buttons: BTN.FIRE, pitch: BODY }); // one pull...
  step(r, 30, { pitch: BODY, buttons: BTN.SLOT2 | BTN.THROW | BTN.USE }); // ...let go at once, and try to put it away / throw it
  const firedHalfSecond = r.events.filter((e) => e.t === 'fire' && e.player === 1).length;
  check('TIRADE: one pull and it keeps firing with the trigger released', firedHalfSecond >= 25 && r.me.runawaySlot === 0, `${firedHalfSecond} rounds in the first half second`);
  check('and while it runs it cannot be switched or thrown', r.me.active === 0 && r.me.weapons[0]?.type === 'tirade' && r.me.weapons[1]?.type === 'rivet');
  step(r, 60 * 5, { pitch: BODY });
  const shots = r.events.filter((e) => e.t === 'fire' && e.player === 1);
  const rate = shots.length / ((def.ammo * def.fireInterval));
  check('it fires every round it has, then stops', shots.length === def.ammo && r.me.weapons[0]!.ammo === 0 && r.me.runawaySlot === -1, `${shots.length} rounds`);
  check('VERY fast: over 50 rounds a second', 1 / def.fireInterval > 50 && rate > 0.99, `${f(1 / def.fireInterval, 0)} rounds/s`);
  check('and it shreds what it is pointed at', r.foe.health < 100000 - 600, `dealt ${100000 - r.foe.health}`);
  step(r, 30, {});
  step(r, 1, { buttons: BTN.FIRE });
  check('empty, the next pull throws it like any empty gun', r.me.weapons[0] === null);

  const dies = range('tirade', 6);
  step(dies, 1, { buttons: BTN.FIRE, pitch: BODY });
  step(dies, 20, { pitch: BODY });
  dies.sim.forfeit(1);
  step(dies, 2, {});
  check('dying stops it', dies.me.runawaySlot === -1);
}

// --------------------------------------------------------- the HECKLER
{
  const blast = (loud: number, dist = 5, extra: Solid[] = [], aimYaw = 0) => {
    const r = range('heckler', dist, extra);
    step(r, 2);
    step(r, 1, { buttons: BTN.FIRE, pitch: -0.05, yaw: aimYaw, loud }, {}); // one tick: one pulse (measured before gravity takes the lift back)
    return r;
  };
  const shout = blast(1);
  const shoved = Math.hypot(shout.foe.vel.x, shout.foe.vel.z);
  check('HECKLER: a shout blasts whoever is in front', shoved > 5 && shout.foe.vel.y > 0.5 && shout.foe.health < HP && shout.foe.flungBy === 1
    && shout.events.some((e) => e.t === 'shouted' && e.victim === 2), `shoved ${f(shoved)} m/s, hp ${shout.foe.health}`);
  const whisper = blast(0.1);
  check('a whisper does nothing', Math.hypot(whisper.foe.vel.x, whisper.foe.vel.z) < 0.1 && whisper.foe.health === HP
    && whisper.events.some((e) => e.t === 'shout' && e.power === 0.1));
  const noMic = blast(-1);
  const weak = Math.hypot(noMic.foe.vel.x, noMic.foe.vel.z);
  check('no microphone: a weak pulse, still something', weak > 0.5 && weak < shoved * 0.5, `${f(weak)} vs ${f(shoved)} m/s`);
  const far = blast(1, 15);
  const near = blast(1, 3);
  check('louder up close than far away', Math.hypot(near.foe.vel.x, near.foe.vel.z) > Math.hypot(far.foe.vel.x, far.foe.vel.z) * 1.5);
  const aside = blast(1, 5, [], 1.2); // aimed 70 degrees off to the side
  check('outside the cone: untouched', aside.foe.health === HP && Math.hypot(aside.foe.vel.x, aside.foe.vel.z) < 0.1);
  const behindWall = blast(1, 5, [{ type: 'box', mat: 'concrete', min: v3(-3, 0, -3), max: v3(3, 3, -2.6) }]);
  check('behind a wall: untouched', behindWall.foe.health === HP);
  check('it is not aimable (the second button does nothing)', !canAim(WEAPONS.heckler));

  const drain = range('heckler', 30);
  step(drain, 60, { buttons: BTN.FIRE, loud: 0.5 });
  check('the charge drains while it is on', Math.abs(drain.me.weapons[0]!.ammo - (100 - WEAPONS.heckler.shout!.drain)) < 1, `${f(drain.me.weapons[0]!.ammo, 1)}%`);
  drain.me.weapons[0]!.ammo = 0;
  step(drain, 2, {});
  step(drain, 1, { buttons: BTN.FIRE });
  check('empty, the next pull throws it', drain.me.weapons[0] === null);

  const fall = blast(1);
  fall.foe.pos.y = -30; // ...blown off a ledge
  step(fall, 2, {});
  const k = fall.events.find((e) => e.t === 'kill');
  check('blown into the void: the heckler\'s kill', !!k && k.t === 'kill' && k.killer === 1);
  check('a junk loudness from the network counts as silence', clampLoud('LOUD') === 0 && clampLoud(9) === 1 && clampLoud(-1) === -1 && clampLoud(-5) === 0);
}

// -------------------------------------------------------------- legendary
{
  check('the legendary class: MONOLOGUE, TIRADE, HECKLER, JETHAMMER, REARVIEW, AFTERBURN, rare, the MONOLOGUE at full charge', LEGENDARIES.join() === 'monologue,tirade,heckler,jethammer,rearview,afterburn'
    && LEGENDARY_CHANCE > 0 && LEGENDARY_CHANCE <= 0.4 && WEAPONS.monologue.ammo === 100 && !canAim(WEAPONS.monologue));

  const r = range('monologue', 6);
  step(r, 3, { buttons: BTN.FIRE, pitch: BODY });
  check('MONOLOGUE: the beam grabs the first player it touches', r.foe.heldBy === 1 && r.me.holding === 2
    && r.events.some((e) => e.t === 'beam' && e.kind === 'grab'));
  r.events.length = 0;
  // They try to run and jump; you look up.
  r.foe.weapons[0] = { type: 'rivet', ammo: 12 };
  step(r, 45, { buttons: BTN.FIRE, pitch: 0.5 }, { yaw: Math.PI, moveF: 1, buttons: BTN.JUMP });
  check('the held player floats where you point', r.foe.pos.y > 2.5 && Math.abs(r.foe.pos.z + 5) < 1, `y=${f(r.foe.pos.y)} z=${f(r.foe.pos.z)}`);
  check('and cannot walk or jump their way out', r.foe.heldBy === 1);
  // But they can shoot back.
  for (let k = 0; k < 3; k++) {
    step(r, 1, { buttons: BTN.FIRE, pitch: 0.5 }, { yaw: Math.PI, pitch: -0.5, buttons: BTN.FIRE });
    step(r, 20, { buttons: BTN.FIRE, pitch: 0.5 }, { yaw: Math.PI, pitch: -0.5 });
  }
  check('frozen, they can still aim and shoot', r.events.filter((e) => e.t === 'fire' && e.player === 2).length === 3 && r.foe.weapons[0]!.ammo === 9 && r.foe.heldBy === 1);
  r.events.length = 0;
  check('the beam alone does no harm', r.foe.health === HP, `hp=${r.foe.health}`);
  const charge = r.me.weapons[0]!.ammo;
  const expected = 100 - WEAPONS.monologue.beam!.drain * (48 + 63) / 60; // 48 ticks of beam, then 63 while they shot back
  check('the charge drains while the beam is on', Math.abs(charge - expected) < 1.5, `${f(charge, 1)}% (expected ~${f(expected, 1)}%)`);
  r.me.weapons[0]!.ammo = 100; // topped up for the rest of the tests, so the numbers above can change freely
  // Both buttons: it burns them, and drains twice as fast.
  const hpBefore = r.foe.health, chBefore = r.me.weapons[0]!.ammo;
  step(r, 60, { buttons: BTN.FIRE | BTN.FIRE2, pitch: 0.5 });
  const burnt = hpBefore - r.foe.health, drained = chBefore - r.me.weapons[0]!.ammo;
  check('with the second button too it burns them', burnt >= 4 && burnt <= 6 && r.foe.heldBy === 1 && !r.me.aiming, `-${burnt} hp in 1 s`);
  check('and drains twice as fast', Math.abs(drained - 2 * WEAPONS.monologue.beam!.drain) < 0.5, `${f(drained, 1)}% in 1 s`);
  step(r, 60, { buttons: BTN.FIRE, pitch: 0.5 });
  check('back to the trigger alone: no more burning', r.foe.health === hpBefore - burnt);
  r.me.weapons[0]!.ammo = 100;
  // The wheel pushes them away and pulls them in, within limits.
  const d0 = r.me.holdDist;
  step(r, 1, { buttons: BTN.FIRE, pitch: 0.5, wheel: 2 });
  const d1 = r.me.holdDist;
  step(r, 1, { buttons: BTN.FIRE, pitch: 0.5, wheel: -3 });
  const d2 = r.me.holdDist;
  for (let i = 0; i < 10; i++) step(r, 1, { buttons: BTN.FIRE, pitch: 0.5, wheel: 3 });
  const dMax = r.me.holdDist;
  for (let i = 0; i < 10; i++) step(r, 1, { buttons: BTN.FIRE, pitch: 0.5, wheel: -3 });
  const dMin = r.me.holdDist;
  check('the wheel pushes them away and pulls them in', d1 === d0 + 2 && d2 === d1 - 3 && dMax === WEAPONS.monologue.beam!.maxDist && dMin === WEAPONS.monologue.beam!.minDist,
    `${f(d0)} → ${f(d1)} → ${f(d2)}, limits ${f(dMin)}..${f(dMax)}`);
  check('and while holding someone it does not switch weapons', r.me.active === 0 && r.me.weapons[0]?.type === 'monologue');
  step(r, 1, { buttons: BTN.FIRE, pitch: 0.5, wheel: 3 }); // from the closest (3 m) back out to 6 m, near where they were
  step(r, 40, { buttons: BTN.FIRE, pitch: 0.5 }); // and let them settle
  r.me.weapons[0]!.ammo = 100;
  check('the beam hums as it goes', r.events.filter((e) => e.t === 'fire' && e.player === 1).length >= 2);
  step(r, 30, { buttons: BTN.FIRE, pitch: 0, yaw: Math.PI / 2 });
  check('turn, and they swing round with you', r.foe.pos.x < -4 && Math.abs(r.foe.pos.z) < 1.5, `x=${f(r.foe.pos.x)} z=${f(r.foe.pos.z)}`);
  const before = r.me.weapons[0]!.ammo;
  step(r, 20, { yaw: Math.PI / 2 });
  check('let go of the trigger: they drop', r.foe.heldBy === -1 && r.me.holding === -1 && r.events.some((e) => e.t === 'beam' && e.kind === 'drop'));
  check('and the charge stops draining', r.me.weapons[0]!.ammo === before);
  step(r, 60, { yaw: Math.PI / 2 }, { moveF: 1, yaw: 0 });
  check('then they are free to move again', r.foe.grounded && r.foe.pos.z < -2, `z=${f(r.foe.pos.z)}`);

  // Throwing: swing them round and let go, and they fly off with the swing.
  const fl = range('monologue', 6);
  step(fl, 3, { buttons: BTN.FIRE, pitch: BODY });
  for (let i = 1; i <= 12; i++) step(fl, 1, { buttons: BTN.FIRE, pitch: 0.2, yaw: i * 0.12 }); // a fast turn
  step(fl, 1, { pitch: 0.2, yaw: 12 * 0.12 }); // let go mid-swing
  const thrownAt = Math.hypot(fl.foe.vel.x, fl.foe.vel.z);
  check('swing them and let go: a throw', fl.foe.heldBy === -1 && thrownAt > 18 && thrownAt <= WEAPONS.monologue.beam!.release + 0.01
    && fl.events.some((e) => e.t === 'beam' && e.kind === 'fling'), `${f(thrownAt)} m/s`);
  const calm = range('monologue', 6);
  step(calm, 3, { buttons: BTN.FIRE, pitch: BODY });
  step(calm, 30, { buttons: BTN.FIRE, pitch: 0.2 });
  step(calm, 1, { pitch: 0.2 });
  check('let go while still: they just drop', Math.hypot(calm.foe.vel.x, calm.foe.vel.z) < 2 && calm.events.some((e) => e.t === 'beam' && e.kind === 'drop'));
  const fistsFirst = range('monologue', 6);
  fistsFirst.me.weapons[1] = { type: 'rivet', ammo: 12 };
  step(fistsFirst, 1, { wheel: -1 });
  check('with nobody held, the wheel switches weapons as usual', fistsFirst.me.active === 1);
  fl.foe.pos.y = -30; // ...into the void
  step(fl, 2, { pitch: 0.3 });
  const fell = fl.events.find((e) => e.t === 'kill');
  check('a fall soon after being let go is your kill', !!fell && fell.t === 'kill' && fell.killer === 1 && fell.cause === 'void' && fl.me.kills === 1);

  const late = range('monologue', 6);
  step(late, 3, { buttons: BTN.FIRE, pitch: BODY });
  step(late, 1, {});
  step(late, Math.ceil(WEAPONS.monologue.beam!.credit / DT) + 5, {});
  late.foe.pos.y = -30;
  step(late, 2, {});
  const own = late.events.find((e) => e.t === 'kill');
  check('...but not long after', !!own && own.t === 'kill' && own.killer === -1);

  const carry = range('monologue', 6);
  step(carry, 3, { buttons: BTN.FIRE, pitch: BODY });
  carry.foe.pos.y = -30; // carried out over the void
  step(carry, 2, { buttons: BTN.FIRE, pitch: BODY });
  const dropped = carry.events.find((e) => e.t === 'kill');
  check('carried into the void: your kill', !!dropped && dropped.t === 'kill' && dropped.killer === 1);

  const dies = range('monologue', 6);
  step(dies, 3, { buttons: BTN.FIRE, pitch: BODY });
  dies.sim.forfeit(1);
  step(dies, 1, {});
  check('the holder dies: the beam lets go', dies.foe.heldBy === -1 && dies.me.holding === -1);

  const spent = range('monologue', 6);
  spent.me.weapons[0]!.ammo = 0.1;
  step(spent, 6, { buttons: BTN.FIRE, pitch: BODY });
  check('at 0% the beam dies and lets go', spent.me.weapons[0]!.ammo === 0 && spent.foe.heldBy === -1 && spent.me.beamT === 0);
  step(spent, 1, {});
  step(spent, 1, { buttons: BTN.FIRE });
  check('and the empty gauntlet is thrown like any empty gun', spent.me.weapons[0] === null);

  const wall: Solid = { type: 'box', mat: 'concrete', min: v3(-4, 0, -3.2), max: v3(4, 4, -3) };
  const cut = range('monologue', 2);
  step(cut, 3, { buttons: BTN.FIRE, pitch: -0.3 });
  check('(grabbed up close)', cut.foe.heldBy === 1);
  cut.sim.world = new World([floor, wall], []);
  cut.foe.pos.z = -4; // and now there is a wall in the way
  step(cut, 2, { buttons: BTN.FIRE, pitch: -0.3 });
  check('a wall between you cuts the beam', cut.foe.heldBy === -1, `held by ${cut.foe.heldBy}`);

  const steal = range('monologue', 6);
  const third = steal.sim.addPlayer(3, 'THIRD', 3);
  third.pos = v3(6, 0.01, -6);
  third.weapons[0] = { type: 'monologue', ammo: 100 };
  third.cooldown = [0, 0];
  step(steal, 3, { buttons: BTN.FIRE, pitch: BODY });
  for (let i = 0; i < 3; i++) {
    steal.sim.setInput(1, cmd({ buttons: BTN.FIRE, pitch: BODY }));
    steal.sim.setInput(3, cmd({ buttons: BTN.FIRE, yaw: Math.PI / 2, pitch: -0.05 }));
    steal.sim.step();
  }
  check('another beam can steal who you hold', steal.foe.heldBy === 3 && third.holding === 2 && steal.me.holding === -1, `held by ${steal.foe.heldBy}`);
}

const vcopyP = (v: Vec3 | undefined): Vec3 => (v ? v3(v.x, v.y, v.z) : v3(0, -50, 0));
// ---------------------------------------------------- JETHAMMER, AFTERBURN
{
  const jt = range('jethammer', 30);
  jt.foe.pos.x = 30; // out of the way for now
  step(jt, 1, { buttons: BTN.FIRE });
  step(jt, 60, { buttons: BTN.FIRE });
  const sp = Math.hypot(jt.me.vel.x, jt.me.vel.z);
  check('JETHAMMER: holding the trigger rockets you along your aim', jt.me.jetT > 0.9 && jt.me.pos.z < -25 && Math.abs(jt.me.pos.x) < 0.01, `z=${f(jt.me.pos.z)}`);
  check('faster than anything else in the game', sp >= WEAPONS.jethammer.jet!.speed - 0.01, `${f(sp)} m/s`);
  check('and breaks the sound barrier', jt.events.some((e) => e.t === 'jet' && e.kind === 'boom'));
  check('it never swings: no hits, no kills by itself', !jt.events.some((e) => e.t === 'hit'));
  check('it burns fuel once it is flying', Math.abs(jt.me.weapons[0]!.ammo - (100 - WEAPONS.jethammer.jet!.drain * (61 * DT - WEAPONS.jethammer.jet!.open))) < 1.5, `${f(jt.me.weapons[0]!.ammo, 1)}%`);
  check('about two seconds of fuel in all', Math.abs(100 / WEAPONS.jethammer.jet!.drain - 2) < 0.01);
  step(jt, 2, {});
  check('let go: the rocket stops, you keep flying', jt.me.jetT === 0 && Math.hypot(jt.me.vel.x, jt.me.vel.z) > 40, `${f(Math.hypot(jt.me.vel.x, jt.me.vel.z))} m/s`);

  const opening = range('jethammer', 30);
  opening.foe.pos.x = 30;
  step(opening, Math.floor(WEAPONS.jethammer.jet!.open / DT) - 1, { buttons: BTN.FIRE });
  check('the press opens the compartment first: no flight, no fuel, no roar yet', opening.me.jetT > 0 && opening.me.jetSpeed === 0
    && Math.abs(opening.me.pos.z) < 0.01 && opening.me.weapons[0]!.ammo === 100 && !opening.events.some((e) => e.t === 'fire'));
  step(opening, 3, { buttons: BTN.FIRE });
  check('then the thruster is out and it flies', opening.me.jetSpeed > 0 && opening.me.pos.z < -0.2, `z=${f(opening.me.pos.z)}`);

  const look = range('jethammer', 30);
  look.foe.pos.x = 30;
  step(look, 1 + Math.ceil(WEAPONS.jethammer.jet!.open / DT), { buttons: BTN.FIRE, pitch: 1.2 });
  step(look, 30, { buttons: BTN.FIRE, pitch: 1.2, yaw: 1 });
  check('the line is set when it lights: nearly level, and turning does not steer it',
    Math.abs(look.me.pos.x) < 0.01 && look.me.jetDir.y <= Math.sin(WEAPONS.jethammer.jet!.maxPitch) + 1e-6, `x=${f(look.me.pos.x)}`);

  const hit = range('jethammer', 20);
  step(hit, 1, { buttons: BTN.FIRE });
  step(hit, 50, { buttons: BTN.FIRE });
  const k = hit.events.find((e) => e.t === 'kill');
  check('running into someone kills them outright', !!k && k.t === 'kill' && k.killer === 1 && k.cause === 'jethammer' && hit.me.alive && hit.me.health === HP);
  check('and you carry on through', hit.me.pos.z < -22 && hit.me.jetT > 0, `z=${f(hit.me.pos.z)}`);

  const wall: Solid = { type: 'box', mat: 'concrete', min: v3(-4, 0, -16), max: v3(4, 4, -15) };
  const sp2 = range('jethammer', 30, [wall]);
  sp2.foe.pos.x = 30;
  step(sp2, 1, { buttons: BTN.FIRE });
  step(sp2, 40, { buttons: BTN.FIRE });
  check('a wall: impact damage and a one-second stun', sp2.me.health === HP - WEAPONS.jethammer.jet!.splatDamage && sp2.me.stun > 0.3 && sp2.me.jetT === 0
    && sp2.events.some((e) => e.t === 'jet' && e.kind === 'splat'), `hp=${sp2.me.health} stun=${f(sp2.me.stun)}`);
  check('stopped at the wall, not through it', sp2.me.pos.z > -15, `z=${f(sp2.me.pos.z)}`);
  sp2.events.length = 0;
  step(sp2, 30, { buttons: BTN.FIRE }); // still holding the trigger after the splat
  check('the roar stops with the splat, trigger held or not', !sp2.events.some((e) => e.t === 'fire'));
  step(sp2, 1, {});
  step(sp2, 10, { buttons: BTN.FIRE });
  check('stunned, it will not light again', sp2.me.jetT === 0);

  const step2: Solid = { type: 'box', mat: 'concrete', min: v3(-4, 0, -40), max: v3(4, 0.3, -10) };
  const hop = range('jethammer', 30, [step2]);
  hop.foe.pos.x = 30;
  step(hop, 1, { buttons: BTN.FIRE });
  step(hop, 50, { buttons: BTN.FIRE });
  check('a step is hopped, not a wall', hop.me.jetT > 0 && hop.me.pos.z < -20 && hop.me.pos.y > 0.25, `z=${f(hop.me.pos.z)} y=${f(hop.me.pos.y)}`);

  const ab = range('afterburn', 6);
  const second = ab.sim.addPlayer(3, 'BEHIND', 3);
  second.pos = v3(0, 0.01, -9);
  step(ab, 10, { buttons: BTN.FIRE, pitch: -0.05 });
  check('AFTERBURN: the flame burns everyone down the corridor', ab.foe.health < HP && second.health < HP, `${ab.foe.health} / ${second.health}`);
  const far = range('afterburn', 16);
  step(far, 10, { buttons: BTN.FIRE });
  check('but only a short way', far.foe.health === HP);

  const fly = range('afterburn', 30);
  fly.foe.pos.x = 30;
  step(fly, 1, { buttons: BTN.JUMP });
  step(fly, 60, { buttons: BTN.FIRE, pitch: -1.4 });
  check('pointed down in the air, it is a rocket', fly.me.pos.y > 4, `y=${f(fly.me.pos.y)}`);
  check('one you cannot quite steer', Math.hypot(fly.me.pos.x, fly.me.pos.z) > 0.5, `drift ${f(Math.hypot(fly.me.pos.x, fly.me.pos.z))}`);
  const patches = fly.sim.projectiles.filter((q) => q.kind === 'afterburn').length;
  check('raining fire behind you', patches >= 5, `${patches} patches`);
  const ground = range('afterburn', 30);
  ground.foe.pos.x = 30;
  step(ground, 30, { buttons: BTN.FIRE, pitch: -1.4 });
  check('fired at the floor from standing, it lifts you off (no jump needed)', ground.me.pos.y > 1.5, `y=${f(ground.me.pos.y)}`);
  step(ground, 150, { buttons: BTN.FIRE, pitch: -1.4 });
  let top = 0;
  ground.me.weapons[0]!.ammo = 45;
  for (let i = 0; i < 120; i++) { step(ground, 1, { buttons: BTN.FIRE, pitch: -1.5 }); top = Math.max(top, ground.me.pos.y); ground.me.weapons[0]!.ammo = 45; }
  const cap = WEAPONS.afterburn.torch!.maxLift;
  check(`but no higher than ${cap} m above the ground`, top <= cap + 0.3 && top > cap - 1, `top ${f(top)} m`);
  const fuel = range('afterburn', 30);
  fuel.foe.pos.x = 30;
  let t = 0;
  while (fuel.me.weapons[0] && fuel.me.weapons[0].ammo > 0 && t < 600) { step(fuel, 1, { buttons: BTN.FIRE }); t++; }
  check('three seconds of fuel', Math.abs(t * DT - 3) < 0.1, `${f(t * DT)} s`);

  const burn = range('afterburn', 30);
  burn.foe.pos = v3(0, 0.01, -3);
  step(burn, 1, { buttons: BTN.JUMP });
  step(burn, 20, { buttons: BTN.FIRE, pitch: -1.4 });
  burn.foe.pos = vcopyP(burn.sim.projectiles.find((q) => q.kind === 'afterburn' && q.stuck)?.pos);
  const hpBefore = burn.foe.health;
  step(burn, 60, {});
  check('the patches burn whoever stands in them', burn.foe.health < hpBefore, `${hpBefore} -> ${burn.foe.health}`);
  check('they spare you for a moment (time to fly off them)', burn.me.health === HP);
  const own = range('afterburn', 30);
  own.foe.pos.x = 30;
  own.sim.projectiles.push({ id: 999, kind: 'afterburn', owner: 1, pos: v3(0, 0.02, 0), prevPos: v3(0, 0.02, 0), vel: v3(), life: WEAPONS.afterburn.projectile!.fuse!,
    stuck: true, arm: 0, gen: 0, attached: -1, timer: 0 });
  step(own, Math.floor(FIRE_OWNER_GRACE / DT) - 2, {});
  const early = own.me.health;
  step(own, 40, {});
  check('then they burn you too, like anyone', early === HP && own.me.health < HP, `${early} -> ${own.me.health}`);

  const tank = range('rivet', 6);
  tank.foe.weapons[0] = { type: 'afterburn', ammo: 100 };
  step(tank, 1, { buttons: BTN.FIRE, pitch: BODY }, { yaw: 0 }); // they face away: their back, and the tank, at us
  const boom = tank.events.find((e) => e.t === 'explosion');
  check('one shot in the tank and they explode', !tank.foe.alive && !!boom, `hp=${tank.foe.health}`);
  check('the tank is gone with them', !tank.sim.pickups.some((q) => q.weapon.type === 'afterburn'));
  check('and it is your kill', tank.me.kills === 1 && tank.me.alive);
  const front = range('rivet', 6);
  front.foe.weapons[0] = { type: 'afterburn', ammo: 100 };
  step(front, 1, {}); // let them turn to face us
  step(front, 1, { buttons: BTN.FIRE, pitch: BODY });
  check('from the front it is just a shot', front.foe.alive && front.foe.health === HP - WEAPONS.rivet.damage, `hp=${front.foe.health}`);
  const away = range('rivet', 6);
  away.foe.weapons[0] = { type: 'afterburn', ammo: 100 };
  away.foe.weapons[1] = { type: 'rivet', ammo: 12 };
  away.foe.active = 1;
  step(away, 1, { buttons: BTN.FIRE, pitch: BODY }, { yaw: 0 });
  check('not holding it, there is no tank to hit', away.foe.alive);
}

const vlenP = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
// -------------------------------------------------------------- REARVIEW
{
  const frozen = (r: Range) => r.sim.projectiles.filter((q) => q.frozenBy === 1);
  const LINGER = Math.round(WEAPONS.rearview.mirror!.linger / DT);
  /** Field up, the foe (12 m off, with `gun`) fires once straight at us. */
  const volley = (gun: WeaponId, dist = 12) => {
    const r = range('rearview', dist);
    r.foe.weapons[0] = { type: gun, ammo: WEAPONS[gun].ammo };
    r.foe.cooldown = [0, 0];
    step(r, 2, { buttons: BTN.FIRE });
    step(r, 1, { buttons: BTN.FIRE }, { yaw: Math.PI, buttons: BTN.FIRE });
    return r;
  };

  const m = volley('rivet');
  check('REARVIEW: holding the trigger puts the field up', m.me.mirrorT > 0 && m.me.weapons[0]!.ammo < 100);
  step(m, 5, { buttons: BTN.FIRE });
  const caught = frozen(m);
  check('a bullet hits the glass and sticks there: nobody is hurt', m.me.health === HP && caught.length === 1
    && caught[0].damage === WEAPONS.rivet.damage && vlenP(caught[0].vel) === 0 && caught[0].pos.z < -1 && caught[0].pos.z > -2);
  step(m, LINGER - 8, { buttons: BTN.FIRE });
  check('for half a second', frozen(m).length === 1);
  step(m, 4, { buttons: BTN.FIRE });
  const back = m.sim.projectiles.filter((q) => q.kind === 'rearview');
  check('then it bounces back by itself, slow enough to watch', frozen(m).length === 0 && back.length === 1
    && Math.abs(vlenP(back[0].vel) - WEAPONS.rearview.mirror!.homeSpeed) < 0.01 && WEAPONS.rearview.mirror!.homeSpeed <= 25 && back[0].owner === 1 && back[0].homeOn === 2
    && m.events.some((e) => e.t === 'mirror' && e.kind === 'release'));
  step(m, 60, { buttons: BTN.FIRE });
  check('back at whoever fired it, and the hit is yours', m.foe.health === HP - WEAPONS.rivet.damage
    && m.events.some((e) => e.t === 'hit' && e.attacker === 1 && e.victim === 2 && e.cause === 'rearview'), `hp=${m.foe.health}`);

  const rk = volley('postman', 14);
  step(rk, 25, { buttons: BTN.FIRE }); // it flies in (34 m/s, 12 m)
  const rocket = frozen(rk)[0];
  check('a rocket sticks too, its fuse paused', !!rocket && rocket.kind === 'postman' && rk.me.health === HP);
  const fuse = rocket?.life ?? 0;
  step(rk, LINGER - 5, { buttons: BTN.FIRE });
  check('(still stuck, not a moment older)', !!rocket && rocket.life === fuse && rocket.frozenBy === 1);
  step(rk, 8, { buttons: BTN.FIRE });
  check('then back after its shooter, at the same slow speed', !!rocket && Math.abs(vlenP(rocket.vel) - WEAPONS.rearview.mirror!.homeSpeed) < 0.01 && rocket.owner === 1);
  step(rk, 70, { buttons: BTN.FIRE });
  const blast = rk.events.find((e) => e.t === 'hit' && e.victim === 2);
  check('and it is your rocket now', !!blast && blast.t === 'hit' && blast.attacker === 1 && blast.cause === 'postman' && rk.me.health === HP);

  // They run for it: the round follows them.
  const run = volley('rivet');
  step(run, 4 + LINGER, { buttons: BTN.FIRE });
  run.foe.pos = v3(7, 0.01, -9);
  let curved = 0;
  for (let i = 0; i < 120 && run.foe.health === HP; i++) {
    step(run, 1, {}, { yaw: Math.PI });
    const q = run.sim.projectiles.find((x) => x.kind === 'rearview');
    if (q) curved = Math.max(curved, q.pos.x);
  }
  check('it follows them when they move', run.foe.health < HP && curved > 3, `hp=${run.foe.health}, reached x=${f(curved)}`);

  // They duck behind a wall: the round goes round it, not through it.
  const wall: Solid = { type: 'box', mat: 'concrete', min: v3(-1.5, 0, -8.5), max: v3(1.5, 3, -8) };
  const duck = volley('rivet');
  step(duck, 4 + LINGER - 2, { buttons: BTN.FIRE });
  duck.sim.world = new World([floor, wall], []);
  let wide = 0, over = 0, hitAt = -1;
  for (let i = 0; i < 240 && hitAt < 0; i++) {
    step(duck, 1, {}, { yaw: Math.PI });
    const q = duck.sim.projectiles.find((x) => x.kind === 'rearview');
    if (q) { wide = Math.max(wide, Math.abs(q.pos.x)); over = Math.max(over, q.pos.y); }
    if (duck.foe.health < HP) hitAt = i;
  }
  check('they hide behind a wall: it curves round it to get them', hitAt > 0 && (wide > 1.5 || over > 3), `hit after ${hitAt} ticks, went ${f(wide)} m wide, ${f(over)} m high`);
  check('it never touched the wall on the way', !duck.events.some((e) => e.t === 'impact' && e.pos.z > -8.7 && e.pos.z < -7.8 && Math.abs(e.pos.x) < 1.6));

  const box: Solid[] = [
    { type: 'box', mat: 'concrete', min: v3(-2, 0, -14), max: v3(2, 4, -13.6) },
    { type: 'box', mat: 'concrete', min: v3(-2, 0, -10.4), max: v3(2, 4, -10) },
    { type: 'box', mat: 'concrete', min: v3(-2, 0, -14), max: v3(-1.6, 4, -10) },
    { type: 'box', mat: 'concrete', min: v3(1.6, 0, -14), max: v3(2, 4, -10) },
    { type: 'box', mat: 'concrete', min: v3(-2, 4, -14), max: v3(2, 4.4, -10) },
  ];
  const sealed = volley('rivet');
  step(sealed, 4 + LINGER - 2, { buttons: BTN.FIRE });
  sealed.sim.world = new World([floor, ...box], []);
  step(sealed, 400, {}, { yaw: Math.PI });
  check('shut in on every side, they are safe: it never passes through walls', sealed.foe.health === HP);
  check('and it gives up in the end', !sealed.sim.projectiles.some((q) => q.kind === 'rearview'));

  const down = volley('rivet');
  step(down, 4, { buttons: BTN.FIRE });
  step(down, 2, {}); // field down, the round still on the glass
  check('lowering the field does not drop what is on it', frozen(down).length === 1);
  step(down, LINGER + 60, {});
  check('it bounces back all the same', frozen(down).length === 0 && down.foe.health < HP);

  const mine = range('rearview', 12);
  mine.sim.projectiles.push({ id: 900, kind: 'postman', owner: 1, pos: v3(0, 1.62, 0.5), prevPos: v3(0, 1.62, 0.5), vel: v3(0, 0, -34),
    life: 5, stuck: false, arm: 0, gen: 0, attached: -1, timer: 0 });
  step(mine, 3, { buttons: BTN.FIRE });
  check('your own shots pass through your field', frozen(mine).length === 0);
  check('about four and a half seconds of charge', Math.abs(100 / WEAPONS.rearview.mirror!.drain - 4.5) < 0.1);

  const dies = volley('rivet');
  step(dies, 4, { buttons: BTN.FIRE });
  dies.sim.forfeit(1);
  step(dies, 2, {});
  check('its holder dies: what was on the glass just drops', dies.sim.projectiles.every((q) => (q.frozenBy ?? -1) < 0));
  check('it never hurts anyone by itself', !canAim(WEAPONS.rearview) && WEAPONS.rearview.damage === 0);
}

// ------------------------------------------------------- practice range
{
  // The turret dummy lives in a walled yard: trying weapons at the rack, nobody gets shot.
  const sim = new GameSim(buildTestMap(), 3, RULES_PRACTICE);
  const me = sim.addPlayer(1, 'ME', 1);
  /** Hits taken standing at (x, z) for a while (the range respawns you, so count hits, not health). */
  const at = (x: number, z: number, ticks: number) => {
    let hits = 0;
    for (let i = 0; i < ticks; i++) {
      me.pos = v3(x, 0.01, z);
      sim.setInput(1, cmd({ yaw: 0 }));
      sim.step();
      hits += sim.events.filter((e) => e.t === 'hit' && e.victim === 1).length;
      sim.events.length = 0;
    }
    return hits;
  };
  const rack = at(19, 25.5, 600) + at(10, 28.5, 300) + at(0, 22, 300) + at(22, 15, 300);
  check('the practice turret never shoots anyone at the rack or out in the range', rack === 0, `${rack} hits`);
  const yard = at(21.5, 24, 600);
  check('but it does shoot whoever walks into its yard', yard > 0, `${yard} hits`);
}

// ------------------------------------------------------- health and regeneration
{
  check('everyone has 150 health', PLAYER.maxHealth === 150 && range(null, 6).foe.health === 150);
  const r = range(null, 6);
  r.foe.health = 60;
  const T = (s: number) => Math.round(s / DT);
  step(r, T(PLAYER.regenDelay - 0.2), {}, { yaw: Math.PI });
  check('standing still: nothing for the first three seconds', r.foe.health === 60, `hp=${f(r.foe.health)}`);
  step(r, T(2.2), {}, { yaw: Math.PI });
  check('then health slowly comes back (5 HP a second)', r.foe.health > 68 && r.foe.health < 72, `hp=${f(r.foe.health)}`);
  step(r, T(40), {}, { yaw: Math.PI });
  check('all the way back to full, and no further', r.foe.health === PLAYER.maxHealth);

  const mv = range(null, 6);
  mv.foe.health = 60;
  step(mv, T(4), {}, { yaw: Math.PI, moveR: 0.5 }); // walk about (not off the edge of the test floor)
  check('moving: no regeneration', mv.foe.health === 60);
  step(mv, T(2), {}, { yaw: Math.PI }); // stopped, but only for two seconds
  check('and stopping restarts the wait', mv.foe.health === 60);

  const hit = range('rivet', 6);
  hit.foe.health = 60;
  step(hit, T(2.5), { pitch: BODY }, { yaw: Math.PI });
  pull(hit, { pitch: BODY }, { yaw: Math.PI }); // shot just before the wait was over
  const after = hit.foe.health;
  step(hit, T(2.5), { pitch: BODY }, { yaw: Math.PI });
  check('getting hurt restarts the wait too', after === 60 - WEAPONS.rivet.damage && hit.foe.health === after, `hp=${f(hit.foe.health)}`);
}

// ------------------------------------------------------- melee specials (right click)
{
  const R = BTN.FIRE2;
  // FISTS: guard. The foe shoots us from the front, then from behind.
  const g = range(null, 6);
  g.foe.weapons[0] = { type: 'rivet', ammo: 12 };
  g.foe.cooldown = [0, 0];
  step(g, 2, { buttons: R });
  step(g, 1, { buttons: R }, { yaw: Math.PI, pitch: BODY, buttons: BTN.FIRE });
  check('FISTS guard: a hit from the front does a quarter', g.me.health === HP - Math.round(WEAPONS.rivet.damage * 0.25), `hp=${g.me.health}`);
  const gb = range(null, 6);
  gb.foe.weapons[0] = { type: 'rivet', ammo: 12 };
  gb.foe.cooldown = [0, 0];
  step(gb, 2, { buttons: R, yaw: Math.PI }); // guarding, but facing away
  step(gb, 1, { buttons: R, yaw: Math.PI }, { yaw: Math.PI, pitch: BODY, buttons: BTN.FIRE });
  check('but not from behind', gb.me.health === HP - WEAPONS.rivet.damage, `hp=${gb.me.health}`);
  const gs = range(null, 30);
  step(gs, 60, { buttons: R, moveF: 1 });
  const guarded = -gs.me.pos.z;
  const gw = range(null, 30);
  step(gw, 60, { moveF: 1 });
  check('guarding, you shuffle', guarded < -gw.me.pos.z * 0.7, `${f(guarded)} m vs ${f(-gw.me.pos.z)} m`);
  const gp = range(null, 1.6);
  step(gp, 20, { buttons: R | BTN.FIRE });
  check('and cannot punch', gp.foe.health === HP);

  // SHIV: lunge.
  const l = range('shiv', 7);
  step(l, 1, { buttons: R });
  step(l, 20, {});
  check('SHIV lunge: a dash that stabs the first in the way', l.foe.health < HP - 55 && l.foe.health > HP - 75 && l.me.pos.z < -4 && l.foe.bleed > 0,
    `hp=${l.foe.health} z=${f(l.me.pos.z)}`);
  check('it costs one use', l.me.weapons[0]!.ammo === WEAPONS.shiv.ammo - 1);
  step(l, 1, { buttons: R });
  step(l, 5, {});
  check('and has a cooldown', l.me.specialCd > 1 && l.events.filter((e) => e.t === 'special' && e.kind === 'lunge').length === 1);
  const lb = range('shiv', 7);
  step(lb, 1, { buttons: R }, { yaw: 0 }); // they face away
  step(lb, 20, {}, { yaw: 0 });
  check('into someone\'s back: a kill', !lb.foe.alive);
  const lm = range('shiv', 30);
  lm.foe.pos.x = 30;
  step(lm, 1, { buttons: R });
  step(lm, 30, {});
  check('a miss just carries you about 8 m', lm.me.pos.z < -6 && lm.me.pos.z > -11, `z=${f(lm.me.pos.z)}`);
  const ld = range('shiv', 7);
  ld.me.weapons[1] = { type: 'shiv', ammo: 20 };
  step(ld, 1, { buttons: R, pitch: BODY });
  check('two knives: right click is the right hand, no lunge', ld.me.specialT === 0 && Math.abs(ld.me.pos.z) < 0.1);

  // SLUGGER: home run.
  const hr = range('slugger', 2);
  step(hr, 60, { buttons: R, pitch: -0.45 }); // at the chest (the head would be worth 30% more)
  step(hr, 2, { pitch: -0.45 });
  check('SLUGGER home run: wound up fully, 110 and a huge launch', hr.foe.health === HP - 110 && Math.hypot(hr.foe.vel.x, hr.foe.vel.z) > 20,
    `hp=${hr.foe.health} v=${f(Math.hypot(hr.foe.vel.x, hr.foe.vel.z))}`);
  const tap = range('slugger', 2);
  step(tap, 2, { buttons: R, pitch: BODY * 2 });
  step(tap, 2, { pitch: BODY * 2 });
  check('a quick tap is just a normal swing', tap.foe.health > HP - 60 && tap.foe.health < HP - 50, `hp=${tap.foe.health}`);

  // BANHAMMER: slam.
  const sl = range('banhammer', 3.5);
  const ammo = sl.me.weapons[0]!.ammo;
  step(sl, 1, { buttons: R });
  let up = 0;
  for (let i = 0; i < 120; i++) { step(sl, 1, {}); up = Math.max(up, sl.me.pos.y); }
  const shock = sl.events.find((e) => e.t === 'special' && e.kind === 'slam' && e.power === 1);
  check('BANHAMMER slam: a leap, then a shockwave on landing', up > 1 && !!shock && sl.foe.health < HP - 35 && sl.foe.health > HP - 71 && sl.me.health === HP,
    `rose ${f(up)} m, hp=${sl.foe.health}`);
  check('it throws them up and away, and costs none of its three swings', sl.events.some((e) => e.t === 'hit' && e.victim === 2) && sl.me.weapons[0]!.ammo === ammo);

  // FISH: splash.
  const sp = range('fish', 5);
  const side = sp.sim.addPlayer(3, 'SIDE', 3);
  side.pos = v3(6, 0.01, 0);
  step(sp, 2, { buttons: R });
  check('FISH splash: soaked, shoved and dazed, not hurt', sp.foe.soaked > 3 && sp.foe.stun > 0.5 && Math.hypot(sp.foe.vel.x, sp.foe.vel.z) > 5 && sp.foe.health === HP,
    `soak=${f(sp.foe.soaked)} v=${f(Math.hypot(sp.foe.vel.x, sp.foe.vel.z))}`);
  check('only in front of you', side.soaked === 0);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('weapon tests failed');
