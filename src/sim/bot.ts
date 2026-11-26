import { BOTS, BOT_SKILL, type BotLevel, type BotSkill } from '../config/bots';
import { DT, PLAYER } from '../config/game';
import { MOVE } from '../config/movement';
import { WEAPONS, type WeaponDef } from '../config/weapons';
import { Rng } from '../core/rng';
import { v3, vcopy, vset, type Vec3 } from '../core/vec';
import type { MapDef } from './map';
import { EDGE, navFor, type NavPoint } from './nav';
import { HULL } from './pmove';
import { BTN, type InputCmd, type Pickup, type Player, type Zone } from './types';
import type { World } from './world';

// Battle bots. A bot is an ordinary player whose InputCmds come from here
// instead of from a keyboard: it moves with pmove, fires with the same
// weapon code and picks things up the same way, so it can do nothing a
// person could not (EXTERMINATION's damage multipliers aside, see
// config/bots.ts). Only the host runs it, inside GameSim.step.
//
// Each tick it:
//   1. looks for enemies (in sight, within its field of view, or whoever just hurt it)
//   2. sorts out its weapons (swap to a loaded one, throw away what it cannot use)
//   3. picks somewhere to go: into the zone, to a weapon, at its enemy, or hunting
//   4. turns towards its aim point, no faster than its turn rate, with a wobble that settles
//   5. fires once it has had time to react and the aim is on
//   6. steers round walls, ledges and lava with a few short traces
//
// To get anywhere it cannot simply walk straight to (round a wall, up to
// another level) it follows a path over the map's navigation grid (sim/nav.ts),
// looking where it is going. Walking itself is steered locally: the way it
// wants, or if that runs off an edge, into lava or into a wall, the nearest way
// that does not. A bot that stays stuck anyway wanders off for a moment.

/** What a bot needs to see of the simulation. GameSim has all of it. */
export interface BotView {
  tick: number;
  players: Player[];
  pickups: Pickup[];
  world: World;
  zone: Zone | null;
  map: MapDef;
}

/** A bot's own memory, kept on its Player between ticks. */
export interface BotBrain {
  level: BotLevel;
  skill: BotSkill;
  rng: Rng;
  target: number; // id of the enemy it is after, or -1
  seenT: number; // s the target has been in sight without a break
  lostT: number; // s since it last saw them
  lastSeen: Vec3 | null; // where they were then
  errYaw: number; // how far off its aim is right now (radians)...
  errPitch: number;
  wobYaw: number; // ...drifting towards this, re-rolled every wobT s (skill.aimFloor): a hand is never quite steady
  wobPitch: number;
  wobT: number;
  aimPt: Vec3 | null; // where it is aiming: follows the target at skill.track, so someone moving is hard to keep up with
  burstT: number; // s it has been firing in this burst (skill.burst)...
  restT: number; // ...and s left of the pause after it
  tapT: number; // s before it can pull a semi-automatic's trigger again (skill.tap)
  path: NavPoint[] | null; // the way to pathTo over the navigation grid (null: there is none)...
  pathI: number; // ...the point on it it is heading for...
  pathT: number; // ...s until it is worked out again...
  pathTo: Vec3 | null; // ...and where it leads
  hurtBy: number; // who hit it last, and how long ago (s): it turns on them
  hurtT: number;
  strafeDir: number; // 1 or -1
  strafeT: number; // s until it changes direction
  goalPickup: number; // id of the weapon it is walking to, or -1
  goalT: number; // s spent walking to it
  ignore: Map<number, number>; // pickup id -> s left before it tries that one again
  detourYaw: number; // a heading it follows for detourT s after getting stuck
  detourT: number;
  stuckFrom: Vec3; // where it was when the stuck check last started
  lastSafe: Vec3; // where it last stood on safe ground: in the air over nothing, it steers back there
  side: number; // 1 or -1: which way it goes round something in its way, kept until the way is clear (see steer)
  navT: number; // s left of picking its way round something: no strafing or hopping about meanwhile
  sideT: number; // s spent going round by `side` without a clear way: past BOTS.sideGiveUp it tries the other side
  stuckT: number;
  fireHeld: boolean; // last tick's triggers (left / only, right), to pull semi-automatics again
  fire2Held: boolean;
  aimHead: boolean; // going for the head (rolled now and then, by skill.headshots)
}

export function makeBrain(level: BotLevel, seed: number): BotBrain {
  return {
    level, skill: BOT_SKILL[level], rng: new Rng(seed),
    target: -1, seenT: 0, lostT: 0, lastSeen: null, errYaw: 0, errPitch: 0, wobYaw: 0, wobPitch: 0, wobT: 0, aimPt: null, burstT: 0, restT: 0, tapT: 0, path: null, pathI: 0, pathT: 0, pathTo: null, hurtBy: -1, hurtT: 0,
    strafeDir: 1, strafeT: 0, goalPickup: -1, goalT: 0, ignore: new Map(),
    detourYaw: 0, detourT: 0, stuckFrom: v3(), lastSafe: v3(), side: 1, navT: 0, sideT: 0, stuckT: 0, fireHeld: false, fire2Held: false, aimHead: false,
  };
}

/** Someone hurt the bot: it flinches (its aim is thrown off), and it will turn on them even if they are behind it. */
export function botHurt(b: BotBrain, attacker: number): void {
  b.errYaw += b.rng.range(-1, 1) * b.skill.flinch;
  b.errPitch += b.rng.range(-0.5, 0.5) * b.skill.flinch;
  if (attacker < 0) return;
  b.hurtBy = attacker;
  b.hurtT = 0;
}

/**
 * Weapons a bot knows how to use: guns, launchers and melee. Not the
 * beam, megaphone, mirror, KI BLAST, rocket hammer or traps (they need
 * tricks it does not have), and never vehicles.
 */
export function botCanUse(def: WeaponDef): boolean {
  return def.category !== 'vehicle' && def.category !== 'trap'
    && !def.beam && !def.shout && !def.mirror && !def.ki && !def.jet;
}

const PITCH_MAX = 1.45;
/** The box swept to look for walls: a player's width, knee to above the head of a low step. Shorter than a player, so low ceilings do not count as walls. */
const PROBE_MAX = v3(PLAYER.radius, 1.2, PLAYER.radius);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const eyeOf = (p: Player) => v3(p.pos.x, p.pos.y + (p.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), p.pos.z);
/** yaw that looks along (dx, dz): forward is (-sin yaw, -cos yaw). */
const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** The weapon in its hands (the left one while dual wielding), or null for fists. */
function held(p: Player): WeaponDef | null {
  const w = p.weapons[p.active];
  return w ? WEAPONS[w.type] : null;
}

/**
 * How far a weapon reaches. Hitscan and melee say so (`range`); a projectile
 * goes as far as it flies before its fuse runs out, up to 60 m.
 */
export function botReach(def: WeaponDef | null): number {
  if (!def) return WEAPONS.fists.range + 0.6;
  if (def.kind === 'melee') return def.range + 0.6;
  if (def.kind === 'projectile' && def.projectile) return Math.min(60, def.projectile.speed * (def.projectile.fuse ?? 6));
  return def.range;
}

/** What a launcher fires, or null: hitscan weapons can carry a `projectile` too (AFTERBURN's burning patches), which is not what they shoot. */
const shell = (def: WeaponDef | null) => (def?.kind === 'projectile' && def.projectile?.speed ? def.projectile : null);

/** A trigger that is simply held down: automatics, spin-up and runaway guns, while they have ammo. */
const holdable = (def: WeaponDef, ammo: number) => (def.auto || !!def.spinUp || !!def.runaway) && ammo > 0;

function dualOf(p: Player): boolean {
  const a = p.weapons[0], b = p.weapons[1];
  return !!a && !!b && WEAPONS[a.type].hands === 1 && WEAPONS[b.type].hands === 1;
}

/** A clear line from the eyes to a point. */
function canSee(v: BotView, from: Vec3, to: Vec3): boolean {
  return v.world.traceRay(from, to).fraction >= 0.999;
}

/**
 * Is it safe to stand at (x, z), coming from height y? Ground within reach
 * below, above the void, and nothing deadly within a body's width of it
 * (touching lava or spikes is enough to die).
 */
function safeGround(v: BotView, x: number, y: number, z: number): boolean {
  const tr = v.world.traceRay(v3(x, y + 1, z), v3(x, y - BOTS.maxDrop, z));
  if (tr.startSolid) return true; // inside a wall: the wall check deals with it
  if (tr.fraction >= 1 || tr.surface === 'deadly' || tr.end.y < v.map.killY + 1) return false;
  return !v.world.deadly.length || !v.world.touchesDeadly(tr.end, HULL.mins, HULL.stand, BOTS.hazardMargin);
}

export function botThink(v: BotView, p: Player, b: BotBrain): InputCmd {
  const s = b.skill, rng = b.rng;
  const cmd: InputCmd = { seq: v.tick, buttons: 0, moveF: 0, moveR: 0, yaw: p.yaw, pitch: p.pitch };
  const eye = eyeOf(p);
  b.hurtT += DT;
  for (const [id, t] of b.ignore) if ((t - DT) <= 0) b.ignore.delete(id); else b.ignore.set(id, t - DT);

  // ---- 1. enemies
  let target: Player | null = null, targetSeen = false;
  let best = Infinity;
  for (const o of v.players) {
    if (o === p || !o.alive || o.bot) continue;
    const c = v3(o.pos.x, o.pos.y + 1.1, o.pos.z);
    const dx = c.x - eye.x, dy = c.y - eye.y, dz = c.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    const known = o.id === b.target || (o.id === b.hurtBy && b.hurtT < 2);
    if (d > s.sight && !known) continue;
    const off = Math.abs(wrap(yawTo(dx, dz) - p.yaw));
    if (off > s.fov && !known) continue;
    if (!canSee(v, eye, c) && !canSee(v, eye, eyeOf(o))) continue;
    // Closest first; the one it is already fighting, or that is shooting it, counts as nearer.
    const score = d - (o.id === b.target ? 8 : 0) - (o.id === b.hurtBy && b.hurtT < 2 ? 6 : 0);
    if (score < best) { best = score; target = o; targetSeen = true; }
  }
  if (target) {
    if (target.id !== b.target) {
      // A new enemy: the first look at them is a rough one.
      b.target = target.id;
      b.seenT = 0;
      b.errYaw = rng.range(-1, 1) * s.aimError;
      b.errPitch = rng.range(-0.5, 0.5) * s.aimError;
      b.aimHead = rng.next() < s.headshots;
      b.aimPt = null; // it starts tracking them from scratch
      b.burstT = 0;
    }
    b.seenT += DT;
    b.lostT = 0;
    b.lastSeen = vcopy(target.pos);
  } else if (b.target >= 0) {
    b.seenT = 0;
    b.lostT += DT;
    const t = v.players.find((o) => o.id === b.target);
    if (!t || !t.alive || b.lostT > s.memory) { b.target = -1; b.lastSeen = null; }
    else target = t; // out of sight, but it still goes after them
  }

  // ---- 2. weapons
  const dual = dualOf(p);
  let def = held(p);
  const loaded = (slot: number) => { const w = p.weapons[slot]; return !!w && w.ammo > 0 && botCanUse(WEAPONS[w.type]); };
  if (!dual && p.runawaySlot < 0) {
    const cur = p.weapons[p.active];
    if (cur && !botCanUse(WEAPONS[cur.type])) {
      // Something it cannot use: away with it (at the enemy, if there is one in front of it).
      if (!(p.prevButtons & BTN.THROW)) cmd.buttons |= BTN.THROW;
    } else if (!loaded(p.active) && loaded(p.active ^ 1) && !(p.prevButtons & BTN.SWAP)) {
      cmd.buttons |= BTN.SWAP;
    } else if (cur && cur.ammo <= 0 && !targetSeen && !(p.prevButtons & BTN.THROW)) {
      cmd.buttons |= BTN.THROW; // empty: free the hand (in a fight it is thrown at them by pulling the trigger)
    }
    def = held(p);
  }
  const armed = loaded(0) || loaded(1);
  const freeHand = !p.weapons[0] || !p.weapons[1];

  // ---- 3. where to go
  let goal: Vec3 | null = null;
  let wantDist = 0; // stop this far from the goal (fighting at range)
  let fighting = false;
  const zone = v.zone;
  const zoneD = zone ? Math.hypot(p.pos.x - zone.x, p.pos.z - zone.z) : 0;
  if (zone && zoneD > zone.radius - BOTS.zoneMargin) {
    goal = v3(zone.x, p.pos.y, zone.z);
  }
  if (!goal) {
    // A weapon: anywhere in reach when it has none, only close ones (and a free hand) when it has.
    const range = armed ? (freeHand && !targetSeen ? BOTS.nearPickup * 2 : BOTS.nearPickup) : BOTS.pickupRange;
    let pick: Pickup | null = null, pd = range;
    for (const k of v.pickups) {
      if (k.lethal || k.weapon.ammo <= 0 || !botCanUse(WEAPONS[k.weapon.type]) || b.ignore.has(k.id)) continue;
      if (k.owner === p.id && k.ownerTimer > 0) continue;
      if (armed && !freeHand) continue;
      if (zone && Math.hypot(k.pos.x - zone.x, k.pos.z - zone.z) > zone.radius - BOTS.zoneMargin) continue;
      const d = Math.hypot(k.pos.x - p.pos.x, k.pos.z - p.pos.z) + Math.abs(k.pos.y - p.pos.y) * 2;
      if (d < pd) { pd = d; pick = k; }
    }
    // One it has no way to reach is left alone for a while.
    if (pick && pick.id !== b.goalPickup && !navFor(v.map).path(p.pos, pick.pos)) { b.ignore.set(pick.id, BOTS.pickupGiveUp); pick = null; }
    if (pick) {
      if (pick.id !== b.goalPickup) { b.goalPickup = pick.id; b.goalT = 0; }
      if ((b.goalT += DT) > BOTS.pickupTimeout) { b.ignore.set(pick.id, BOTS.pickupGiveUp); b.goalPickup = -1; }
      else goal = pick.pos;
    } else b.goalPickup = -1;
  }
  if (!goal && target) {
    fighting = targetSeen;
    goal = targetSeen ? target.pos : b.lastSeen ?? target.pos;
    if (targetSeen) {
      const melee = !def || def.kind === 'melee';
      // Close in with melee; with a gun, a fair distance; with explosives, well clear of the blast.
      const splash = shell(def)?.splashRadius ?? 0;
      wantDist = melee ? 0 : Math.min(14, Math.max(4, splash * 2.5, botReach(def) * 0.4));
    }
  }
  if (!goal) {
    // Nobody in sight: head for the nearest enemy (footsteps and gunfire give them away).
    let nd = Infinity;
    for (const o of v.players) {
      if (o === p || !o.alive || o.bot) continue;
      const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
      if (d < nd) { nd = d; goal = o.pos; }
    }
    wantDist = 3;
  }

  // ---- 3b. the way there
  // Straight at it when fighting someone in sight who is about straight ahead
  // (that is where it strafes); otherwise along a path. No path at all: a fight
  // is fought from where it stands; anything else, it makes for the middle.
  let way: Vec3 | null = goal;
  let direct = false;
  let leap = false;
  if (goal) {
    const nav = navFor(v.map);
    if ((b.pathT -= DT) <= 0 || !b.pathTo || Math.hypot(goal.x - b.pathTo.x, goal.y - b.pathTo.y, goal.z - b.pathTo.z) > 1.5) {
      b.path = nav.path(p.pos, goal);
      if (!b.path && !fighting) b.path = nav.path(p.pos, v3(zone?.x ?? 0, p.pos.y, zone?.z ?? 0));
      b.pathI = 0;
      b.pathT = rng.range(0.4, 0.7);
      b.pathTo = vcopy(goal);
    }
    const path = b.path;
    if (fighting) {
      const straight = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
      direct = !path || (path.every((n) => n.kind === EDGE.walk) && pathLength(p.pos, path) <= straight * 1.4 + 2);
    }
    if (!direct && path) {
      // Past the points it has reached...
      while (b.pathI < path.length) {
        const n = path[b.pathI], dy = p.pos.y - n.y;
        if (Math.hypot(n.x - p.pos.x, n.z - p.pos.z) < 0.55 && dy > -0.6 && dy < 1) b.pathI++;
        else break;
      }
      // ...and cutting corners: the furthest of the next few it can walk straight to.
      if (p.grounded && b.pathI < path.length && path[b.pathI].kind === EDGE.walk) {
        let last = b.pathI; // (only over plain walking: never past a jump, a pad or a ride)
        while (last < path.length - 1 && last < b.pathI + 3 && path[last + 1].kind === EDGE.walk) last++;
        for (let j = last; j > b.pathI; j--) {
          if (nav.straight(p.pos, path[j])) { b.pathI = j; break; }
        }
      }
      way = b.pathI < path.length ? path[b.pathI] : goal;
      // A jump across a gap or off a pad: it commits, instead of shying away from the edge.
      const k = b.pathI < path.length ? path[b.pathI].kind : EDGE.walk;
      leap = k === EDGE.leap || k === EDGE.pad;
      if (b.pathI < path.length) wantDist = 0;
    } else if (!direct && !fighting) {
      direct = true; // no way there at all: the old straight line, for want of better
    }
  }

  // ---- 4. aim
  let aimYaw = p.yaw, aimPitch = 0, aimDist = Infinity;
  if (target && targetSeen) {
    const head = b.aimHead ? 1.55 : 1.1; // head or chest
    let tx = target.pos.x, ty = target.pos.y + (target.crouched ? head * 0.6 : head), tz = target.pos.z;
    const d = Math.hypot(tx - eye.x, ty - eye.y, tz - eye.z);
    // Lead a moving target: by the projectile's flight time, or a little for hitscan (its own reaction lag).
    const sh = shell(def);
    const flight = sh ? d / sh.speed : 0.05;
    tx += target.vel.x * flight * s.lead;
    tz += target.vel.z * flight * s.lead;
    ty += target.vel.y * flight * s.lead * 0.5;
    // Lobbed shots fall: aim above by how far they drop on the way.
    if (sh?.gravity) ty += 0.5 * sh.gravity * flight * flight;
    // Its aim follows that point with a lag (skill.track): it catches someone
    // standing still, but trails behind someone strafing. Moving is the defence.
    if (!b.aimPt) b.aimPt = v3(tx, ty, tz);
    const f = 1 - Math.exp(-s.track * DT);
    b.aimPt.x += (tx - b.aimPt.x) * f; b.aimPt.y += (ty - b.aimPt.y) * f; b.aimPt.z += (tz - b.aimPt.z) * f;
    const dx = b.aimPt.x - eye.x, dy = b.aimPt.y - eye.y, dz = b.aimPt.z - eye.z;
    aimYaw = yawTo(dx, dz);
    aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
    aimDist = d;
    // The first look is rough and settles (skill.aimSettle), but only onto a
    // wobble that keeps wandering (skill.aimFloor): it never goes perfectly still.
    if ((b.wobT -= DT) <= 0) {
      b.wobYaw = rng.range(-1, 1) * s.aimFloor;
      b.wobPitch = rng.range(-0.5, 0.5) * s.aimFloor;
      b.wobT = rng.range(0.25, 0.6);
    }
    const k = Math.exp(-s.aimSettle * DT);
    b.errYaw = b.errYaw * k + b.wobYaw * (1 - k);
    b.errPitch = b.errPitch * k + b.wobPitch * (1 - k);
    b.errYaw = Math.max(-s.aimError, Math.min(s.aimError, b.errYaw));
    b.errPitch = Math.max(-s.aimError, Math.min(s.aimError, b.errPitch));
  } else if (way) {
    // Nobody in sight: it looks where it is going (never at someone through a wall).
    const dx = way.x - p.pos.x, dz = way.z - p.pos.z;
    if (Math.hypot(dx, dz) > 0.5) aimYaw = yawTo(dx, dz);
  }
  const wantYaw = aimYaw + (targetSeen ? b.errYaw : 0);
  const wantPitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, aimPitch + (targetSeen ? b.errPitch : 0)));
  const step = s.turnRate * DT;
  const dyaw = wrap(wantYaw - p.yaw);
  cmd.yaw = p.yaw + Math.max(-step, Math.min(step, dyaw));
  cmd.pitch = p.pitch + Math.max(-step, Math.min(step, wantPitch - p.pitch));

  // ---- 5. fire
  b.tapT -= DT;
  // Between bursts it stops shooting for a moment (skill.burst), as a person does to re-aim.
  const resting = b.restT > 0;
  if (resting) b.restT -= DT;
  if (target && targetSeen && b.seenT >= s.reaction && !resting) {
    const melee = !def || def.kind === 'melee';
    const reach = botReach(def);
    // Too close for its own explosives: the other weapon, if it has one loaded; otherwise hold fire (it is backing off).
    const splash = shell(def)?.splashRadius ?? 0;
    const tooClose = !dual && splash > 0 && aimDist < splash + 0.8;
    if (tooClose && loaded(p.active ^ 1) && !(p.prevButtons & BTN.SWAP)) cmd.buttons |= BTN.SWAP;
    // On target: the view is within about a body's width of them (more forgiving for spread and splash).
    const slack = (def?.spread ?? 0) * Math.PI / 180 + (shell(def)?.splashRadius ? 0.08 : 0);
    const tol = Math.atan2(0.45, Math.max(aimDist, 0.5)) * 1.5 + slack + (melee ? 0.4 : 0);
    const off = Math.hypot(wrap(cmd.yaw - aimYaw), cmd.pitch - aimPitch);
    if (!tooClose && aimDist <= reach && off <= tol + Math.hypot(b.errYaw, b.errPitch)) {
      // Automatics are held; a semi-automatic (or an empty gun, to throw it) needs
      // the trigger let go in between, and a finger is only so quick (skill.tap).
      let tapped = false;
      const pull = (d: WeaponDef, ammo: number, was: boolean) => {
        if (holdable(d, ammo)) return true;
        if (was || b.tapT > 0) return false;
        tapped = true;
        return true;
      };
      if (dual) {
        // One trigger per hand, each pulled the way its own weapon needs.
        const l = p.weapons[0]!, r = p.weapons[1]!;
        if (pull(WEAPONS[l.type], l.ammo, b.fireHeld)) cmd.buttons |= BTN.FIRE;
        if (pull(WEAPONS[r.type], r.ammo, b.fire2Held)) cmd.buttons |= BTN.FIRE2;
      } else {
        const w = p.weapons[p.active];
        if (pull(def ?? WEAPONS.fists, w ? w.ammo : 1, b.fireHeld)) cmd.buttons |= BTN.FIRE;
        if (s.aims && !melee && def && aimDist > 12) cmd.buttons |= BTN.FIRE2; // down the sights
      }
      if (tapped) b.tapT = s.tap;
      if (!melee && (b.burstT += DT) > s.burst[0]) {
        b.burstT = 0;
        b.restT = rng.range(0.7, 1.3) * s.burst[1];
      }
    } else if (def?.spinUp && aimDist <= reach * 1.2) {
      cmd.buttons |= BTN.FIRE; // keep the barrels turning
    }
  }
  b.fireHeld = (cmd.buttons & BTN.FIRE) !== 0;
  b.fire2Held = dual && (cmd.buttons & BTN.FIRE2) !== 0;

  // ---- 6. move
  let mx = 0, mz = 0;
  if (way) {
    const dx = way.x - p.pos.x, dz = way.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    // Following a path it goes right up to each point; going straight at something, it stops at its distance.
    const stop = direct ? wantDist + 1.5 : 0.25;
    if (d > stop) { mx = dx / d; mz = dz / d; }
    else if (direct && fighting && wantDist > 0 && d < wantDist - 2) { mx = -dx / d; mz = -dz / d; } // too close: back off
    if (direct && fighting && b.navT <= 0) {
      // Strafe across their line of fire (not while picking a way round something: that is how it ends up in the lava).
      if ((b.strafeT -= DT) <= 0) { b.strafeDir = rng.next() < 0.5 ? -1 : 1; b.strafeT = rng.range(s.strafe[0], s.strafe[1]); b.aimHead = rng.next() < s.headshots; }
      if (d > 0.1) { mx += (-dz / d) * b.strafeDir * 0.8; mz += (dx / d) * b.strafeDir * 0.8; }
    }
  }
  if (b.detourT > 0) {
    b.detourT -= DT;
    mx = -Math.sin(b.detourYaw); mz = -Math.cos(b.detourYaw);
  }
  const ml = Math.hypot(mx, mz);
  if (ml > 0.01) {
    mx /= ml; mz /= ml;
    // On a path, the next point is known to be safe ground: no need to look past it.
    const upTo = way && !direct && b.detourT <= 0 ? Math.hypot(way.x - p.pos.x, way.z - p.pos.z) : Infinity;
    const dir = steer(v, p, b, mx, mz, leap, upTo);
    if (dir) {
      mx = dir.x; mz = dir.z;
      if (dir.jump) cmd.buttons |= BTN.JUMP;
      if (dir.turned) b.navT = 0.6;
    } else { mx = 0; mz = 0; }
    // Into the player's own frame: forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw).
    const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
    cmd.moveF = -sy * mx - cy * mz;
    cmd.moveR = cy * mx - sy * mz;
    const big = Math.max(Math.abs(cmd.moveF), Math.abs(cmd.moveR));
    if (big > 0) { cmd.moveF /= big; cmd.moveR /= big; }
  }

  // Movement tricks: hop about in a fight, bunny hop when travelling, slide when fast.
  // A hop is only taken where it lands on safe ground.
  const hopOk = () => safeGround(v, p.pos.x + p.vel.x * 0.75, p.pos.y, p.pos.z + p.vel.z * 0.75);
  b.navT -= DT;
  if (p.grounded && (mx || mz) && b.navT <= 0) {
    if (rng.next() < s.hops * DT * (fighting ? 1.5 : 0.6) && hopOk()) cmd.buttons |= BTN.JUMP;
    if (!fighting && s.hops > 0.8 && !goalClose(p, goal) && hopOk()) cmd.buttons |= BTN.JUMP;
    if (Math.hypot(p.vel.x, p.vel.z) > MOVE.slideMinSpeed && rng.next() < s.slides * DT * 2) cmd.buttons |= BTN.CROUCH;
  }

  // Stuck: barely moved in a second while trying to go somewhere. Off a random way for a moment, with a jump.
  if ((b.stuckT += DT) >= 1) {
    const moved = Math.hypot(p.pos.x - b.stuckFrom.x, p.pos.z - b.stuckFrom.z);
    if (moved < 0.6 && ml > 0.01 && b.detourT <= 0) {
      b.detourYaw = rng.range(-Math.PI, Math.PI);
      b.detourT = rng.range(0.6, 1.2);
      if (hopOk()) cmd.buttons |= BTN.JUMP;
    }
    b.stuckT = 0;
    b.stuckFrom = vcopy(p.pos);
  }
  return cmd;
}

/** Metres along a path, from `from`. */
function pathLength(from: Vec3, path: Vec3[]): number {
  let len = 0, a = from;
  for (const n of path) { len += Math.hypot(n.x - a.x, n.z - a.z); a = n; }
  return len;
}

const goalClose = (p: Player, goal: Vec3 | null) => !goal || Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z) < 6;

/**
 * Rotations tried, in order, when the straight way is blocked: straight on,
 * then round by the side it is already going round by (times `side`), all the
 * way to turning back, then the other side. Keeping to one side is what gets
 * it along a wall or a lava pool and round the end instead of dithering; if
 * that side leads nowhere for long enough (BOTS.sideGiveUp) it tries the other.
 */
const TURNS = [0, 0.5, 1, 1.5, 2, 2.5, 3, -0.5, -1, -1.5, -2, -2.5, -3];

/**
 * The way to walk: (dx, dz) itself if it is safe, otherwise the nearest
 * heading that is. Safe = ground ahead (no drop into the void, no lava) and
 * no wall it cannot hop. `jump`: there is a low wall to hop onto. Null: every
 * way is bad, so it stands still.
 */
function steer(v: BotView, p: Player, b: BotBrain, dx: number, dz: number, leap = false, upTo = Infinity): { x: number; z: number; jump: boolean; turned: boolean } | null {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  if (leap) {
    // Jumping a gap (or off a pad): straight at the far side; on the ground, jump at the edge.
    if (!p.grounded) return { x: dx, z: dz, jump: false, turned: false };
    vset(b.lastSafe, p.pos);
    const edge = !safeGround(v, p.pos.x + dx * 0.6, p.pos.y, p.pos.z + dz * 0.6);
    return { x: dx, z: dz, jump: edge, turned: false };
  }
  if (!p.grounded) {
    // In the air (a jump, a pad, knocked flying): keep steering where it wants
    // while that still comes down on safe ground; let go of the keys if only
    // where it is drifting anyway is safe; over nothing safe, steer back to
    // where it last stood.
    const k = 0.35, ax = p.pos.x + p.vel.x * k, az = p.pos.z + p.vel.z * k;
    if (safeGround(v, ax + dx, p.pos.y, az + dz)) return { x: dx, z: dz, jump: false, turned: false };
    if (safeGround(v, ax, p.pos.y, az)) return null;
    const bx = b.lastSafe.x - p.pos.x, bz = b.lastSafe.z - p.pos.z, bl = Math.hypot(bx, bz) || 1;
    return { x: bx / bl, z: bz / bl, jump: false, turned: true };
  }
  vset(b.lastSafe, p.pos);
  if ((b.sideT += DT) > BOTS.sideGiveUp) { b.side = -b.side; b.sideT = 0; }
  const base = Math.atan2(dx, dz);
  // Look further ahead the faster it goes: it needs room to stop.
  const look = Math.max(1, speed * 0.2); // m
  for (const turn of TURNS) {
    const t = turn * b.side;
    const a = base + t;
    const x = Math.sin(a), z = Math.cos(a);
    // The ground a step and two steps ahead (straight on, never past where it is heading: that is safe).
    const l1 = t === 0 ? Math.min(look, upTo) : look, l2 = t === 0 ? Math.min(look * 2, upTo) : look * 2;
    if (!safeGround(v, p.pos.x + x * l1, p.pos.y, p.pos.z + z * l1)) continue;
    if (!safeGround(v, p.pos.x + x * l2, p.pos.y, p.pos.z + z * l2)) continue;
    // A wall in the way at knee height? Hop it if it is low, else try another way.
    const from = v3(p.pos.x, p.pos.y + MOVE.stepHeight + 0.05, p.pos.z);
    const wall = v.world.traceBox(from, v3(from.x + x * 0.7, from.y, from.z + z * 0.7), HULL.mins, PROBE_MAX);
    if (wall.fraction < 1 && wall.normal.y < 0.6) {
      const hi = v3(p.pos.x, p.pos.y + 1.25, p.pos.z);
      const over = v.world.traceBox(hi, v3(hi.x + x * 0.7, hi.y, hi.z + z * 0.7), HULL.mins, PROBE_MAX);
      if (over.fraction >= 1) return { x, z, jump: true, turned: turn !== 0 };
      continue;
    }
    if (turn < 0) { b.side = -b.side; b.sideT = 0; } // that whole side was blocked: go round the other way from now on
    if (turn === 0) b.sideT = 0;
    return { x, z, jump: false, turned: turn !== 0 };
  }
  return null;
}
