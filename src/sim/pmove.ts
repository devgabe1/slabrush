import { MOVE } from '../config/movement';
import { PLAYER } from '../config/game';
import { v3, vadd, vcopy, vcross, vdot, vlen, vma, vnorm, vset, type Vec3 } from '../core/vec';
import { BTN, type InputCmd, type Player } from './types';
import type { Brush, World } from './world';

// Player movement. A pure function of (player state, input, world, tick): the
// host runs it for everyone, and each client re-runs it on its own inputs for
// client-side prediction. Keep it free of side effects. Everything the map
// can do to a player's movement (moving platforms, conveyors, jump pads,
// teleporters, low gravity) lives here so that prediction covers it too.

/** Bit flags returned by pmove so the caller can emit events. */
export const MV_JUMP = 1;
export const MV_LAND = 2;
export const MV_WALLJUMP = 4;
export const MV_SLIDE = 8;
export const MV_PAD = 16;
export const MV_TELE = 32;
export const MV_CRUSH = 64; // squashed by a moving brush: the sim kills the player

const MINS = v3(-PLAYER.radius, 0, -PLAYER.radius);
const STAND_MAXS = v3(PLAYER.radius, PLAYER.height, PLAYER.radius);
const CROUCH_MAXS = v3(PLAYER.radius, PLAYER.crouchHeight, PLAYER.radius);
const OVERCLIP = 1.001;
const TELEPORT_COOLDOWN = 0.8;
/** brush under the player's feet, set by groundCheck */
let groundBrush: Brush | null = null;

export function pmove(p: Player, cmd: InputCmd, world: World, dt: number, tick: number): number {
  let ev = 0;
  const vel = p.vel;
  p.yaw = cmd.yaw;
  p.pitch = cmd.pitch;
  p.slideBoostTimer = Math.max(0, p.slideBoostTimer - dt);
  p.wallJumpTimer = Math.max(0, p.wallJumpTimer - dt);
  p.teleTimer = Math.max(0, p.teleTimer - dt);
  p.launchTimer = Math.max(0, p.launchTimer - dt);
  p.rooted = Math.max(0, p.rooted - dt);

  // Movers have just advanced to this tick: ride along, get pushed, or get crushed.
  world.setTick(tick);
  if (world.movers.length && followMovers(p, world, p.crouched ? CROUCH_MAXS : STAND_MAXS)) ev |= MV_CRUSH;

  // --- crouch (stand up only if there is head room) ---
  // CROUCH (Shift) crouches and slides when fast; DUCK (Ctrl) only crouches.
  if (cmd.buttons & (BTN.CROUCH | BTN.DUCK)) p.crouched = true;
  else if (p.crouched && !world.traceBox(p.pos, p.pos, MINS, STAND_MAXS).startSolid) p.crouched = false;
  const maxs = p.crouched ? CROUCH_MAXS : STAND_MAXS;

  groundCheck(p, world, maxs);
  p.groundTime = p.grounded ? p.groundTime + dt : 0;

  // --- wish direction from input, relative to view yaw ---
  const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
  let wx = -sy * cmd.moveF + cy * cmd.moveR;
  let wz = -cy * cmd.moveF - sy * cmd.moveR;
  let wishScale = Math.hypot(wx, wz);
  if (wishScale > 1e-6) { wx /= wishScale; wz /= wishScale; }
  if (wishScale > 1) wishScale = 1;
  const wishdir = v3(wx, 0, wz);
  // Caught in a trap: feet stay where they are (you can still look, shoot and crouch).
  const rooted = p.rooted > 0;
  if (rooted) { wishScale = 0; vel.x = 0; vel.z = 0; }

  // --- jump / wall jump ---
  const jumpHeld = (cmd.buttons & BTN.JUMP) !== 0 && !rooted;
  const jumpEdge = jumpHeld && !(p.prevButtons & BTN.JUMP);
  if (p.grounded && (MOVE.autoHop ? jumpHeld : jumpEdge)) {
    // Jumping happens BEFORE friction is applied this tick: that is what
    // preserves momentum across consecutive hops (bunny hopping).
    vel.y = Math.max(vel.y, 0) + MOVE.jumpSpeed;
    // A hop (jumping straight out of a landing) is rewarded with a little extra speed.
    if (p.groundTime <= MOVE.hopWindow) {
      const hs = Math.hypot(vel.x, vel.z), cap = MOVE.runSpeed * MOVE.hopSpeedCap;
      if (hs > 1 && hs < cap) {
        const k = Math.min(cap, hs + MOVE.hopBoost) / hs;
        vel.x *= k; vel.z *= k;
      }
    }
    // Jumping off a moving platform keeps its momentum, so a hop on the spot
    // lands back on it instead of watching it drive away underneath you.
    const ride = groundBrush?.mover ? groundBrush.delta : null;
    if (ride) {
      vel.x += ride.x / dt;
      vel.z += ride.z / dt;
      if (ride.y > 0) vel.y += ride.y / dt;
    }
    p.grounded = false;
    p.sliding = false;
    ev |= MV_JUMP;
  } else if (!p.grounded && jumpEdge && p.wallJumpsLeft > 0 && p.wallJumpTimer <= 0) {
    const n = findWall(p, world, maxs);
    if (n) {
      const nl = Math.hypot(n.x, n.z) || 1;
      const nx = n.x / nl, nz = n.z / nl;
      const into = vel.x * nx + vel.z * nz;
      if (into < 0) { vel.x -= nx * into; vel.z -= nz * into; } // cancel speed going into the wall
      vel.x += nx * MOVE.wallJumpPush;
      vel.z += nz * MOVE.wallJumpPush;
      vel.y = MOVE.wallJumpUp;
      p.wallJumpsLeft--;
      p.wallJumpTimer = MOVE.wallJumpCooldown;
      ev |= MV_WALLJUMP;
    }
  }

  const startedGrounded = p.grounded;
  const startBrush = groundBrush;

  if (p.grounded) {
    const hs = Math.hypot(vel.x, vel.z);
    // --- slide state ---
    const slideKey = (cmd.buttons & BTN.CROUCH) !== 0;
    if (p.crouched && slideKey && !p.sliding && hs >= MOVE.slideMinSpeed) {
      p.sliding = true;
      ev |= MV_SLIDE;
      if (p.slideBoostTimer <= 0) {
        const k = (hs + MOVE.slideBoost) / hs;
        vel.x *= k; vel.z *= k;
        p.slideBoostTimer = MOVE.slideBoostCooldown;
      }
    }
    if (p.sliding && (!p.crouched || !slideKey || hs < MOVE.slideEndSpeed)) p.sliding = false;

    // --- friction ---
    const ice = p.groundSurface === 'ice' || p.soaked > 0; // drenched by the FISH: same skid as ice
    const fr = p.sliding ? MOVE.slideFriction : ice ? MOVE.iceFriction : MOVE.groundFriction;
    const sp = vlen(vel);
    if (sp > 1e-6) {
      // Slides lose speed at a constant rate; walking uses Quake friction.
      const drop = p.sliding ? fr * dt : Math.max(sp, MOVE.stopSpeed) * fr * dt;
      const ns = Math.max(0, sp - drop) / sp;
      vel.x *= ns; vel.y *= ns; vel.z *= ns;
    }

    // --- acceleration ---
    if (p.sliding) {
      // Steering only (air-style), plus gravity projected onto the slope so
      // sliding downhill speeds you up and uphill slows you down.
      accelerate(vel, wishdir, MOVE.runSpeed * wishScale, MOVE.slideSteerAccel, MOVE.airWishSpeedCap, dt);
      const n = p.groundNormal;
      const g = MOVE.gravity * MOVE.slideSlopeGravity * dt;
      vel.x += n.x * n.y * g;
      vel.y += (n.y * n.y - 1) * g;
      vel.z += n.z * n.y * g;
    } else {
      let max = p.crouched ? MOVE.crouchSpeed : cmd.buttons & BTN.WALK ? MOVE.walkSpeed : MOVE.runSpeed;
      if (p.stun > 0) max *= MOVE.stunSpeedScale;
      accelerate(vel, wishdir, max * wishScale, ice ? MOVE.iceAccel : MOVE.groundAccel, Infinity, dt);
    }

    // Keep velocity on the ground plane without losing speed on slopes.
    const before = vlen(vel);
    clipVelocity(vel, p.groundNormal, vel);
    const after = vlen(vel);
    if (after > 1e-6) { const k = before / after; vel.x *= k; vel.y *= k; vel.z *= k; }

    if (vlen(vel) > 1e-4) stepSlideMove(world, p, maxs, dt, p.groundNormal);
    // Stick to the ground when going down stairs and slopes.
    const dn = vcopy(p.pos);
    dn.y -= MOVE.stepHeight;
    const snap = world.traceBox(p.pos, dn, MINS, maxs);
    if (!snap.startSolid && snap.fraction < 1 && snap.normal.y >= MOVE.minGroundNormalY) vset(p.pos, snap.end);
    // Conveyor belts drag whatever stands on them (and still collide with walls).
    const push = startBrush?.push;
    if (push) vset(p.pos, world.traceBox(p.pos, vma(p.pos, push, dt), MINS, maxs).end);
  } else {
    accelerate(vel, wishdir, MOVE.runSpeed * wishScale, MOVE.airAccel, MOVE.airWishSpeedCap, dt);
    // Air control: turn the trajectory towards the held direction.
    // (Not for a moment after a jump pad: the arc it throws you on stays
    // intact until you are most of the way there.)
    if (MOVE.airTurnRate > 0 && wishScale > 0 && p.launchTimer <= 0) {
      const sp = Math.hypot(vel.x, vel.z);
      if (sp > 0.5) {
        // signed angle from the current heading to the wanted one
        const cross = vel.x * wishdir.z - vel.z * wishdir.x, dotp = vel.x * wishdir.x + vel.z * wishdir.z;
        const angle = Math.atan2(cross, dotp);
        if (Math.abs(angle) > 2.2) {
          // pulling back against the movement: brake rather than swing all the way round
          const k = Math.max(0, sp - MOVE.airBrake * wishScale * dt) / sp;
          vel.x *= k; vel.z *= k;
        } else {
          const step = Math.sign(angle) * Math.min(Math.abs(angle), MOVE.airTurnRate * wishScale * dt);
          const c = Math.cos(step), sn = Math.sin(step);
          const x = vel.x * c - vel.z * sn, z = vel.x * sn + vel.z * c;
          vel.x = x; vel.z = z;
        }
      }
      // Below run speed the keys also accelerate, up to run speed and no further.
      const before = Math.hypot(vel.x, vel.z);
      if (before < MOVE.runSpeed) {
        accelerate(vel, wishdir, MOVE.runSpeed * wishScale, MOVE.airControlAccel, Infinity, dt);
        const after = Math.hypot(vel.x, vel.z);
        if (after > MOVE.runSpeed) { const k = MOVE.runSpeed / after; vel.x *= k; vel.z *= k; }
      }
    }
    vel.y -= MOVE.gravity * gravityScale(p, world, maxs) * dt;
    stepSlideMove(world, p, maxs, dt, null);
  }

  // --- triggers ---
  for (const t of world.triggers) {
    if (t.type === 'lowgrav' || !touches(p, maxs, t.min, t.max)) continue;
    if (t.type === 'jumppad') {
      if (vel.y < t.vel.y * 0.6) { // not already on the way up from this pad
        // A trampoline: a fixed bounce up, and onwards the way YOU were moving, a
        // little faster (never slower than you came in). Standing still: straight up.
        // A pad that leads up to high ground keeps the stronger throw it needs to get there.
        const hs = Math.hypot(vel.x, vel.z);
        if (hs > 0.5) {
          const want = Math.max(hs, Math.min(hs + MOVE.padBoost, MOVE.padMaxSpeed));
          vel.x *= want / hs; vel.z *= want / hs;
        } else {
          vel.x = 0; vel.z = 0;
        }
        vel.y = Math.max(MOVE.padBounce, t.vel.y);
        p.launchTimer = MOVE.padSteerLock;
        p.grounded = false;
        p.sliding = false;
        ev |= MV_PAD;
      }
    } else if (t.type === 'teleporter' && p.teleTimer <= 0) {
      vset(p.pos, t.dest); // velocity and view direction are kept
      p.teleTimer = TELEPORT_COOLDOWN; // so the exit pad does not send us straight back
      ev |= MV_TELE;
    }
  }

  // --- landing ---
  const vyBefore = vel.y;
  groundCheck(p, world, maxs);
  if (p.grounded) {
    if (!startedGrounded) {
      ev |= MV_LAND;
      p.landSpeed = -vyBefore;
      // Landing on a slope redirects fall speed along it (down-slopes give speed).
      clipVelocity(vel, p.groundNormal, vel);
    }
    p.wallJumpsLeft = MOVE.wallJumpMax;
  } else {
    p.sliding = false;
  }

  const s = vlen(vel);
  if (s > MOVE.maxSpeed) { const k = MOVE.maxSpeed / s; vel.x *= k; vel.y *= k; vel.z *= k; }
  return ev;
}

/**
 * Quake acceleration. `cap` limits the wish speed used for the "how much more
 * can I add" test only — on the ground it is infinite, in the air it is tiny,
 * which is the entire trick behind air strafing.
 */
function accelerate(vel: Vec3, wishdir: Vec3, wishspeed: number, accel: number, cap: number, dt: number): void {
  if (wishspeed <= 0) return;
  const add = Math.min(wishspeed, cap) - vdot(vel, wishdir);
  if (add <= 0) return;
  const a = Math.min(accel * wishspeed * dt, add);
  vel.x += wishdir.x * a;
  vel.z += wishdir.z * a;
}

function groundCheck(p: Player, world: World, maxs: Vec3): void {
  const dn = vcopy(p.pos);
  dn.y -= 0.06;
  const tr = world.traceBox(p.pos, dn, MINS, maxs);
  // Not grounded if nothing is below, the surface is too steep, or we are
  // being launched away from it (jump, explosion knockback, ramp kick).
  if (tr.fraction === 1 || tr.normal.y < MOVE.minGroundNormalY || (p.vel.y > 0 && vdot(p.vel, tr.normal) > 0.5)) {
    p.grounded = false;
    groundBrush = null;
    return;
  }
  p.grounded = true;
  groundBrush = tr.brush;
  vset(p.groundNormal, tr.normal);
  p.groundSurface = tr.surface;
}

function touches(p: Player, maxs: Vec3, lo: Vec3, hi: Vec3): boolean {
  return p.pos.x + maxs.x > lo.x && p.pos.x + MINS.x < hi.x
    && p.pos.y + maxs.y > lo.y && p.pos.y < hi.y
    && p.pos.z + maxs.z > lo.z && p.pos.z + MINS.z < hi.z;
}

function gravityScale(p: Player, world: World, maxs: Vec3): number {
  for (const t of world.triggers) if (t.type === 'lowgrav' && touches(p, maxs, t.min, t.max)) return t.scale;
  return 1;
}

/**
 * React to brushes that moved this tick. Returns true if the player is
 * crushed (wedged between a mover and something that will not give way).
 *  1. Riding: if we were standing on a mover before it moved, move with it.
 *     The test is done in the mover's own frame, so it needs no memory of
 *     the previous tick — which keeps prediction replays exact.
 *  2. Pushing: if a mover now overlaps us, slide out along its direction.
 */
function followMovers(p: Player, world: World, maxs: Vec3): boolean {
  for (const b of world.movers) {
    const d = b.delta;
    if (d.x === 0 && d.y === 0 && d.z === 0) continue;
    const s = v3(p.pos.x + d.x, p.pos.y + d.y + 0.004, p.pos.z + d.z);
    const tr = world.traceBrush(b, s, v3(s.x, s.y - 0.09, s.z), MINS, maxs);
    if (!tr.startSolid && tr.fraction < 1 && tr.normal.y >= MOVE.minGroundNormalY) {
      const to = vadd(p.pos, d);
      const mv = world.traceBox(p.pos, to, MINS, maxs);
      vset(p.pos, mv.startSolid ? to : mv.end); // startSolid: the platform rose into our feet, go with it
      break;
    }
  }

  const stuck = world.traceBox(p.pos, p.pos, MINS, maxs);
  if (!stuck.startSolid || !stuck.brush?.mover) return false;
  const d = stuck.brush.delta;
  const len = vlen(d);
  const tryAt = (q: Vec3): boolean => {
    if (world.traceBox(q, q, MINS, maxs).startSolid) return false;
    vset(p.pos, q);
    return true;
  };
  if (len > 0) {
    for (let i = 0; i <= 12; i++) if (tryAt(vma(p.pos, d, (len + 0.01 + i * 0.05) / len))) return false;
  }
  for (let i = 1; i <= 10; i++) if (tryAt(v3(p.pos.x, p.pos.y + i * 0.05, p.pos.z))) return false;
  return true;
}

/** Look for a near-vertical surface right next to the player. */
function findWall(p: Player, world: World, maxs: Vec3): Vec3 | null {
  let best: Vec3 | null = null;
  let bestF = 1;
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const end = v3(p.pos.x + Math.cos(a) * MOVE.wallDetectDist, p.pos.y, p.pos.z + Math.sin(a) * MOVE.wallDetectDist);
    const tr = world.traceBox(p.pos, end, MINS, maxs);
    if (tr.fraction < bestF && Math.abs(tr.normal.y) < 0.3 && !tr.allSolid) {
      bestF = tr.fraction;
      best = tr.normal;
    }
  }
  return best;
}

function clipVelocity(v: Vec3, n: Vec3, out: Vec3): void {
  let backoff = vdot(v, n);
  if (backoff < 0) backoff *= OVERCLIP;
  else backoff /= OVERCLIP;
  const x = v.x - n.x * backoff, y = v.y - n.y * backoff, z = v.z - n.z * backoff;
  out.x = x; out.y = y; out.z = z;
}

/**
 * Move and slide along whatever is hit (up to 4 surfaces per tick). Handles
 * creases between two planes and stops dead in true corners instead of
 * jittering. Returns true if anything was hit.
 */
function slideMove(world: World, pos: Vec3, vel: Vec3, maxs: Vec3, dt: number, ground: Vec3 | null): boolean {
  const planes: Vec3[] = [];
  if (ground) planes.push(ground);
  let timeLeft = dt;
  let bumped = false;
  const cv = v3();

  for (let bump = 0; bump < 4; bump++) {
    const tr = world.traceBox(pos, vma(pos, vel, timeLeft), MINS, maxs);
    if (tr.allSolid) { vel.y = 0; return true; }
    if (tr.fraction > 0) vset(pos, tr.end);
    if (tr.fraction === 1) break;
    bumped = true;
    timeLeft -= timeLeft * tr.fraction;
    if (planes.length >= 6) { vel.x = vel.y = vel.z = 0; return true; }

    // Hit the same plane again (float error): nudge away from it.
    let same = false;
    for (const pl of planes) {
      if (vdot(tr.normal, pl) > 0.99) {
        vel.x += tr.normal.x * 0.03; vel.y += tr.normal.y * 0.03; vel.z += tr.normal.z * 0.03;
        same = true;
        break;
      }
    }
    if (same) continue;
    planes.push(vcopy(tr.normal));

    for (let i = 0; i < planes.length; i++) {
      if (vdot(vel, planes[i]) >= 0.001) continue; // not moving into this plane
      clipVelocity(vel, planes[i], cv);
      for (let j = 0; j < planes.length; j++) {
        if (j === i || vdot(cv, planes[j]) >= 0.001) continue;
        clipVelocity(cv, planes[j], cv);
        if (vdot(cv, planes[i]) >= 0) continue;
        // Wedged between two planes: slide along the crease.
        const dir = vnorm(vcross(planes[i], planes[j]));
        const d = vdot(dir, vel);
        cv.x = dir.x * d; cv.y = dir.y * d; cv.z = dir.z * d;
        for (let k = 0; k < planes.length; k++) {
          if (k === i || k === j || vdot(cv, planes[k]) >= 0.001) continue;
          vel.x = vel.y = vel.z = 0; // three planes: a real corner, stop
          return true;
        }
      }
      vset(vel, cv);
      break;
    }
  }
  return bumped;
}

/** slideMove, plus automatic climbing of ledges up to MOVE.stepHeight (stairs). */
function stepSlideMove(world: World, p: Player, maxs: Vec3, dt: number, ground: Vec3 | null): void {
  const startPos = vcopy(p.pos);
  const startVel = vcopy(p.vel);
  if (!slideMove(world, p.pos, p.vel, maxs, dt, ground)) return;

  const down = vcopy(startPos);
  down.y -= MOVE.stepHeight;
  let tr = world.traceBox(startPos, down, MINS, maxs);
  // Never step up while rising through the air.
  if (startVel.y > 0 && (tr.fraction === 1 || tr.normal.y < MOVE.minGroundNormalY)) return;

  const flatPos = vcopy(p.pos);
  const flatVel = vcopy(p.vel);
  const revert = () => { vset(p.pos, flatPos); vset(p.vel, flatVel); };

  const up = vcopy(startPos);
  up.y += MOVE.stepHeight;
  tr = world.traceBox(startPos, up, MINS, maxs);
  if (tr.allSolid) return;
  const stepSize = tr.end.y - startPos.y;

  vset(p.pos, tr.end);
  vset(p.vel, startVel);
  slideMove(world, p.pos, p.vel, maxs, dt, ground);

  const dn = vcopy(p.pos);
  dn.y -= stepSize;
  tr = world.traceBox(p.pos, dn, MINS, maxs);
  if (!tr.allSolid) vset(p.pos, tr.end);
  if (tr.fraction < 1) {
    if (tr.normal.y < MOVE.minGroundNormalY) { revert(); return; } // would land on something too steep
    clipVelocity(p.vel, tr.normal, p.vel);
  }

  // Keep the stepped result only if it actually got us further.
  const dFlat = Math.hypot(flatPos.x - startPos.x, flatPos.z - startPos.z);
  const dStep = Math.hypot(p.pos.x - startPos.x, p.pos.z - startPos.z);
  if (dStep <= dFlat + 1e-5) revert();
}
