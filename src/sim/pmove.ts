import { MOVE } from '../config/movement';
import { WEAPONS } from '../config/weapons';
import { BIKE, BROOM, PLAYER } from '../config/game';
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
export const MV_SPLAT = 128; // JETHAMMER: drove into a wall (the sim deals the damage)
export const MV_BOOM = 256; // JETHAMMER: just went past the speed of sound
export const MV_SPECIAL = 512; // a melee special went off this tick (a lunge started, a wind-up let go, a splash)
export const MV_SLAM = 1024; // BANHAMMER: came down from the leap
export const MV_WALLRUN = 2048; // started running along a wall this tick

const MINS = v3(-PLAYER.radius, 0, -PLAYER.radius);
const STAND_MAXS = v3(PLAYER.radius, PLAYER.height, PLAYER.radius);
const CROUCH_MAXS = v3(PLAYER.radius, PLAYER.crouchHeight, PLAYER.radius);
/** The player's collision box: feet centre at the origin. */
export const HULL = { mins: MINS, stand: STAND_MAXS, crouch: CROUCH_MAXS } as const;
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

  // --- JETHAMMER: while the rocket burns, nothing else about moving applies ---
  ev |= specialControl(p, cmd, dt);
  // --- SKYSWEEPER: riding a broom, you fly ---
  if (p.broomT > 0) return ev | broomMove(p, cmd, world, dt);
  p.broomGlide = Math.max(0, p.broomGlide - dt);
  // --- SLABRIDER: riding a bike, the fuel burns; jump is the wheelie, not a jump; no crouching ---
  const bike = p.bikeT > 0;
  if (bike) {
    p.bikeT = Math.max(0, p.bikeT - dt);
    p.wheelie = (cmd.buttons & BTN.JUMP) !== 0 && p.bikeT > 0;
    cmd = { ...cmd, buttons: cmd.buttons & ~(BTN.JUMP | BTN.CROUCH | BTN.DUCK | BTN.WALK) };
    p.wallRunning = false;
  } else p.wheelie = false;
  // Thrown off a wheelie: tumbling, rolling on, no say in where you go.
  const tumbling = p.tumbleT > 0;
  if (tumbling) {
    p.tumbleT = Math.max(0, p.tumbleT - dt);
    cmd = { ...cmd, moveF: 0, moveR: 0, buttons: cmd.buttons & ~(BTN.JUMP | BTN.CROUCH | BTN.DUCK | BTN.WALK) };
  }
  const jet = jetControl(p, cmd, dt);
  if (jet) return ev | jetMove(p, world, dt, jet);

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
      // The kick carries you off the wall: a moment before the keys steer again (so in a
      // narrow shaft it takes you across to the other wall, for the next wall jump).
      p.launchTimer = Math.max(p.launchTimer, MOVE.wallJumpCarry);
      p.wallRunning = false; // jumping off a wall run ends it
      p.wallRunCd = MOVE.wallRunCooldown;
      ev |= MV_WALLJUMP;
    }
  }

  // AFTERBURN pointed at the floor: it lifts you off (the thrust itself is applied in the air, below).
  if (p.grounded && torchFlying(p, cmd)) {
    p.grounded = false;
    p.sliding = false;
    if (vel.y < 1) vel.y = 1;
  }

  const startedGrounded = p.grounded;
  const startBrush = groundBrush;

  if (p.grounded) {
    if (bike) bikeDrive(p, cmd, dt);
    else {
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
      const fr = (p.sliding ? MOVE.slideFriction : ice ? MOVE.iceFriction : MOVE.groundFriction) * (tumbling ? 0.3 : 1); // tumbling: rolling on
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
        const sp = specialIn(p);
        if (sp?.kind === 'guard' && p.specialT > 0) max *= sp.slow; // fists up: shuffling
        const kw = p.weapons[p.active];
        const ki = kw && kw.ammo > 0 ? WEAPONS[kw.type].ki : undefined;
        if (ki && (cmd.buttons & BTN.FIRE)) max *= ki.slow; // gathering a KI BLAST: barely walking
        accelerate(vel, wishdir, max * wishScale, ice ? MOVE.iceAccel : MOVE.groundAccel, Infinity, dt);
      }

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
    // Running along a wall? Decided first: while you do, the keys must not
    // steer your speed into the wall (it would just be lost).
    if (!bike && !tumbling && wallRun(p, world, maxs, wishdir, wishScale, dt)) ev |= MV_WALLRUN;
    // Thrown somewhere you did not choose (a REELER line): no air control until it is over.
    if (!bike && p.launchTimer <= 0 && !p.wallRunning) accelerate(vel, wishdir, MOVE.runSpeed * wishScale, MOVE.airAccel, MOVE.airWishSpeedCap, dt);
    // Air control: turn the trajectory towards the held direction.
    // (Not for a moment after a jump pad: the arc it throws you on stays
    // intact until you are most of the way there; nor while sliding down a wall.)
    if (!bike && MOVE.airTurnRate > 0 && wishScale > 0 && p.launchTimer <= 0 && !p.wallRunning) { // (a bike in the air just flies on)
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
    // On a wall, gravity comes back gradually over the run: a gentle arc.
    const runK = p.wallRunning ? MOVE.wallRunGravity + (1 - MOVE.wallRunGravity) * (p.wallRunT / MOVE.wallRunTime) ** 2 : 1;
    vel.y -= MOVE.gravity * gravityScale(p, world, maxs) * runK * dt;
    if (p.broomGlide > 0 && vel.y < -BROOM.glideFall) vel.y = -BROOM.glideFall; // just off a broom: drifting down
    torchThrust(p, cmd, world, tick, dt);
    // Hopping over a conveyor (a river of sand) does not get you out of it: a little way
    // above one, it still drags you along.
    const below = world.traceBox(p.pos, v3(p.pos.x, p.pos.y - 2.2, p.pos.z), MINS, maxs);
    const drag = below.fraction < 1 ? below.brush?.push : null;
    if (drag) vset(p.pos, world.traceBox(p.pos, vma(p.pos, drag, dt), MINS, maxs).end);
    // Glancing off a wall in the air keeps your speed: it only turns you along the
    // wall. (Hitting one head-on still stops you.)
    const hs0 = Math.hypot(vel.x, vel.z);
    stepSlideMove(world, p, maxs, dt, null);
    const hs1 = Math.hypot(vel.x, vel.z);
    // (a wall run keeps its own speed)
    if (!p.wallRunning && hs1 < hs0 && hs1 > hs0 * MOVE.wallGlance) { vel.x *= hs0 / hs1; vel.z *= hs0 / hs1; }
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
    } else if (t.type === 'boost') {
      // A booster strip: your speed its way is raised to its speed (never lowered).
      const want = Math.hypot(t.vel.x, t.vel.z);
      if (want > 0) {
        const dx = t.vel.x / want, dz = t.vel.z / want;
        const along = vel.x * dx + vel.z * dz;
        if (along < want) { vel.x += dx * (want - along); vel.z += dz * (want - along); }
      }
    } else if (t.type === 'teleporter' && p.teleTimer <= 0) {
      vset(p.pos, t.dest); // velocity and view direction are kept
      p.teleTimer = TELEPORT_COOLDOWN; // so the exit pad does not send us straight back
      ev |= MV_TELE;
    }
  }

  if (p.grounded) { p.wallRunning = false; p.wallRunsLeft = MOVE.wallRunMax; }

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

// ------------------------------------------------------------ melee specials
/** The right-click special of the weapon in hand, when it is the only one in hand (dual wielding, right-click is the right hand). */
export function specialIn(p: Player) {
  const a = p.weapons[0], b = p.weapons[1];
  if (a && b && WEAPONS[a.type].hands === 1 && WEAPONS[b.type].hands === 1) return undefined;
  const w = p.weapons[p.active];
  return WEAPONS[w ? w.type : 'fists'].special;
}

/**
 * The movement side of melee specials: cooldown, guarding, winding up, the
 * dash and the leap. Returns MV_SPECIAL / MV_SLAM for the simulation to act on.
 */
function specialControl(p: Player, cmd: InputCmd, dt: number): number {
  p.specialCd = Math.max(0, p.specialCd - dt);
  p.specialPower = 0;
  const sp = specialIn(p);
  const held = (cmd.buttons & BTN.FIRE2) !== 0;
  const pressed = held && !(p.prevButtons & BTN.FIRE2);
  const w = p.weapons[p.active];
  const usable = !w || w.ammo > 0;
  if (!sp || p.heldBy >= 0) { p.specialT = 0; return 0; }
  switch (sp.kind) {
    case 'guard':
      p.specialT = held ? p.specialT + dt : 0;
      return 0;
    case 'charge':
      if (held && (p.specialT > 0 || (pressed && p.specialCd <= 0 && usable))) {
        p.specialT = Math.min(sp.time, p.specialT + dt);
        return 0;
      }
      if (p.specialT > 0) { // let go: swing
        p.specialPower = p.specialT / sp.time;
        p.specialT = 0;
        p.specialCd = sp.cooldown;
        return MV_SPECIAL;
      }
      return 0;
    case 'lunge':
      if (p.specialT > 0) {
        p.specialT += dt;
        if (p.specialT >= sp.time) { p.specialT = 0; p.vel.x *= 0.35; p.vel.z *= 0.35; } // done: skid to a stop
        else { p.vel.x = p.specialDir.x * sp.speed; p.vel.z = p.specialDir.z * sp.speed; }
        return 0;
      }
      if (pressed && p.specialCd <= 0 && usable && p.rooted <= 0) {
        p.specialDir = v3(-Math.sin(cmd.yaw), 0, -Math.cos(cmd.yaw));
        p.specialT = dt;
        p.specialCd = sp.cooldown;
        p.vel.x = p.specialDir.x * sp.speed; p.vel.z = p.specialDir.z * sp.speed;
        p.sliding = false;
        return MV_SPECIAL;
      }
      return 0;
    case 'slam':
      if (p.specialT > 0) {
        p.specialT += dt;
        if (p.grounded && p.specialT > 0.15) { p.specialT = 0; return MV_SLAM; } // landed: the shockwave
        if (p.specialT > 3) p.specialT = 0; // never came down (the void): forget it
        return 0;
      }
      if (pressed && p.specialCd <= 0 && p.rooted <= 0) {
        p.specialT = dt;
        p.specialCd = sp.cooldown;
        p.vel.y = Math.max(p.vel.y, sp.leap);
        p.vel.x += -Math.sin(cmd.yaw) * sp.forward;
        p.vel.z += -Math.cos(cmd.yaw) * sp.forward;
        p.grounded = false;
        p.sliding = false;
        return MV_SPECIAL;
      }
      return 0;
    case 'splash':
      if (pressed && p.specialCd <= 0 && usable) { p.specialCd = sp.cooldown; return MV_SPECIAL; }
      return 0;
  }
}

// ------------------------------------------------------------ legendaries
/** The rocket hammer in hand, with fuel in it? */
function jetIn(p: Player) {
  const w = p.weapons[p.active];
  return w && w.ammo > 0 ? WEAPONS[w.type].jet : undefined;
}

/**
 * JETHAMMER trigger: lights on a press of fire, burns while it is held (and
 * there is fuel), goes out when it is let go, or you are stunned or trapped.
 * Gone out, you simply keep your speed. Returns the config while burning.
 */
function jetControl(p: Player, cmd: InputCmd, dt: number) {
  const cfg = jetIn(p);
  const fire = (cmd.buttons & BTN.FIRE) !== 0;
  if (p.jetT > 0 && (!cfg || !fire || p.stun > 0 || p.rooted > 0)) { p.jetT = 0; p.jetSpeed = 0; }
  if (p.jetT <= 0) {
    if (!cfg || !(fire && !(p.prevButtons & BTN.FIRE)) || p.stun > 0 || p.rooted > 0) return undefined;
    p.jetSpeed = 0; // the button is pressed: the compartment starts to open
  }
  const was = p.jetT;
  p.jetT += dt;
  if (p.jetT < cfg!.open) return undefined; // still opening: you move as usual
  if (was < cfg!.open) {
    // The thruster is out. Light it: the line is your aim now, flattened to at most maxPitch.
    const pitch = Math.max(-cfg!.maxPitch, Math.min(cfg!.maxPitch, cmd.pitch));
    const c = Math.cos(pitch);
    p.jetDir = v3(-Math.sin(cmd.yaw) * c, Math.sin(pitch), -Math.cos(cmd.yaw) * c);
    p.jetSpeed = Math.max(cfg!.start, vdot(p.vel, p.jetDir));
    p.sliding = false;
  }
  const w = p.weapons[p.active]!;
  if (!p.infiniteAmmo) w.ammo = Math.max(0, w.ammo - cfg!.drain * dt);
  return cfg;
}

/**
 * SKYSWEEPER: one tick on the broom. W flies where you look (look up to climb,
 * down to dive), A/D strafe, jump rises, crouch sinks; let go and it slows to a
 * hover. Walls and floors are slid along. The charge drains as you ride; when it
 * is gone you are off it, gliding down.
 */
function broomMove(p: Player, cmd: InputCmd, world: World, dt: number): number {
  p.broomT = Math.max(0, p.broomT - dt);
  if (p.broomT <= 0) { p.broomGlide = BROOM.glide; return 0; } // spent: off you get (the sim makes it vanish)
  p.crouched = false;
  p.sliding = false;
  p.wallRunning = false;
  p.jetT = 0;
  const cp = Math.cos(cmd.pitch), sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  let up = 0;
  if (cmd.buttons & BTN.JUMP) up += 1;
  if (cmd.buttons & (BTN.CROUCH | BTN.DUCK)) up -= 1;
  let wx = -sy * cp * cmd.moveF + cy * cmd.moveR;
  let wy = Math.sin(cmd.pitch) * cmd.moveF + up;
  let wz = -cy * cp * cmd.moveF - sy * cmd.moveR;
  const len = Math.hypot(wx, wy, wz);
  const stopped = p.rooted > 0 || p.heldBy >= 0;
  const k = stopped || len < 1e-6 ? 0 : BROOM.speed / Math.max(1, len);
  wx *= k; wy *= k; wz *= k;
  const a = Math.min(1, BROOM.accel * dt);
  p.vel = v3(p.vel.x + (wx - p.vel.x) * a, p.vel.y + (wy - p.vel.y) * a, p.vel.z + (wz - p.vel.z) * a);
  if (p.pos.y >= BROOM.ceiling && p.vel.y > 0) p.vel.y = 0;
  let left = dt;
  for (let i = 0; i < 4 && left > 1e-6; i++) {
    const tr = world.traceBox(p.pos, vma(p.pos, p.vel, left), MINS, STAND_MAXS);
    vset(p.pos, tr.end);
    if (tr.fraction >= 1) break;
    left *= 1 - tr.fraction;
    const into = vdot(p.vel, tr.normal);
    if (into < 0) p.vel = vma(p.vel, tr.normal, -into * OVERCLIP); // slide along walls and floors
  }
  groundCheck(p, world, STAND_MAXS);
  return 0;
}

/**
 * SLABRIDER on the ground: it rolls where it points. W opens the throttle (towards
 * BIKE.speed, more on the back wheel), S brakes and then backs up, nothing held and
 * it coasts; A/D lean it sideways a little. Sideways slide is gripped away fast, so
 * turning your view turns the bike.
 */
function bikeDrive(p: Player, cmd: InputCmd, dt: number): void {
  const v = p.vel;
  const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
  // Turning: the way you are rolling swings round to the way the bike points, keeping its speed
  // (rolling backwards, to straight behind it).
  const hs = Math.hypot(v.x, v.z);
  let turning = false; // still swinging round: the tyres leave the sideways part alone meanwhile
  if (hs > 0.3) {
    const back = v.x * fx + v.z * fz < -0.1 * hs;
    const tx = back ? -fx : fx, tz = back ? -fz : fz;
    const ang = Math.atan2(v.x * tz - v.z * tx, v.x * tx + v.z * tz);
    const st = Math.sign(ang) * Math.min(Math.abs(ang), BIKE.turn * dt);
    turning = Math.abs(ang) > BIKE.turn * dt;
    const c = Math.cos(st), sn = Math.sin(st);
    const x = v.x * c - v.z * sn, z = v.x * sn + v.z * c;
    v.x = x; v.z = z;
  }
  let f = v.x * fx + v.z * fz, s = v.x * rx + v.z * rz;
  const stopped = p.rooted > 0 || p.heldBy >= 0;
  const top = BIKE.speed * (p.wheelie ? BIKE.wheelieSpeed : 1) * (p.stun > 0 ? MOVE.stunSpeedScale : 1);
  const want = stopped ? 0 : cmd.moveF > 0 ? top : cmd.moveF < 0 ? -BIKE.reverse : 0;
  const rate = stopped ? BIKE.brake : cmd.moveF === 0 ? BIKE.coast : f * want < 0 ? BIKE.brake : Math.abs(f) > Math.abs(want) ? BIKE.coast : BIKE.accel;
  f += Math.max(-rate * dt, Math.min(rate * dt, want - f));
  if (!turning || stopped) s += ((stopped ? 0 : cmd.moveR * BIKE.strafe) - s) * Math.min(1, BIKE.grip * dt);
  v.x = fx * f + rx * s;
  v.z = fz * f + rz * s;
}

/** One tick along the rocket's line. Floors and ceilings are skimmed, steps hopped; a wall stops you dead. */
function jetMove(p: Player, world: World, dt: number, cfg: NonNullable<ReturnType<typeof jetIn>>): number {
  let ev = 0;
  const before = p.jetSpeed;
  p.jetSpeed = Math.min(cfg.speed, p.jetSpeed + cfg.accel * dt);
  if (before < cfg.boom && p.jetSpeed >= cfg.boom) ev |= MV_BOOM;
  const maxs = p.crouched ? CROUCH_MAXS : STAND_MAXS;
  p.vel = v3(p.jetDir.x * p.jetSpeed, p.jetDir.y * p.jetSpeed, p.jetDir.z * p.jetSpeed);
  let left = dt;
  for (let i = 0; i < 4 && left > 1e-6; i++) {
    const tr = world.traceBox(p.pos, vma(p.pos, p.vel, left), MINS, maxs);
    vset(p.pos, tr.end);
    if (tr.fraction >= 1) break;
    left *= 1 - tr.fraction;
    const n = tr.normal;
    if (Math.abs(n.y) >= MOVE.minGroundNormalY) {
      // A floor or a ceiling: skim along it, and keep doing so.
      const into = vdot(p.jetDir, n);
      p.jetDir = vnorm(vma(p.jetDir, n, -into));
      p.vel = vma(p.vel, n, -vdot(p.vel, n));
      continue;
    }
    // A step? Try the same move a step higher.
    const up = world.traceBox(p.pos, v3(p.pos.x, p.pos.y + MOVE.stepHeight, p.pos.z), MINS, maxs);
    const fwd = world.traceBox(up.end, vma(up.end, p.vel, left), MINS, maxs);
    if (fwd.fraction > 0.05) {
      const dn = world.traceBox(fwd.end, v3(fwd.end.x, fwd.end.y - MOVE.stepHeight, fwd.end.z), MINS, maxs);
      vset(p.pos, dn.end);
      left *= 1 - fwd.fraction;
      continue;
    }
    // A wall.
    p.jetT = 0;
    const hit = p.jetSpeed;
    p.jetSpeed = 0; // out: the roar stops with it
    p.vel = v3(n.x * 4, 3, n.z * 4); // bounced off it
    if (hit > cfg.splatSpeed) { p.stun = cfg.stun; ev |= MV_SPLAT; }
    break;
  }
  groundCheck(p, world, maxs);
  return ev;
}

/** AFTERBURN pointed down (with fuel): it is a rocket. Shared with the sim, which drops the fire trail while airborne. */
export function torchFlying(p: Player, cmd: InputCmd): boolean {
  const w = p.weapons[p.active];
  const cfg = w && w.ammo > 0 ? WEAPONS[w.type].torch : undefined;
  return !!cfg && (cmd.buttons & BTN.FIRE) !== 0 && cmd.pitch < -cfg.downPitch && p.heldBy < 0 && p.rooted <= 0;
}

/**
 * AFTERBURN as a rocket: pushes against the aim, plus a sideways shove that
 * wanders on its own. The wobble depends only on the tick, so the host and
 * the client's prediction agree on it.
 */
function torchThrust(p: Player, cmd: InputCmd, world: World, tick: number, dt: number): void {
  if (!torchFlying(p, cmd)) return;
  const cfg = WEAPONS[p.weapons[p.active]!.type].torch!;
  const cp = Math.cos(cmd.pitch);
  const dx = -Math.sin(cmd.yaw) * cp, dy = Math.sin(cmd.pitch), dz = -Math.cos(cmd.yaw) * cp;
  // The ceiling: the climb fades out over the last metre below maxLift above
  // whatever is underneath. Above that (or over the void) it only holds you up
  // as well as it can, which is not quite enough: you sink back to it.
  const reach = cfg.maxLift + 1;
  const below = world.traceRay(p.pos, v3(p.pos.x, p.pos.y - reach, p.pos.z)).fraction * reach;
  const climb = Math.max(0, Math.min(1, cfg.maxLift - below));
  let up = -dy * cfg.thrust;
  if (up > 0) up = Math.min(up, MOVE.gravity * 0.9 + (up - MOVE.gravity * 0.9) * climb);
  p.vel.x -= dx * cfg.thrust * dt;
  p.vel.y += up * dt;
  p.vel.z -= dz * cfg.thrust * dt;
  // ...and no coasting through it: near the ceiling the climb slows to a stop at it.
  if (up > 0) p.vel.y = Math.min(p.vel.y, Math.max(0, (cfg.maxLift - below) * 4));
  const a = tick * 0.21 + Math.sin(tick * 0.057) * 3;
  p.vel.x += Math.cos(a) * cfg.wobble * dt;
  p.vel.z += Math.sin(a) * cfg.wobble * dt;
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
/**
 * Wall run. In the air, beside a wall, moving along it at MOVE.wallRunMinSpeed
 * or more: you run along it, no key needed, for up to MOVE.wallRunTime. Speed
 * along the wall is kept, speed into it dropped, and you hug it. It ends when
 * time is up, you slow down, the wall ends, you push away from it, or you land
 * (a wall jump ends it too). Returns true on the tick a run starts.
 */
function wallRun(p: Player, world: World, maxs: Vec3, wishdir: Vec3, wishScale: number, dt: number): boolean {
  p.wallRunCd = Math.max(0, p.wallRunCd - dt);
  const n = findWall(p, world, maxs);
  const nl = n ? Math.hypot(n.x, n.z) || 1 : 1;
  const nx = n ? n.x / nl : 0, nz = n ? n.z / nl : 0;
  const into = p.vel.x * nx + p.vel.z * nz; // negative: towards the wall
  const along = n ? Math.hypot(p.vel.x - nx * into, p.vel.z - nz * into) : 0;
  const away = wishScale > 0.1 && (wishdir.x * nx + wishdir.z * nz) > 0.5;
  if (p.wallRunning) {
    p.wallRunT += dt;
    if (!n || away || p.wallRunT >= MOVE.wallRunTime || along < MOVE.wallRunMinSpeed * 0.6) {
      p.wallRunning = false;
      p.wallRunCd = MOVE.wallRunCooldown;
      return false;
    }
  } else {
    if (!n || away || p.wallRunCd > 0 || p.wallRunsLeft <= 0 || along < MOVE.wallRunMinSpeed || p.vel.y < -8 || p.launchTimer > 0) return false;
    // In a narrow shaft (another wall right behind you) you climb by wall jumping, not run along it.
    const back = world.traceBox(p.pos, v3(p.pos.x + nx * MOVE.shaftWidth, p.pos.y, p.pos.z + nz * MOVE.shaftWidth), MINS, maxs);
    if (back.fraction < 1 && Math.abs(back.normal.y) < 0.3) return false;
    p.wallRunning = true;
    p.wallRunT = 0;
    p.wallRunsLeft--;
    p.vel.y = Math.min(MOVE.wallRunMaxRise, Math.max(MOVE.wallRunLift, p.vel.y)); // along the wall, not up it
  }
  // Hug the wall, and keep every bit of speed: what was going into the wall (or
  // away from it) now goes along it, plus a touch towards it so contact holds.
  let ax = p.vel.x - nx * into, az = p.vel.z - nz * into;
  // (the little push of last tick's hug is not speed to keep)
  const hs = into < 0 && into > -0.65 ? Math.hypot(ax, az) : Math.hypot(p.vel.x, p.vel.z);
  const al = Math.hypot(ax, az);
  if (al > 0.01) { ax *= hs / al; az *= hs / al; }
  p.vel.x = ax - nx * 0.6;
  p.vel.z = az - nz * 0.6;
  return p.wallRunT === 0;
}

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
