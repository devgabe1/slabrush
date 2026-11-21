import { AIM, BIKE, BROOM, DT, NET, PICKUP, PLAYER, type Rules } from '../config/game';
import { MOVE } from '../config/movement';
import { THROW, WEAPONS, type WeaponDef, type WeaponId } from '../config/weapons';
import { Rng } from '../core/rng';
import { v3, vadd, vcopy, vcross, vdot, vlen, vma, vnorm, vscale, vset, vsub, type Vec3 } from '../core/vec';
import type { BotKind, MapDef } from './map';
import { HULL, MV_BOOM, MV_SLAM, MV_SPECIAL, MV_SPLAT, MV_WALLRUN, specialIn, torchFlying, MV_CRUSH, MV_JUMP, MV_LAND, MV_PAD, MV_SLIDE, MV_TELE, MV_WALLJUMP, pmove } from './pmove';
import {
  BTN, emptyCmd, type InputCmd, type KillCause, type Pickup, type Player, type Projectile,
  type SimEvent, type WeaponInst, type Zone,
} from './types';
import { World } from './world';

// The authoritative game simulation. Fixed tick, deterministic, no rendering,
// no DOM. Offline it runs locally; in Phase 2 the room host runs this exact
// class and other peers only send InputCmds and receive snapshots + events.

const ITEM_MINS = v3(-0.15, 0, -0.15);
const ITEM_MAXS = v3(0.15, 0.3, 0.15);
/** A stuck mine / resting grenade counts as attached while this box still touches something. */
const STICK_MIN = v3(-0.14, -0.14, -0.14);
const STICK_MAX = v3(0.14, 0.14, 0.14);
const TURRET_RANGE = 18;
/** Height of a player's middle above their feet: where a beam holds them. */
export const HOLD_CENTRE = 0.9;
/** AFTERBURN: seconds a fresh burning patch spares whoever dropped it. */
export const FIRE_OWNER_GRACE = 0.75;
/** Deaths the environment deals out, which go to whoever put you there (see kill). */
const ENVIRONMENT: readonly KillCause[] = ['void', 'lava', 'crush', 'zone'];

/**
 * Dual wielding: both slots hold one-handed weapons, so both are in the
 * player's hands at once (FIRE uses slot 1 / left, FIRE2 uses slot 2 / right).
 */
export function isDual(p: Player): boolean {
  const a = p.weapons[0], b = p.weapons[1];
  return !!a && !!b && WEAPONS[a.type].hands === 1 && WEAPONS[b.type].hands === 1;
}

/** A loudness from the network: 0..1, or -1 for "no microphone". Anything else is 0. */
export function clampLoud(v: unknown): number {
  if (v === -1) return -1;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/** A wheel value from the network: whole notches, at most three per input. */
export function clampWheel(w: unknown): number {
  return typeof w === 'number' && Number.isFinite(w) ? Math.max(-3, Math.min(3, Math.round(w))) : 0;
}

/** Weapons you can aim down the sights with: guns, not fists, blades, grenades, traps or the beam (its second button hurls). */
export function canAim(def: WeaponDef): boolean {
  return def.kind !== 'melee' && !def.consumed && def.category !== 'trap' && !def.beam && !def.shout && !def.mirror;
}

/**
 * Aiming = holding the second fire button with one weapon in your hands.
 * While dual wielding that button fires the right-hand weapon instead.
 */
export function isAiming(p: Player, buttons: number): boolean {
  if (!p.alive || isDual(p) || !(buttons & BTN.FIRE2)) return false;
  const w = p.weapons[p.active];
  return !!w && canAim(WEAPONS[w.type]);
}

/** Forget every melee status effect (respawn, death). */
export function clearStatus(p: Player): void {
  p.bleed = p.bleedStacks = p.bleedAcc = p.soaked = p.batted = p.comboCount = p.comboTimer = 0;
  p.bleedBy = p.battedBy = p.comboTarget = -1;
  p.beamT = p.beamAcc = p.flungT = p.shoutT = p.shoutPower = p.jetT = p.jetSpeed = p.mirrorT = p.specialT = p.specialCd = p.specialPower = p.kiCharge = p.kiFireT = p.broomT = p.broomGlide = p.bikeT = p.tumbleT = 0;
  p.wheelie = false;
  p.beamHurt = false;
  p.runawaySlot = -1;
  p.flungBy = -1;
}

export function aimDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return v3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export function eyePos(p: Player): Vec3 {
  return v3(p.pos.x, p.pos.y + (p.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), p.pos.z);
}

/** Ray vs AABB (slab test). Returns distance along the ray, or -1. */
function rayBox(
  o: Vec3, d: Vec3, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tmax: number,
): number {
  let t0 = 0, t1 = tmax;
  const os = [o.x, o.y, o.z], ds = [d.x, d.y, d.z], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(ds[i]) < 1e-9) {
      if (os[i] < lo[i] || os[i] > hi[i]) return -1;
    } else {
      let a = (lo[i] - os[i]) / ds[i], b = (hi[i] - os[i]) / ds[i];
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return -1;
    }
  }
  return t0;
}

interface Hit {
  t: number;
  pos: Vec3;
  victim: Player | null;
  mirror?: Player; // the shot was stopped by this player's REARVIEW field
  head: boolean;
  normal: Vec3;
  hitWorld: boolean;
}

export function makePlayer(id: number, name: string, color: number, bot: BotKind | null = null): Player {
  return {
    id, name, color, look: [0, 0, 0], bot, spawn: null,
    pos: v3(), prevPos: v3(), vel: v3(), yaw: 0, pitch: 0,
    grounded: false, groundNormal: v3(0, 1, 0), groundSurface: 'normal',
    crouched: false, sliding: false, wallRunning: false, wallRunT: 0, wallRunsLeft: MOVE.wallRunMax, wallRunCd: 0, slideBoostTimer: 0,
    wallJumpsLeft: MOVE.wallJumpMax, wallJumpTimer: 0, groundTime: 1, rooted: 0, launchTimer: 0, teleTimer: 0, landSpeed: 0, stun: 0, prevButtons: 0,
    aiming: false, health: PLAYER.maxHealth, stillT: 0, alive: true, respawnTimer: 0,
    bleed: 0, bleedStacks: 0, bleedBy: -1, bleedAcc: 0, soaked: 0, batted: 0, battedBy: -1, comboTarget: -1, comboCount: 0, comboTimer: 0,
    specialT: 0, specialCd: 0, specialDir: v3(0, 0, -1), specialPower: 0, broomT: 0, broomGlide: 0, bikeT: 0, tumbleT: 0, wheelie: false, kiCharge: 0, kiFireT: 0, kiPower: 0, kiDir: v3(0, 0, -1), mirrorT: 0, jetT: 0, jetDir: v3(0, 0, -1), jetSpeed: 0, shoutT: 0, shoutPower: 0, runawaySlot: -1, beamT: 0, beamHurt: false, beamAcc: 0, holding: -1, holdDist: 0, heldBy: -1, flungBy: -1, flungT: 0,
    weapons: [null, null], active: 0, cooldown: [0, 0], burstLeft: [0, 0], burstTimer: [0, 0], spin: 0, infiniteAmmo: false, nearPickup: -1, noclip: false,
    kills: 0, deaths: 0, cmd: emptyCmd(), batch: null,
  };
}

interface HistState { x: number; y: number; z: number; c: boolean }

export class GameSim {
  tick = 0;
  private ramUntil = new Map<number, number>(); // SLABRIDER: rider*4096+victim -> tick until which they cannot be run over again
  /** While frozen (round countdown) time advances but nobody can move or shoot. */
  frozen = false;
  roundTime = 0;
  zone: Zone | null = null;
  /** Recent positions of every player, one entry per tick, for lag compensation. */
  private history: { tick: number; s: Map<number, HistState> }[] = [];
  players: Player[] = [];
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];
  /** Drained by the client every tick. */
  events: SimEvent[] = [];
  world: World;
  rng: Rng;
  private nextId = 1;
  /** The same for the REARVIEW's field (read by useMirror). */
  private mirrorWas = 0;
  /** REARVIEW: last tick each field made a catching sound (so a hail of bullets is not a hail of events). */
  private lastCatch = new Map<number, number>();
  /** Was this player's beam on before this input (read by useBeam, within updateWeapons)? */
  private beamWas = 0;
  /** The same for the HECKLER (read by useShout). */
  private shoutWas = 0;
  private spawners: { timer: number; pickupId: number }[] = [];

  constructor(public map: MapDef, seed: number, public rules: Rules, startTick = 0) {
    this.tick = startTick;
    this.world = new World(map.solids, map.triggers);
    this.world.setTick(startTick);
    this.rng = new Rng(seed ^ 0x9e3779b9);
    map.pickups.forEach((_, i) => {
      this.spawners.push({ timer: 0, pickupId: -1 });
      this.spawnFromSpawner(i);
    });
    map.bots.forEach((b, i) => {
      const bot = this.addPlayer(100 + i, `DUMMY-${i + 1}`, 0x8a8a8a, b.kind);
      bot.spawn = { pos: vcopy(b.pos), yaw: b.yaw };
      bot.look = [(i * 5 + 1) % 12, (i * 7 + 3) % 12, (i * 3 + 2) % 12]; // every dummy dresses differently
      this.respawn(bot);
    });
  }

  addPlayer(
    id: number, name: string, color: number, bot: BotKind | null = null, spawn: { pos: Vec3; yaw: number } | null = null,
  ): Player {
    const p = makePlayer(id, name, color, bot);
    p.spawn = spawn;
    this.players.push(p);
    if (!bot) this.respawn(p);
    return p;
  }

  /** A player left mid-round: they die and drop their weapons. */
  forfeit(id: number): void {
    const p = this.getPlayer(id);
    if (p?.alive) this.kill(p, -1, 'left');
  }

  /** Tick the movers are currently at (for rendering). */
  get worldTick(): number { return this.tick; }

  getPlayer(id: number): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  setInput(id: number, cmd: InputCmd): void {
    const p = this.getPlayer(id);
    if (p) p.cmd = cmd;
  }

  respawn(p: Player): void {
    const sp = p.spawn ?? this.rng.pick(this.map.spawns);
    vset(p.pos, sp.pos);
    p.pos.y += 0.02;
    vset(p.prevPos, p.pos);
    p.vel = v3();
    p.yaw = sp.yaw;
    p.pitch = 0;
    p.health = PLAYER.maxHealth;
    p.stillT = 0;
    p.alive = true;
    p.crouched = p.sliding = p.grounded = false;
    p.groundTime = 1;
    p.rooted = 0;
    p.stun = 0;
    clearStatus(p);
    p.holding = p.heldBy = -1;
    p.cooldown = [0.3, 0.3];
    p.burstLeft = [0, 0];
    p.weapons = [null, null];
    p.active = 0;
    p.prevButtons = 0;
    p.cmd = { ...emptyCmd(), yaw: sp.yaw };
    p.infiniteAmmo = false;
    if (p.bot === 'turret') {
      p.weapons[0] = { type: 'rivet', ammo: 1 };
      p.infiniteAmmo = true;
    }
    this.events.push({ t: 'respawn', player: p.id, yaw: sp.yaw });
  }

  // ------------------------------------------------------------------ tick
  step(): void {
    this.tick++;
    this.world.setTick(this.tick);
    if (this.frozen) {
      for (const p of this.players) {
        vset(p.prevPos, p.pos);
        if (p.alive) { p.yaw = p.cmd.yaw; p.pitch = p.cmd.pitch; } // looking around is allowed
        p.aiming = isAiming(p, p.cmd.buttons); // and aiming
        p.prevButtons = p.cmd.buttons;
      }
      this.recordHistory();
      return;
    }
    this.roundTime += DT;
    for (const p of this.players) {
      vset(p.prevPos, p.pos);
      if (!p.alive) {
        p.aiming = false;
        if (this.rules.respawnPlayers && (p.respawnTimer -= DT) <= 0) this.respawn(p);
        continue;
      }
      if (p.bot) p.cmd = this.botThink(p);
      if (p.batch) {
        // A remote player: run exactly the inputs that arrived for this tick.
        for (const cmd of p.batch) {
          if (!p.alive) break;
          p.cmd = cmd;
          this.stepPlayer(p);
        }
      } else {
        this.stepPlayer(p);
      }
    }
    this.updateHolds();
    this.updateMirrors();
    this.updateStatus();
    this.updateProjectiles();
    this.updatePickups();
    this.updateZone();
    this.recordHistory();
  }

  /** One input's worth of one player: movement, map hazards, weapons, pickups. */
  private stepPlayer(p: Player): void {
    p.stun = Math.max(0, p.stun - DT);
    p.soaked = Math.max(0, p.soaked - DT); // same order as the client's prediction
    if (p.noclip) { this.fly(p); p.prevButtons = p.cmd.buttons; return; }
    if (p.heldBy >= 0) {
      // Frozen in someone's beam: no walking, jumping or picking things up;
      // where you go is up to them (updateHolds). But you can still look
      // round and shoot: fight your way out.
      const holder = this.getPlayer(p.heldBy);
      if (!holder || holder.holding !== p.id) p.heldBy = -1; // they left
      if (p.heldBy >= 0) {
        p.yaw = p.cmd.yaw; p.pitch = p.cmd.pitch;
        p.nearPickup = -1;
        p.stillT = 0; // being carried is not standing still
        this.updateWeapons(p);
        p.prevButtons = p.cmd.buttons;
        return;
      }
    }
    const hsBefore = Math.hypot(p.vel.x, p.vel.z);
    const from = vcopy(p.pos);
    const riding = p.broomT > 0, biking = p.bikeT > 0;
    const ev = pmove(p, p.cmd, this.world, DT, this.tick);
    if (riding && p.broomT <= 0) this.events.push({ t: 'broom', kind: 'out', player: p.id, pos: vcopy(p.pos) }); // spent: it crumbles away
    if (biking && p.bikeT <= 0) this.events.push({ t: 'bike', kind: 'out', player: p.id, pos: vcopy(p.pos) }); // out of fuel: it sputters out and is wrecked
    if (biking && this.bikeHits(p, hsBefore)) return;
    if (p.batted > 0 && this.wallSplat(p, hsBefore)) return;
    if (p.jetT > 0 || ev & MV_SPLAT) { this.jetHits(p, from, ev); if (!p.alive) return; }
    if (ev & (MV_SPECIAL | MV_SLAM) || p.specialT > 0) { this.special(p, from, ev); if (!p.alive) return; }
    if (!p.grounded && torchFlying(p, p.cmd)) this.torchTrail(p);
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (ev & MV_PAD) this.events.push({ t: 'pad', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_TELE) this.events.push({ t: 'tele', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_CRUSH) { this.kill(p, -1, 'crush'); return; }
    if (p.grounded && p.groundSurface === 'deadly') { this.kill(p, -1, 'lava'); return; }
    if (ev & MV_JUMP) this.events.push({ t: 'jump', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_WALLJUMP) this.events.push({ t: 'walljump', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_SLIDE) this.events.push({ t: 'slide', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_WALLRUN) this.events.push({ t: 'wallrun', player: p.id, pos: vcopy(p.pos), speed });
    if (ev & MV_LAND) this.events.push({ t: 'land', player: p.id, pos: vcopy(p.pos), speed: p.landSpeed });
    if (p.pos.y < this.map.killY) { this.kill(p, -1, 'void'); return; }
    // Standing still (no movement keys, not sliding about): the regeneration clock runs.
    const still = !p.cmd.moveF && !p.cmd.moveR && Math.hypot(p.vel.x, p.vel.z) < 0.5 && Math.abs(p.vel.y) < 0.5;
    p.stillT = still ? p.stillT + DT : 0;
    this.updateWeapons(p);
    this.updatePickupInteraction(p);
    p.prevButtons = p.cmd.buttons;
  }

  // ------------------------------------------------------ melee status
  /** Once per tick: bleeding drains health (in half-second chunks), timers run down. */
  private updateStatus(): void {
    for (const p of this.players) {
      if (!p.alive) continue;
      p.batted = Math.max(0, p.batted - DT);
      // Still for long enough: health slowly comes back.
      if (p.stillT > PLAYER.regenDelay && p.health < PLAYER.maxHealth) {
        p.health = Math.min(PLAYER.maxHealth, p.health + PLAYER.regenRate * DT);
      }
      if (p.flungT > 0 && (p.flungT -= DT) <= 0) p.flungBy = -1;
      if (p.comboTimer > 0 && (p.comboTimer -= DT) <= 0) p.comboCount = 0;
      if (p.bleed <= 0) continue;
      p.bleed -= DT;
      p.bleedAcc += WEAPONS.shiv.bleed!.dps * p.bleedStacks * DT;
      if (p.bleedAcc >= WEAPONS.shiv.bleed!.dps * 0.5 || (p.bleed <= 0 && p.bleedAcc >= 0.5)) {
        const dmg = p.bleedAcc;
        p.bleedAcc = 0;
        this.applyDamage(p, dmg, p.bleedBy, 'shiv', false, v3(p.pos.x, p.pos.y + 1, p.pos.z), v3(), true);
      }
      if (p.bleed <= 0) { p.bleed = 0; p.bleedStacks = 0; p.bleedAcc = 0; }
    }
  }

  /**
   * SLUGGER: someone batted moments ago who loses a lot of horizontal speed in
   * one tick has hit a wall. It hurts in proportion to the speed lost. Returns
   * true if it killed them.
   */
  /**
   * SLABRIDER: riding into someone runs them over (damage by your speed, and they are
   * thrown along), once per pass; riding into a wall hurts you (by the speed lost).
   * A wheelie doubles both, as it does everything. Returns true if the rider died.
   */
  private bikeHits(p: Player, hsBefore: number): boolean {
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (speed >= BIKE.ramMin) {
      for (const q of this.players) {
        if (q === p || !q.alive || Math.abs(q.pos.y - p.pos.y) > 1.5) continue;
        if (Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) > BIKE.ramReach) continue;
        const key = p.id * 4096 + q.id;
        if ((this.ramUntil.get(key) ?? -1) > this.tick) continue;
        this.ramUntil.set(key, this.tick + Math.round(0.8 / DT)); // not again until you are through them
        const k = BIKE.ramPush;
        const pos = v3(q.pos.x, q.pos.y + 0.9, q.pos.z);
        this.events.push({ t: 'bike', kind: 'ram', player: p.id, pos: vcopy(pos) });
        this.applyDamage(q, speed * BIKE.ramPerMps, p.id, 'slabrider', false, pos, v3(p.vel.x * k, 5, p.vel.z * k));
        p.vel.x *= 0.85; p.vel.z *= 0.85; // a jolt for you too
        if (!p.alive) return true;
      }
    }
    const lost = hsBefore - speed;
    if (lost >= BIKE.crashMin && p.bikeT > 0) {
      const pos = v3(p.pos.x, p.pos.y + 0.8, p.pos.z);
      this.events.push({ t: 'bike', kind: 'crash', player: p.id, pos: vcopy(pos) });
      this.applyDamage(p, lost * BIKE.crashPerMps, p.id, 'slabrider', false, pos, v3());
      return !p.alive;
    }
    return false;
  }

  private wallSplat(p: Player, hsBefore: number): boolean {
    const cfg = WEAPONS.slugger.wallSplat!;
    const lost = hsBefore - Math.hypot(p.vel.x, p.vel.z);
    if (lost < cfg.minSpeed) return false;
    p.batted = 0; // one splat per swing
    const pos = v3(p.pos.x, p.pos.y + 1, p.pos.z);
    this.events.push({ t: 'status', kind: 'splat', attacker: p.battedBy, victim: p.id, pos });
    this.applyDamage(p, lost * cfg.perMps, p.battedBy, 'slugger', false, pos, v3());
    return !p.alive;
  }

  /** The powers a melee weapon adds to a hit, before its damage is applied. Returns the damage multiplier. */
  private meleePower(def: WeaponDef, attacker: Player, v: Player, push: Vec3, pos: Vec3): number {
    let mult = 1;
    if (def.bleed) {
      v.bleed = def.bleed.seconds;
      v.bleedStacks = Math.min(def.bleed.maxStacks, v.bleedStacks + 1);
      v.bleedBy = attacker.id;
      this.events.push({ t: 'status', kind: 'bleed', attacker: attacker.id, victim: v.id, pos });
    }
    if (def.soak) {
      v.soaked = Math.max(v.soaked, def.soak);
      this.events.push({ t: 'status', kind: 'soak', attacker: attacker.id, victim: v.id, pos });
    }
    if (def.wallSplat) {
      v.batted = def.wallSplat.window;
      v.battedBy = attacker.id;
    }
    if (def.combo) {
      const c = def.combo;
      attacker.comboCount = attacker.comboTarget === v.id && attacker.comboTimer > 0 ? attacker.comboCount + 1 : 1;
      attacker.comboTarget = v.id;
      attacker.comboTimer = c.window;
      if (attacker.comboCount >= c.hits) {
        attacker.comboCount = 0;
        mult = c.mult;
        push.y += c.launch;
        v.stun = Math.max(v.stun, c.stun);
        this.events.push({ t: 'status', kind: 'combo', attacker: attacker.id, victim: v.id, pos });
      }
    }
    return mult;
  }

  // ------------------------------------------------------------- KI BLAST
  /**
   * Hold to gather, let go to release. While the beam is out it runs by
   * itself (the trigger no longer matters): it follows the aim slowly, burns
   * and shoves everyone in it, and pushes the shooter back a little.
   */
  private useKi(p: Player, slot: number, w: WeaponInst, held: boolean, pressed: boolean): void {
    const def = WEAPONS[w.type], cfg = def.ki!;
    if (p.kiFireT > 0) { this.kiBeam(p, w.type, cfg); return; }
    if (held && w.ammo <= 0) {
      if (pressed) this.throwSlot(p, slot); // spent: thrown like any empty gun
      return;
    }
    if (held && (p.kiCharge > 0 || p.cooldown[slot] <= 0)) {
      p.kiCharge = Math.min(cfg.charge, p.kiCharge + DT);
      // The hum, a pulse at a time, rising as it fills.
      if (p.cooldown[slot] <= 0) {
        p.cooldown[slot] = def.fireInterval;
        this.events.push({ t: 'ki', kind: 'charge', player: p.id, pos: eyePos(p), power: p.kiCharge / cfg.charge });
      }
      return;
    }
    if (p.kiCharge <= 0) return;
    // Let go.
    const gathered = p.kiCharge;
    p.kiCharge = 0;
    p.cooldown[slot] = 0.5;
    if (gathered < cfg.minCharge) {
      this.events.push({ t: 'ki', kind: 'fizzle', player: p.id, pos: eyePos(p), power: 0 });
      return;
    }
    if (!p.infiniteAmmo) w.ammo--;
    p.kiPower = gathered / cfg.charge;
    p.kiFireT = cfg.time;
    p.kiDir = aimDir(p.yaw, p.pitch);
    this.events.push({ t: 'ki', kind: 'blast', player: p.id, pos: eyePos(p), power: p.kiPower });
    this.kiBeam(p, w.type, cfg);
  }

  /** One tick of a KI BLAST beam. */
  private kiBeam(p: Player, id: WeaponId, cfg: NonNullable<WeaponDef['ki']>): void {
    p.kiFireT = Math.max(0, p.kiFireT - DT);
    // Sweep towards the aim, at most `turn` radians a second.
    const aim = aimDir(p.yaw, p.pitch);
    const ang = Math.acos(Math.max(-1, Math.min(1, vdot(p.kiDir, aim))));
    const step = cfg.turn * DT;
    p.kiDir = ang <= step ? aim : vnorm(vma(vscale(p.kiDir, 1 - step / ang), aim, step / ang));
    const k = p.kiPower;
    const radius = cfg.radius[0] + (cfg.radius[1] - cfg.radius[0]) * k;
    const dps = cfg.dps[0] + (cfg.dps[1] - cfg.dps[0]) * k;
    const from = eyePos(p);
    const len = this.world.traceRay(from, vma(from, p.kiDir, cfg.range)).fraction * cfg.range; // walls stop it
    if ((Math.round(p.kiFireT / DT) % 12) === 0) this.events.push({ t: 'ki', kind: 'roar', player: p.id, pos: vcopy(from), power: k });
    // Pushed back by it.
    p.vel.x -= p.kiDir.x * cfg.recoil * DT;
    p.vel.z -= p.kiDir.z * cfg.recoil * DT;
    // Everyone inside: burned (in chunks every tenth of a second) and shoved along it.
    const tickDamage = Math.round(p.kiFireT / DT) % 6 === 0;
    for (const v of this.players) {
      if (!v.alive || v === p) continue;
      const c = v3(v.pos.x, v.pos.y + 0.9, v.pos.z);
      const t = vdot(vsub(c, from), p.kiDir);
      if (t < 0 || t > len + radius) continue;
      const off = vlen(vsub(c, vma(from, p.kiDir, t)));
      if (off > radius + PLAYER.hitRadius) continue;
      v.vel.x += p.kiDir.x * cfg.push * DT;
      v.vel.y += Math.max(0, p.kiDir.y) * cfg.push * DT + 6 * DT;
      v.vel.z += p.kiDir.z * cfg.push * DT;
      v.grounded = false;
      v.stillT = 0;
      if (tickDamage) this.applyDamage(v, dps * 0.1, p.id, id, false, c, v3(), true);
    }
  }

  // ------------------------------------------------------------- REARVIEW
  /** The field is up while the trigger is held (and there is charge); let go, or run dry, and it sends everything back. */
  private useMirror(p: Player, slot: number, w: WeaponInst, held: boolean, pressed: boolean): void {
    const def = WEAPONS[w.type], cfg = def.mirror!;
    if (held && w.ammo <= 0 && this.mirrorWas <= 0) {
      if (pressed) this.throwSlot(p, slot);
      else if (p.cooldown[slot] <= 0) { this.events.push({ t: 'empty', player: p.id }); p.cooldown[slot] = 0.2; }
      return;
    }
    const on = held && w.ammo > 0 && !(p.cooldown[slot] > 0 && this.mirrorWas <= 0);
    if (!on) return; // down. Whatever is still stuck to it bounces back on its own time (updateMirrors).
    p.mirrorT = this.mirrorWas + DT;
    if (!p.infiniteAmmo) w.ammo = Math.max(0, w.ammo - cfg.drain * DT);
    if (p.cooldown[slot] <= 0) {
      p.cooldown[slot] = def.fireInterval; // its shimmer, a pulse at a time
      this.events.push({ t: 'fire', player: p.id, weapon: def.id, origin: eyePos(p), dir: aimDir(p.yaw, p.pitch), hand: -1 });
    }
  }

  /** Stop something dead in `q`'s field. `kind` 'rearview' = a caught bullet, carrying `damage`. */
  private freeze(q: Player, at: Vec3, dir: Vec3, speed: number, kind: WeaponId, owner: number, damage?: number, pr?: Projectile): void {
    const cfg = WEAPONS.rearview.mirror!;
    const held = this.projectiles.filter((x) => x.frozenBy === q.id).length;
    if (held >= cfg.max) { // full: it is absorbed
      if (pr) this.projectiles.splice(this.projectiles.indexOf(pr), 1);
      return;
    }
    const pos = vma(at, dir, -0.05);
    if (pr) {
      vset(pr.pos, pos);
      pr.frozenBy = q.id;
      pr.speed0 = speed;
      pr.heldT = 0;
      pr.vel = v3();
    } else {
      this.projectiles.push({
        id: this.nextId++, kind, owner, pos, prevPos: vcopy(pos), vel: v3(), life: WEAPONS[kind].projectile!.fuse ?? 3,
        stuck: false, arm: 0, gen: 0, attached: -1, timer: 0, frozenBy: q.id, speed0: speed, heldT: 0, damage,
      });
    }
    if ((this.lastCatch.get(q.id) ?? -99) < this.tick - 5) {
      this.lastCatch.set(q.id, this.tick);
      this.events.push({ t: 'mirror', kind: 'catch', player: q.id, pos: vcopy(pos), count: 1 });
    }
  }

  /** Does this flying projectile cross someone's field this tick (not its owner's)? Then it is caught there. */
  private catchProjectile(pr: Projectile, step: number): boolean {
    const dir = vscale(pr.vel, 1 / vlen(pr.vel));
    for (const q of this.players) {
      if (q.id === pr.owner || q.mirrorT <= 0 || !q.alive) continue;
      const t = this.throughField(q, pr.pos, dir, step + 0.3);
      if (t < 0) continue;
      this.freeze(q, vma(pr.pos, dir, t), dir, vlen(pr.vel), pr.kind, pr.owner, undefined, pr);
      return true;
    }
    return false;
  }

  /** These, stuck to `p`'s glass, bounce back: theirs now, guided back at whoever fired them. */
  private releaseMirror(p: Player, list: Projectile[]): void {
    const cfg = WEAPONS.rearview.mirror!;
    const eye = eyePos(p), aim = aimDir(p.yaw, p.pitch);
    let n = 0;
    for (const pr of list) {
      pr.frozenBy = -1;
      pr.homeOn = pr.owner; // whoever fired it
      pr.steer = 0;
      const t = this.getPlayer(pr.owner);
      const to = t?.alive ? vsub(this.homeTarget(t), pr.pos) : vscale(aim, 1);
      const len = vlen(to);
      pr.vel = vscale(len > 0.01 ? vscale(to, 1 / len) : aim, cfg.homeSpeed);
      pr.owner = p.id;
      pr.arm = 0;
      pr.life = cfg.homeLife;
      n++;
    }
    if (n) this.events.push({ t: 'mirror', kind: 'release', player: p.id, pos: vma(eye, aim, WEAPONS.rearview.mirror!.distance), count: n });
  }

  /** Where a bounced-back shot aims on its target: the middle of the body. */
  private homeTarget(t: Player): Vec3 {
    return v3(t.pos.x, t.pos.y + (t.crouched ? 0.6 : 1.0), t.pos.z);
  }

  /**
   * A bounced-back shot chasing its target. Each tick it picks the direction
   * to head in: straight at them when nothing is in the way; otherwise the
   * clear direction (a few metres of open air ahead) closest to straight at
   * them, keeping to the side it chose before, so it slides along a wall and
   * round its end instead of into it. Then it turns that way, but only so
   * fast, which makes it curve.
   */
  private homeIn(pr: Projectile): void {
    const cfg = WEAPONS.rearview.mirror!;
    const speed = vlen(pr.vel);
    let cur = speed > 1e-6 ? vscale(pr.vel, 1 / speed) : v3(0, 0, -1);
    const t = pr.homeOn !== undefined && pr.homeOn >= 0 ? this.getPlayer(pr.homeOn) : undefined;
    if (!t?.alive) { pr.homeOn = -1; return; } // nobody to chase: carry straight on
    const goal = this.homeTarget(t);
    const to = vsub(goal, pr.pos);
    const dist = vlen(to);
    const want = vscale(to, 1 / Math.max(dist, 1e-6));
    let head = want;
    if (this.world.traceRay(pr.pos, goal).fraction < 0.999) {
      const LOOK = Math.min(dist, 7);
      const up = Math.abs(want.y) > 0.95 ? v3(1, 0, 0) : v3(0, 1, 0);
      const right = vnorm(vcross(want, up)), over = vcross(right, want);
      const side = pr.steer || 1;
      let best: Vec3 | null = null;
      for (const deg of [20, 40, 60, 80, 100, 125, 150]) {
        const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        // this side first, then the other, then over the top
        for (const [axis, sign] of [[right, side], [right, -side], [over, 1]] as const) {
          const d = vnorm(vma(vscale(want, c), axis, s * sign));
          if (this.world.traceRay(pr.pos, vma(pr.pos, d, LOOK)).fraction < 1) continue;
          // A margin: a little further out than just scraping past the edge.
          const a2 = a + 0.2;
          const d2 = vnorm(vma(vscale(want, Math.cos(a2)), axis, Math.sin(a2) * sign));
          const a3 = Math.max(0, a - 0.15);
          const d3 = vnorm(vma(vscale(want, Math.cos(a3)), axis, Math.sin(a3) * sign));
          if (this.world.traceRay(pr.pos, vma(pr.pos, d2, LOOK)).fraction < 1) continue;
          if (a3 > 0 && this.world.traceRay(pr.pos, vma(pr.pos, d3, LOOK * 0.6)).fraction < 1) continue;
          best = d;
          if (axis === right) pr.steer = sign;
          break;
        }
        if (best) break;
      }
      if (best) head = best;
    } else pr.steer = 0;
    // Turn towards it, at most homeTurn radians a second (three times that with a wall close ahead).
    const ang = Math.acos(Math.max(-1, Math.min(1, vdot(cur, head))));
    const ahead = this.world.traceRay(pr.pos, vma(pr.pos, cur, 4)).fraction < 1;
    const step = cfg.homeTurn * DT * (ahead ? 3 : 1);
    if (ang <= step) cur = head;
    else {
      const k = step / ang; // near enough a slerp for small steps
      cur = vnorm(vma(vscale(cur, 1 - k), head, k));
    }
    pr.vel = vscale(cur, cfg.homeSpeed);
  }

  /**
   * Once a tick: whatever has been stuck to a glass for `linger` seconds
   * bounces back (field up or not). Its owner gone or dead, things simply drop.
   */
  private updateMirrors(): void {
    const linger = WEAPONS.rearview.mirror!.linger;
    const due = new Map<Player, Projectile[]>();
    for (const pr of this.projectiles) {
      if ((pr.frozenBy ?? -1) < 0) continue;
      const q = this.getPlayer(pr.frozenBy!);
      if (!q || !q.alive) { pr.frozenBy = -1; pr.vel = v3(0, -3, 0); continue; }
      pr.heldT = (pr.heldT ?? 0) + DT;
      if (pr.heldT < linger - 1e-9) continue;
      const list = due.get(q) ?? [];
      list.push(pr);
      due.set(q, list);
    }
    for (const [q, list] of due) this.releaseMirror(q, list);
  }

  // ------------------------------------------------------- melee specials
  /**
   * What a melee special does to others (pmove has already moved us):
   * the dash's stab, the wind-up's swing, the slam's shockwave, the splash.
   */
  private special(p: Player, from: Vec3, ev: number): void {
    const sp = specialIn(p);
    if (!sp) return;
    const w = p.weapons[p.active];
    const id: WeaponId = w?.type ?? 'fists';
    const def = WEAPONS[id];
    const wear = () => { if (w && !p.infiniteAmmo && Number.isFinite(w.ammo)) w.ammo = Math.max(0, w.ammo - 1); };
    const at = v3(p.pos.x, p.pos.y + 1, p.pos.z);
    if (ev & MV_SPECIAL) this.events.push({ t: 'special', kind: sp.kind, player: p.id, pos: vcopy(at), power: p.specialPower });

    if (sp.kind === 'lunge' && p.specialT > 0) {
      if (ev & MV_SPECIAL) wear();
      // Sweep the body along this tick's dash; the first player in the way is stabbed and the dash ends.
      const a = v3(from.x, from.y + 1, from.z), d = vsub(at, a), len = vlen(d);
      if (len < 1e-4) return;
      const h = this.hitscan(p.id, a, vscale(d, 1 / len), len + 0.9, 0.4, true);
      if (!h.victim) return;
      const v = h.victim;
      const facing = aimDir(v.yaw, 0), dir = vscale(d, 1 / len);
      const behind = facing.x * dir.x + facing.z * dir.z > 0.4;
      const push = v3(dir.x * 6, 2, dir.z * 6);
      if (def.bleed) this.meleePower(def, p, v, push, h.pos);
      this.applyDamage(v, sp.damage * (behind ? def.backstab ?? 1 : 1), p.id, id, false, h.pos, push);
      p.specialT = 0;
      p.vel.x *= 0.2; p.vel.z *= 0.2;
    } else if (sp.kind === 'charge' && ev & MV_SPECIAL) {
      // Let go of the wind-up: one swing, as hard as it was wound.
      const k = p.specialPower;
      const lerp = (r: [number, number]) => r[0] + (r[1] - r[0]) * k;
      wear();
      this.fire(p, { ...def, damage: lerp(sp.damage), knockback: lerp(sp.knockback), knockUp: lerp(sp.launch), meleePad: (def.meleePad ?? 0.25) + 0.2 * k });
    } else if (sp.kind === 'slam' && ev & MV_SLAM) {
      // Down from the leap: a shockwave. Full damage at the middle, half at the edge; everyone thrown up and out.
      const c = v3(p.pos.x, p.pos.y + 0.3, p.pos.z);
      this.events.push({ t: 'special', kind: 'slam', player: p.id, pos: vcopy(c), power: 1 });
      for (const v of this.players) {
        if (!v.alive || v === p) continue;
        const dx = v.pos.x - c.x, dz = v.pos.z - c.z, dist = Math.hypot(dx, dz);
        if (dist > sp.radius || Math.abs(v.pos.y - p.pos.y) > 2.5) continue;
        if (this.world.traceRay(c, v3(v.pos.x, v.pos.y + 0.9, v.pos.z)).fraction < 0.98) continue; // behind cover
        const f = 1 - dist / sp.radius;
        const out = dist > 0.01 ? v3(dx / dist, 0, dz / dist) : v3(1, 0, 0);
        this.applyDamage(v, sp.damage * (0.5 + 0.5 * f), p.id, id, false, v3(v.pos.x, v.pos.y + 0.9, v.pos.z),
          v3(out.x * sp.push * (0.5 + f), sp.launch * (0.6 + 0.4 * f), out.z * sp.push * (0.5 + f)));
        v.stun = Math.max(v.stun, 0.6);
      }
    } else if (sp.kind === 'splash' && ev & MV_SPECIAL) {
      // A wave: everyone in the cone is drenched, shoved and dazed.
      wear();
      const eye = eyePos(p), aim = aimDir(p.yaw, 0), cos = Math.cos((sp.cone * Math.PI) / 180);
      for (const v of this.players) {
        if (!v.alive || v === p) continue;
        const c = v3(v.pos.x, v.pos.y + 0.9, v.pos.z);
        const to = vsub(c, eye), dist = vlen(to);
        if (dist > sp.range || dist < 0.01) continue;
        const dir = vscale(to, 1 / dist);
        if (dir.x * aim.x + dir.z * aim.z < cos * Math.hypot(dir.x, dir.z)) continue;
        if (this.world.traceRay(eye, c).fraction < 0.98) continue;
        v.soaked = Math.max(v.soaked, sp.soak);
        v.stun = Math.max(v.stun, sp.stun);
        v.vel.x += dir.x * sp.push; v.vel.z += dir.z * sp.push; v.vel.y += 3;
        v.stillT = 0;
        this.events.push({ t: 'status', kind: 'soak', attacker: p.id, victim: v.id, pos: c });
      }
    }
  }

  // ------------------------------------------------------------ JETHAMMER
  /**
   * The hammer's trigger. The rocket itself is pmove's (so it is predicted);
   * here it only roars (a 'fire' pulse every fireInterval while it burns),
   * and, empty, gets thrown like any empty gun.
   */
  private useJet(p: Player, slot: number, w: WeaponInst, held: boolean, pressed: boolean): void {
    if (held && w.ammo <= 0 && p.jetT <= 0) {
      if (pressed) this.throwSlot(p, slot);
      else if (p.cooldown[slot] <= 0) { this.events.push({ t: 'empty', player: p.id }); p.cooldown[slot] = 0.2; }
      return;
    }
    if (p.jetT > 0 && p.jetSpeed > 0 && p.cooldown[slot] <= 0) { // roaring: flying (not while the compartment is still opening, nor after a wall)
      p.cooldown[slot] = WEAPONS[w.type].fireInterval;
      this.events.push({ t: 'fire', player: p.id, weapon: w.type, origin: eyePos(p), dir: vcopy(p.jetDir), hand: -1 });
    }
  }

  /**
   * After a tick of rocketing from `from`: everyone in the way is flattened
   * (above killSpeed), the sound barrier and walls make themselves known.
   */
  private jetHits(p: Player, from: Vec3, ev: number): void {
    const w = p.weapons[p.active];
    const cfg = w ? WEAPONS[w.type].jet : WEAPONS.jethammer.jet;
    if (!cfg) return;
    const id = w?.type ?? 'jethammer';
    if (ev & MV_BOOM) this.events.push({ t: 'jet', kind: 'boom', player: p.id, pos: vcopy(p.pos) });
    if (p.jetT > 0 && p.jetSpeed >= cfg.killSpeed) {
      // Sweep the body along the move, a little ahead, chest high.
      const a = v3(from.x, from.y + 1, from.z), b = v3(p.pos.x, p.pos.y + 1, p.pos.z);
      const d = vsub(b, a), len = vlen(d);
      if (len > 1e-4) {
        const dir = vscale(d, 1 / len);
        const struck = new Set<Player>();
        for (let h = this.hitscan(p.id, a, dir, len + 0.6, 0.45, true); h.victim; h = this.hitscan(p.id, a, dir, len + 0.6, 0.45, true, struck)) {
          const v = h.victim;
          struck.add(v);
          this.events.push({ t: 'jet', kind: 'smash', player: p.id, pos: vcopy(h.pos) });
          this.applyDamage(v, v.health + 1000, p.id, id, false, h.pos, v3(dir.x * 25, 9, dir.z * 25));
        }
      }
    }
    if (ev & MV_SPLAT) {
      const pos = v3(p.pos.x, p.pos.y + 1, p.pos.z);
      this.events.push({ t: 'jet', kind: 'splat', player: p.id, pos });
      this.applyDamage(p, cfg.splatDamage, p.id, id, false, pos, v3());
    }
  }

  // ------------------------------------------------------------ AFTERBURN
  /** Flying on the torch: every so often a burning patch drops from your feet. */
  private torchTrail(p: Player): void {
    const def = WEAPONS[p.weapons[p.active]!.type];
    const every = Math.max(1, Math.round(def.torch!.trailEvery / DT));
    if (this.tick % every !== 0) return;
    const at = v3(p.pos.x, p.pos.y - 0.1, p.pos.z);
    this.projectiles.push({
      id: this.nextId++, kind: def.id, owner: p.id, pos: at, prevPos: vcopy(at), vel: v3(p.vel.x * 0.3, -4, p.vel.z * 0.3),
      life: def.projectile!.fuse ?? 3, stuck: false, arm: 0, gen: 0, attached: -1, timer: 0,
    });
  }

  /**
   * Did this shot land in the tank? The tank is on the back of whoever has an
   * AFTERBURN in their hands: the half of the body facing away, between the
   * waist and the shoulders. Measured where the shooter saw them.
   */
  private inTheTank(shooter: Player, v: Player, at: Vec3): boolean {
    const w = v.weapons[v.active];
    if (!w || !WEAPONS[w.type].torch) return false;
    const vt = shooter.cmd.viewTick;
    const past = vt !== undefined && this.rules.lagCompensation ? this.rewound(v.id, vt) : null;
    const x = past?.x ?? v.pos.x, y = past?.y ?? v.pos.y, z = past?.z ?? v.pos.z;
    const f = aimDir(v.yaw, 0);
    const back = (at.x - x) * f.x + (at.z - z) * f.z;
    return back < -0.12 && at.y > y + 0.7 && at.y < y + 1.6;
  }

  /** The tank goes up: its carrier first, then everyone nearby, and fire everywhere. */
  private blowTank(v: Player, attacker: number, at: Vec3): void {
    const def = WEAPONS[v.weapons[v.active]!.type];
    const cfg = def.torch!;
    v.weapons[v.active] = null; // it does not survive to be picked up
    const centre = v3(v.pos.x, v.pos.y + 1.1, v.pos.z);
    this.applyDamage(v, v.health + 1000, attacker, def.id, false, at, v3(0, 12, 0));
    this.explode(centre, attacker, {
      ...def, projectile: { ...def.projectile!, splashDamage: cfg.tankDamage, splashRadius: cfg.tankRadius, splashKnockback: cfg.tankPush, selfDamageScale: 1 },
    });
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      this.projectiles.push({
        id: this.nextId++, kind: def.id, owner: attacker, pos: vcopy(centre), prevPos: vcopy(centre),
        vel: v3(Math.cos(a) * 5, 5, Math.sin(a) * 5), life: def.projectile!.fuse ?? 3, stuck: false, arm: 0, gen: 0, attached: -1, timer: 0,
      });
    }
  }

  // ------------------------------------------------- the beam (MONOLOGUE)
  /**
   * One input's worth of a beam weapon's trigger. Held down, the beam is on:
   * it drains its charge, hums, and grabs the first player it touches. The
   * second fire button hurls whoever is held. Let go and they drop.
   */
  private useBeam(p: Player, slot: number, w: WeaponInst, held: boolean, pressed: boolean): void {
    const def = WEAPONS[w.type], cfg = def.beam!;
    if (held && w.ammo <= 0) {
      // Spent. Like any empty gun, pulling the trigger throws it.
      if (pressed) this.throwSlot(p, slot);
      else if (p.cooldown[slot] <= 0) { this.events.push({ t: 'empty', player: p.id }); p.cooldown[slot] = 0.2; }
      return;
    }
    if (!held || (p.cooldown[slot] > 0 && this.beamWas <= 0)) return; // off, or still being drawn
    p.beamT = this.beamWas + DT;
    // Both fire buttons: the beam burns whoever it holds, and drains twice as fast.
    p.beamHurt = (p.cmd.buttons & BTN.FIRE2) !== 0;
    if (!p.infiniteAmmo) w.ammo = Math.max(0, w.ammo - cfg.drain * (p.beamHurt ? 2 : 1) * DT);
    if (p.cooldown[slot] <= 0) {
      // The hum, a pulse at a time (it is also what the other players hear).
      p.cooldown[slot] = def.fireInterval;
      this.events.push({ t: 'fire', player: p.id, weapon: def.id, origin: eyePos(p), dir: aimDir(p.yaw, p.pitch), hand: -1 });
    }
    if (p.holding >= 0) {
      // The wheel pushes them away or pulls them in.
      const wheel = clampWheel(p.cmd.wheel);
      if (wheel) p.holdDist = Math.max(cfg.minDist, Math.min(cfg.maxDist, p.holdDist + wheel * cfg.wheelStep));
      return;
    }
    const h = this.hitscan(p.id, eyePos(p), aimDir(p.yaw, p.pitch), def.range, 0.15, true);
    if (h.victim) this.grab(p, h.victim, h.t, cfg);
  }

  private grab(p: Player, v: Player, dist: number, cfg: NonNullable<WeaponDef['beam']>): void {
    if (v.holding >= 0) this.letGo(v); // a beam is no use to someone frozen
    if (v.heldBy >= 0) { const o = this.getPlayer(v.heldBy); if (o) o.holding = -1; } // stolen from another beam
    v.heldBy = p.id;
    v.sliding = false;
    v.rooted = 0;
    v.aiming = false;
    v.burstLeft = [0, 0];
    v.spin = 0;
    v.beamT = 0;
    p.holding = v.id;
    p.holdDist = Math.max(cfg.minDist, Math.min(cfg.maxDist, dist));
    p.beamAcc = 0;
    this.events.push({ t: 'beam', kind: 'grab', player: p.id, victim: v.id, pos: v3(v.pos.x, v.pos.y + HOLD_CENTRE, v.pos.z) });
  }

  /**
   * Release whoever `p` holds. They keep the speed of the swing: swing them
   * around and let go, and that is a throw (a hard one gets a little lift so it
   * carries). Let go while still, and they just drop.
   */
  private letGo(p: Player): void {
    const v = p.holding >= 0 ? this.getPlayer(p.holding) : undefined;
    p.holding = -1;
    p.beamAcc = 0;
    if (!v || v.heldBy !== p.id) return;
    v.heldBy = -1;
    const cfg = WEAPONS.monologue.beam!;
    const speed = vlen(v.vel);
    if (speed > cfg.release) v.vel = vscale(v.vel, cfg.release / speed);
    const thrown = speed > cfg.carry * 0.45;
    if (thrown) v.vel.y += cfg.throwLift;
    v.grounded = false;
    v.groundTime = 0;
    v.flungBy = p.id;
    v.flungT = cfg.credit;
    if (v.alive) this.events.push({ t: 'beam', kind: thrown ? 'fling' : 'drop', player: p.id, victim: v.id, pos: v3(v.pos.x, v.pos.y + HOLD_CENTRE, v.pos.z) });
  }

  /**
   * Once per tick, after everyone has moved: each held player is pulled to the
   * end of their holder's beam (sliding along walls, never through them), and
   * takes a little damage. A wall between the two breaks the beam.
   */
  private updateHolds(): void {
    for (const p of this.players) {
      if (p.holding < 0) continue;
      const v = this.getPlayer(p.holding);
      const w = p.weapons[p.active];
      const cfg = w ? WEAPONS[w.type].beam : undefined;
      if (!v || !v.alive || v.heldBy !== p.id || !p.alive || p.beamT <= 0 || !cfg) { this.letGo(p); continue; }
      const eye = eyePos(p), dir = aimDir(p.yaw, p.pitch);
      const want = v3(eye.x + dir.x * p.holdDist, eye.y + dir.y * p.holdDist - HOLD_CENTRE, eye.z + dir.z * p.holdDist);
      let move = vsub(want, v.pos);
      const len = vlen(move), max = cfg.carry * DT;
      if (len > max) move = vscale(move, max / len);
      const tr = this.world.traceBox(v.pos, vma(v.pos, move, 1), HULL.mins, v.crouched ? HULL.crouch : HULL.stand);
      v.vel = vscale(vsub(tr.end, v.pos), 1 / DT);
      vset(v.pos, tr.end);
      v.grounded = false;
      v.groundTime = 0;
      const mid = v3(v.pos.x, v.pos.y + HOLD_CENTRE, v.pos.z);
      if (v.pos.y < this.map.killY) { this.kill(v, p.id, w!.type); continue; }
      if (p.beamHurt) p.beamAcc += cfg.dps * DT; // the beam alone holds; both buttons burn
      if (p.beamAcc >= cfg.dps * 0.5) {
        const dmg = p.beamAcc;
        p.beamAcc = 0;
        this.applyDamage(v, dmg, p.id, w!.type, false, mid, v3(), true);
        if (!v.alive) continue;
      }
      if (this.world.traceRay(eye, mid).fraction < 0.98) this.letGo(p); // the beam is cut
    }
  }

  // ----------------------------------------------------- sudden-death zone
  private updateZone(): void {
    const z = this.rules.zone;
    if (!z) return;
    const t = this.roundTime - z.start;
    if (t < 0) { this.zone = null; return; }
    const k = Math.min(1, t / z.shrinkTime);
    // On a small map the zone starts just wide enough to take in its corners.
    const start = Math.min(z.startRadius, (this.map.extent ?? Infinity) * Math.SQRT2 + 2);
    const radius = start - (start - z.minRadius) * k;
    this.zone = { x: 0, z: 0, radius };
    if (this.tick % 30 !== 0) return;
    // Once fully shrunk for a while, nowhere is safe: the round WILL end.
    const everywhere = t > z.shrinkTime + 10;
    for (const p of this.players) {
      if (!p.alive || (!everywhere && Math.hypot(p.pos.x, p.pos.z) <= radius)) continue;
      this.applyDamage(p, z.damage * (1 + t / z.shrinkTime), -1, 'zone', false, v3(p.pos.x, p.pos.y + 1, p.pos.z), v3());
    }
  }

  // ------------------------------------------------------ lag compensation
  private recordHistory(): void {
    const s = new Map<number, HistState>();
    for (const p of this.players) if (p.alive) s.set(p.id, { x: p.pos.x, y: p.pos.y, z: p.pos.z, c: p.crouched });
    this.history.push({ tick: this.tick, s });
    if (this.history.length > NET.maxRewindTicks + 4) this.history.shift();
  }

  /** Where was this player at (fractional) tick `viewTick`? null = unknown, use the present. */
  private rewound(id: number, viewTick: number): HistState | null {
    const h = this.history;
    if (!h.length) return null;
    const vt = Math.max(this.tick - NET.maxRewindTicks, h[0].tick, Math.min(this.tick, viewTick));
    const i = Math.floor(vt) - h[0].tick;
    const a = h[i]?.s.get(id), b = h[i + 1]?.s.get(id);
    if (!a) return null;
    if (!b) return a;
    const f = vt - Math.floor(vt);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f, c: a.c };
  }

  /** Map lab free-fly: no collision, no gravity. */
  private fly(p: Player): void {
    const c = p.cmd;
    p.yaw = c.yaw; p.pitch = c.pitch;
    const speed = (c.buttons & BTN.CROUCH ? 40 : 14) * DT;
    const f = aimDir(c.yaw, c.pitch);
    const up = (c.buttons & BTN.JUMP ? 1 : 0) - (c.buttons & BTN.WALK ? 1 : 0);
    p.pos.x += (f.x * c.moveF + Math.cos(c.yaw) * c.moveR) * speed;
    p.pos.y += (f.y * c.moveF + up) * speed;
    p.pos.z += (f.z * c.moveF - Math.sin(c.yaw) * c.moveR) * speed;
    p.vel = v3();
    p.grounded = false;
  }

  // --------------------------------------------------------------- weapons
  private updateWeapons(p: Player): void {
    const b = p.cmd.buttons;
    p.aiming = isAiming(p, b);
    const edge = b & ~p.prevButtons;
    this.beamWas = p.beamT;
    p.beamT = 0;
    this.mirrorWas = p.mirrorT;
    p.mirrorT = 0;
    // A KI BLAST charge or beam only lasts while the KI BLAST is in hand.
    const inHand = p.weapons[p.active];
    if (!inHand || !WEAPONS[inHand.type].ki) { p.kiCharge = 0; p.kiFireT = 0; }
    p.beamHurt = false;
    this.shoutWas = p.shoutT;
    p.shoutT = 0;
    p.cooldown[0] -= DT;
    p.cooldown[1] -= DT;

    // A TIRADE that is running cannot be put away, thrown or traded: it fires until empty.
    const runaway = p.runawaySlot >= 0 && !!p.weapons[p.runawaySlot];
    if (!runaway) p.runawaySlot = -1;
    let want = p.active;
    if (edge & BTN.SLOT1) want = 0;
    if (edge & BTN.SLOT2) want = 1;
    if (edge & BTN.SWAP) want = p.active ^ 1;
    // The wheel switches weapons too, unless it is pushing / pulling someone held in a beam.
    if (clampWheel(p.cmd.wheel) && p.holding < 0) want = p.active ^ 1;
    if (runaway) want = p.active;
    if (want !== p.active) {
      p.active = want;
      if (!isDual(p)) {
        p.cooldown[want] = Math.max(p.cooldown[want], 0.22); // draw time
        p.burstLeft[0] = p.burstLeft[1] = 0;
        p.spin = 0;
      }
    }

    if (edge & BTN.THROW && p.weapons[p.active] && !runaway) {
      this.throwSlot(p, p.active);
      return;
    }

    if (isDual(p)) {
      // One weapon per hand, one button per weapon.
      this.useSlot(p, 0, (b & BTN.FIRE) !== 0, (edge & BTN.FIRE) !== 0, 0);
      if (p.alive) this.useSlot(p, 1, (b & BTN.FIRE2) !== 0, (edge & BTN.FIRE2) !== 0, 1);
    } else {
      this.useSlot(p, p.active, (b & BTN.FIRE) !== 0, (edge & BTN.FIRE) !== 0, -1);
    }
  }

  /** Run the trigger logic of one weapon slot. `hand`: -1 = the only weapon in use, 0 = left, 1 = right. */
  private useSlot(p: Player, slot: number, held: boolean, pressed: boolean, hand: number): void {
    const w = p.weapons[slot];
    const def = w ? WEAPONS[w.type] : WEAPONS.fists;
    // Guarding or winding up a special: the ordinary attack waits.
    if (p.specialT > 0 && hand < 0 && (def.special?.kind === 'guard' || def.special?.kind === 'charge')) return;
    if (w && def.beam) { this.useBeam(p, slot, w, held, pressed); return; }
    if (w && def.jet) { this.useJet(p, slot, w, held, pressed); return; }
    if (w && def.mirror) { this.useMirror(p, slot, w, held, pressed); return; }
    if (w && def.ki) { this.useKi(p, slot, w, held, pressed); return; }
    if (w && def.runaway) { this.useRunaway(p, slot, w, def, pressed, hand); return; }
    if (w && def.shout) { this.useShout(p, slot, w, def, held, pressed); return; }

    // The rest of a burst fires by itself.
    if (p.burstLeft[slot] > 0 && w && def.burst) {
      if ((p.burstTimer[slot] -= DT) <= 0) {
        if (w.ammo > 0) {
          if (!p.infiniteAmmo) w.ammo--;
          p.burstTimer[slot] = def.burst.interval;
          p.burstLeft[slot]--;
          this.fire(p, def, hand);
        } else p.burstLeft[slot] = 0;
      }
      return;
    }

    // Spin-up weapons only fire once the barrels are turning.
    if (def.spinUp) {
      const revving = held && !!w && w.ammo > 0;
      p.spin = revving ? Math.min(def.spinUp, p.spin + DT) : Math.max(0, p.spin - DT * 2);
      if (revving && p.spin < def.spinUp) return;
    } else if (hand < 0) p.spin = 0;

    if (held && p.cooldown[slot] <= 0 && (def.auto || pressed)) {
      if (w && w.ammo <= 0) {
        // Empty guns are ammunition too: pulling the trigger throws them.
        if (pressed) this.throwSlot(p, slot);
        else this.events.push({ t: 'empty', player: p.id });
        p.cooldown[slot] = Math.max(p.cooldown[slot], 0.2);
        return;
      }
      if (w && !p.infiniteAmmo) w.ammo--;
      p.cooldown[slot] = def.fireInterval;
      if (def.burst) { p.burstLeft[slot] = def.burst.count - 1; p.burstTimer[slot] = def.burst.interval; }
      this.fire(p, def, hand);
      // Grenades and mines are gone once the last one has left your hand.
      if (w && def.consumed && w.ammo <= 0) {
        p.weapons[slot] = null;
        if (slot === p.active && p.weapons[slot ^ 1]) p.active ^= 1;
      }
    }
  }

  /**
   * HECKLER: held, the megaphone is on (and drains). Every pulse it blasts a
   * cone of sound as strong as the holder is loud; everyone caught is shoved
   * back and up, hurt a little, and has their aim thrown about. A fall soon
   * after is the heckler's kill.
   */
  private useShout(p: Player, slot: number, w: WeaponInst, def: WeaponDef, held: boolean, pressed: boolean): void {
    const cfg = def.shout!;
    if (held && w.ammo <= 0) {
      if (pressed) this.throwSlot(p, slot);
      else if (p.cooldown[slot] <= 0) { this.events.push({ t: 'empty', player: p.id }); p.cooldown[slot] = 0.2; }
      return;
    }
    if (!held || (p.cooldown[slot] > 0 && this.shoutWas <= 0)) return; // off, or still being drawn
    p.shoutT = this.shoutWas + DT;
    if (!p.infiniteAmmo) w.ammo = Math.max(0, w.ammo - cfg.drain * DT);
    if (p.cooldown[slot] > 0) return;
    p.cooldown[slot] = def.fireInterval;
    const loud = clampLoud(p.cmd.loud);
    const power = loud < 0 ? cfg.noMic : loud;
    p.shoutPower = power;
    const eye = eyePos(p), dir = aimDir(p.yaw, p.pitch);
    this.events.push({ t: 'shout', player: p.id, origin: eye, dir, power });
    if (power < cfg.whisper) return; // a whisper: nothing happens
    const cosCone = Math.cos(cfg.cone * Math.PI / 180);
    for (const v of this.players) {
      if (v === p || !v.alive) continue;
      const mid = v3(v.pos.x, v.pos.y + HOLD_CENTRE, v.pos.z);
      const to = vsub(mid, eye), d = vlen(to);
      if (d > cfg.range || d < 1e-3 || vdot(to, dir) / d < cosCone) continue;
      if (this.world.traceRay(eye, mid).fraction < 0.98) continue; // behind a wall
      const k = power * (1 - (d / cfg.range) * 0.7); // weaker with distance, never nothing inside the range
      const push = vscale(dir, cfg.push * k);
      push.y += cfg.lift * k + 1.2; // always a little hop: on the ground, friction would eat the shove
      v.flungBy = p.id;
      v.flungT = cfg.credit;
      v.grounded = false;
      this.events.push({ t: 'shouted', attacker: p.id, victim: v.id, power: k });
      this.applyDamage(v, cfg.dps * def.fireInterval * k, p.id, def.id, false, mid, push, true);
    }
  }

  /**
   * TIRADE: one pull starts it and it fires every round it has, as fast as
   * it is due (several per tick if need be), whatever the trigger does. Empty,
   * it stops; pull again and it is thrown like any empty gun.
   */
  private useRunaway(p: Player, slot: number, w: WeaponInst, def: WeaponDef, pressed: boolean, hand: number): void {
    if (p.runawaySlot !== slot) {
      if (!pressed || p.cooldown[slot] > 0) return;
      if (w.ammo <= 0) { this.throwSlot(p, slot); return; }
      p.runawaySlot = slot;
      p.cooldown[slot] = 0;
    }
    for (let n = 0; p.cooldown[slot] <= 0 && w.ammo > 0 && n < 4; n++) {
      if (!p.infiniteAmmo) w.ammo--;
      p.cooldown[slot] += def.fireInterval;
      this.fire(p, def, hand);
      if (!p.alive) return; // it can kill you (a ricochet, a shove into the void)
    }
    if (w.ammo <= 0) {
      p.runawaySlot = -1;
      p.cooldown[slot] = Math.max(p.cooldown[slot], 0.4); // a beat of silence before the next pull throws it
      this.events.push({ t: 'empty', player: p.id });
    }
  }

  private fire(p: Player, def: WeaponDef, hand = -1): void {
    let o = eyePos(p);
    const dir = aimDir(p.yaw, p.pitch);
    if (def.fireball) {
      // SIX SEVEN: from one palm, then the other (by the rounds left, so it alternates by itself).
      // Never through a wall you are standing against: the palm stops short of it.
      const w = p.weapons[p.active];
      const side = w && w.ammo % 2 ? 1 : -1;
      hand = side < 0 ? 0 : 1;
      const palm = v3(o.x + Math.cos(p.yaw) * def.fireball.side * side, o.y + def.fireball.up, o.z - Math.sin(p.yaw) * def.fireball.side * side);
      const f = this.world.traceRay(o, palm).fraction;
      o = vma(o, vsub(palm, o), Math.max(0, f - 0.1));
    }
    this.events.push({ t: 'fire', player: p.id, weapon: def.id, origin: o, dir, hand });
    if (def.selfKnockback) {
      p.vel.x -= dir.x * def.selfKnockback; p.vel.y -= dir.y * def.selfKnockback; p.vel.z -= dir.z * def.selfKnockback;
    }

    if (def.kind === 'projectile') {
      const cfg = def.projectile!;
      this.projectiles.push({
        id: this.nextId++, kind: def.id, owner: p.id,
        pos: vcopy(o), prevPos: vcopy(o), vel: vma(vscale(dir, cfg.speed), p.vel, cfg.inherit ?? 0),
        life: cfg.fuse ?? 6, stuck: false, arm: cfg.armTime ?? 0, gen: 0, attached: -1, timer: 0,
      });
      return;
    }

    const melee = def.kind === 'melee';
    // Pellets are summed per victim so a shotgun blast is one hit event.
    const tally = new Map<Player, { dmg: number; head: boolean; pos: Vec3 }>();
    const tanks = new Set<Player>(); // AFTERBURN carriers shot in the tank
    for (let i = 0; i < def.pellets; i++) {
      const spread = def.spread * (p.aiming ? AIM.spread : 1);
      let d = spread > 0 ? this.spreadDir(dir, spread) : dir;
      let from = o;
      let left = def.range;
      let bounces = def.bounces ?? 0;
      let mult = 1;
      const pad = melee ? def.meleePad ?? 0.25 : 0;
      const pierced = new Set<Player>();
      for (let seg = 0; ; seg++) {
        let h = this.hitscan(p.id, from, d, left, pad, true, pierced, !melee);
        while (h.victim) {
          const base = def.gamble ? this.rng.range(def.gamble[0], def.gamble[1]) : def.damage;
          let dmg = base * mult * (h.head ? def.headMult : 1);
          if (def.falloff) {
            const [s, e, m] = def.falloff;
            dmg *= 1 - (1 - m) * Math.min(1, Math.max(0, (h.t - s) / (e - s)));
          }
          if (!melee && !h.head && this.inTheTank(p, h.victim, h.pos)) tanks.add(h.victim);
          const cur = tally.get(h.victim);
          if (cur) { cur.dmg += dmg; cur.head = cur.head || h.head; }
          else tally.set(h.victim, { dmg, head: h.head, pos: h.pos });
          if (!def.pierce) break;
          // Piercing: carry on through, looking for the next body or the wall behind.
          pierced.add(h.victim);
          h = this.hitscan(p.id, from, d, left, pad, true, pierced, !melee);
        }
        // Only the first segment starts at the shooter's muzzle; ricochets start at the wall.
        if (!melee) this.events.push({ t: 'tracer', player: seg === 0 ? p.id : -1, weapon: def.id, from, to: h.pos, hand });
        if (h.mirror) {
          // Into a REARVIEW field: the round stops there, carrying the damage it would have done.
          let dmg = (def.gamble ? this.rng.range(def.gamble[0], def.gamble[1]) : def.damage) * mult;
          if (def.falloff) {
            const [s0, e0, m0] = def.falloff;
            dmg *= 1 - (1 - m0) * Math.min(1, Math.max(0, (h.t - s0) / (e0 - s0)));
          }
          this.freeze(h.mirror, h.pos, d, WEAPONS.rearview.projectile!.speed, 'rearview', p.id, dmg);
          break;
        }
        if (h.victim) break;
        if (!h.hitWorld) break;
        this.events.push({ t: 'impact', pos: h.pos, normal: h.normal });
        if (bounces-- <= 0) break;
        // Ricochet: mirror the direction about the surface and carry on.
        d = vnorm(vma(d, h.normal, -2 * vdot(d, h.normal)));
        from = vma(h.pos, h.normal, 0.02);
        left -= h.t;
        mult += def.bounceBonus ?? 0;
      }
    }

    for (const [victim, t] of tally) {
      if (tanks.has(victim)) { this.blowTank(victim, p.id, t.pos); continue; }
      let dmg = t.dmg;
      if (def.backstab) {
        // From behind = the victim is facing roughly the same way the blow travels.
        const facing = aimDir(victim.yaw, 0);
        if (facing.x * dir.x + facing.z * dir.z > 0.4) dmg *= def.backstab;
      }
      let push = vscale(dir, def.knockback);
      push.y += def.knockUp ?? 0;
      if (def.reel) {
        // REELER: the line reels them all the way in, on an arc timed to come down `stop` m in front of us.
        // From far away the arc is higher instead of faster than `max`, so they always land at our feet.
        const dx = p.pos.x - victim.pos.x, dz = p.pos.z - victim.pos.z, d = Math.hypot(dx, dz);
        const gap = Math.max(0, d - def.reel.stop);
        const air = Math.max((2 * def.reel.lift) / MOVE.gravity, gap / def.reel.max); // time up and back down
        const lift = (air * MOVE.gravity) / 2, speed = gap / air;
        push = d > 0.01 ? v3((dx / d) * speed, lift, (dz / d) * speed) : v3(0, lift, 0);
        victim.vel = v3(); // whatever they were doing, the line wins
        victim.grounded = false;
        victim.launchTimer = air; // no steering out of it
      }
      if (def.stun) victim.stun = Math.max(victim.stun, def.stun);
      if (def.vsSoaked && victim.soaked > 0) dmg *= def.vsSoaked; // water conducts
      if (melee) dmg *= this.meleePower(def, p, victim, push, t.pos);
      this.applyDamage(victim, dmg, p.id, def.id, t.head, t.pos, push);
      if (def.swap && victim.alive && p.alive) this.swapPlaces(p, victim);
    }
  }

  /** Swap gun: the two players trade positions (and stances, so nobody ends up standing inside a low tunnel). */
  private swapPlaces(a: Player, b: Player): void {
    const pos = vcopy(a.pos), crouched = a.crouched;
    vset(a.pos, b.pos); a.crouched = b.crouched;
    vset(b.pos, pos); b.crouched = crouched;
    this.events.push({ t: 'swap', a: a.id, b: b.id });
    for (const p of [a, b]) {
      vset(p.prevPos, p.pos);
      p.teleTimer = 0.8;
      p.sliding = false;
      this.events.push({ t: 'tele', player: p.id, pos: vcopy(p.pos), speed: 0 });
    }
  }

  private spreadDir(dir: Vec3, deg: number): Vec3 {
    const up = Math.abs(dir.y) > 0.99 ? v3(1, 0, 0) : v3(0, 1, 0);
    const right = vnorm(vcross(dir, up));
    const upv = vcross(right, dir);
    const r = Math.tan((deg * Math.PI) / 180) * Math.sqrt(this.rng.next());
    const a = this.rng.next() * Math.PI * 2;
    return vnorm(vma(vma(dir, right, Math.cos(a) * r), upv, Math.sin(a) * r));
  }

  /**
   * Instant ray against the world and all player hit boxes.
   * With `rewind`, the other players are tested where the shooter SAW them
   * (cmd.viewTick) instead of where they are now: lag compensation.
   */
  private hitscan(shooter: number, o: Vec3, d: Vec3, range: number, pad: number, rewind = false, ignore?: Set<Player>, mirrors = false): Hit {
    const tr = this.world.traceRay(o, vma(o, d, range));
    let best = tr.fraction * range;
    let victim: Player | null = null;
    let head = false;
    const viewTick = rewind && this.rules.lagCompensation ? this.getPlayer(shooter)?.cmd.viewTick : undefined;
    for (const p of this.players) {
      if (!p.alive || p.id === shooter || ignore?.has(p)) continue;
      let x = p.pos.x, y = p.pos.y, z = p.pos.z, crouched = p.crouched;
      if (viewTick !== undefined) {
        const past = this.rewound(p.id, viewTick);
        if (past) { x = past.x; y = past.y; z = past.z; crouched = past.c; }
      }
      const h = crouched ? PLAYER.crouchHeight : PLAYER.height;
      const neck = y + h - PLAYER.headSize;
      const r = PLAYER.hitRadius + pad, hr = PLAYER.headRadius + pad;
      const tb = rayBox(o, d, x - r, y - pad, z - r, x + r, neck, z + r, best);
      const th = rayBox(o, d, x - hr, neck, z - hr, x + hr, y + h + 0.04 + pad, z + hr, best);
      let t = -1, isHead = false;
      if (th >= 0 && (tb < 0 || th <= tb)) { t = th; isHead = true; }
      else if (tb >= 0) t = tb;
      if (t >= 0 && t < best) { best = t; victim = p; head = isHead; }
    }
    // REARVIEW fields in the way stop the shot before anything behind them.
    let mirror: Player | undefined;
    if (mirrors) {
      for (const q of this.players) {
        if (q.id === shooter || q.mirrorT <= 0 || !q.alive) continue;
        const t = this.throughField(q, o, d, best);
        if (t >= 0) { best = t; mirror = q; victim = null; head = false; }
      }
    }
    return { t: best, pos: vma(o, d, best), victim, head, normal: tr.normal, hitWorld: !victim && !mirror && tr.fraction < 1, ...(mirror ? { mirror } : {}) };
  }

  /** Where (distance along the ray, within `max`) does it cross this player's REARVIEW field? -1 = it misses it. */
  private throughField(q: Player, o: Vec3, d: Vec3, max: number): number {
    const w = q.weapons[q.active];
    const cfg = w ? WEAPONS[w.type].mirror : undefined;
    if (!cfg) return -1;
    const n = aimDir(q.yaw, q.pitch);
    const c = vma(eyePos(q), n, cfg.distance);
    const den = vdot(d, n);
    if (Math.abs(den) < 1e-6) return -1;
    const t = vdot(vsub(c, o), n) / den;
    if (t < 0 || t >= max) return -1;
    return vlen(vsub(vma(o, d, t), c)) <= cfg.radius ? t : -1;
  }

  private applyDamage(
    v: Player, dmg: number, attacker: number, cause: KillCause, head: boolean, pos: Vec3, impulse: Vec3, dot = false,
  ): void {
    if (!v.alive) return;
    // FISTS guard: what comes from the front (the side the hit lands on) is mostly blocked.
    const guard = specialIn(v);
    if (guard?.kind === 'guard' && v.specialT > 0 && !dot) {
      const f = aimDir(v.yaw, 0);
      if ((pos.x - v.pos.x) * f.x + (pos.z - v.pos.z) * f.z > 0.05) {
        dmg *= 1 - guard.block;
        impulse = vscale(impulse, 0.25);
        this.events.push({ t: 'special', kind: 'guard', player: v.id, pos: vcopy(pos), power: 0 });
      }
    }
    // SLABRIDER: on the back wheel, you hit twice as hard and are hit twice as hard.
    const by = attacker !== v.id ? this.getPlayer(attacker) : undefined;
    if (by && by.wheelie && by.bikeT > 0) dmg *= BIKE.dealt;
    if (v.wheelie && v.bikeT > 0) dmg *= BIKE.taken;
    dmg = Math.round(dmg);
    // On a wheelie, any hit at all throws you off: tumbling head over heels, rolling away.
    if (v.bikeT > 0 && v.wheelie && dmg > 0 && v.health - dmg > 0) impulse = vadd(impulse, this.throwOff(v, pos));
    else if (v.bikeT > 0 && dmg >= BIKE.knockoff && v.health - dmg > 0) this.dropBike(v, 'knock');
    // SKYSWEEPER: one big enough hit and you are off it (it falls, still charged).
    if (v.broomT > 0 && dmg >= BROOM.knockoff && v.health - dmg > 0) this.dropBroom(v, 'knock');
    v.health -= dmg;
    if (dmg > 0) v.stillT = 0; // hurt: the wait for regeneration starts over
    v.vel.x += impulse.x; v.vel.y += impulse.y; v.vel.z += impulse.z;
    const killed = v.health <= 0;
    this.events.push({ t: 'hit', attacker, victim: v.id, damage: dmg, head, pos, killed, cause, ...(dot ? { dot } : {}) });
    if (killed) this.kill(v, attacker, cause);
  }

  private kill(v: Player, killer: number, cause: KillCause): void {
    // Dropped into the void, carried into the lava, flung out of the zone: the
    // beam's owner gets the kill.
    if (killer < 0 && ENVIRONMENT.includes(cause)) {
      if (v.heldBy >= 0) killer = v.heldBy;
      else if (v.flungT > 0) killer = v.flungBy;
    }
    if (v.holding >= 0) this.letGo(v);
    if (v.heldBy >= 0) {
      const h = this.getPlayer(v.heldBy);
      if (h) { h.holding = -1; h.beamAcc = 0; }
      v.heldBy = -1;
    }
    v.alive = false;
    v.health = 0;
    v.deaths++;
    v.burstLeft = [0, 0];
    // SKYSWEEPER: the broom falls where they were (the void and lava keep it).
    if (v.broomT > 0 && cause !== 'void' && cause !== 'lava') this.dropBroom(v, 'knock');
    if (v.bikeT > 0 && cause !== 'void' && cause !== 'lava') this.dropBike(v, 'knock'); // (the bike too)
    clearStatus(v);
    v.respawnTimer = v.bot ? this.rules.botRespawnDelay : this.rules.respawnDelay;
    const k = this.getPlayer(killer);
    if (k && k !== v) k.kills++;
    // Drop everything the victim carried (the void and lava keep what falls into them).
    if (!v.infiniteAmmo && cause !== 'void' && cause !== 'lava') {
      for (const w of v.weapons) {
        if (!w) continue;
        const vel = v3(this.rng.range(-2, 2), this.rng.range(3, 5), this.rng.range(-2, 2));
        this.spawnPickup(w, v3(v.pos.x, v.pos.y + 1, v.pos.z), vel, -1, false);
      }
    }
    v.weapons = [null, null];
    this.events.push({ t: 'kill', killer, victim: v.id, cause, pos: vcopy(v.pos) });
  }

  private throwSlot(p: Player, slot: number): void {
    const w = p.weapons[slot];
    if (!w) return;
    p.weapons[slot] = null;
    p.burstLeft[slot] = 0;
    const dir = aimDir(p.yaw, p.pitch);
    const vel = vma(vscale(dir, THROW.speed), p.vel, THROW.inheritVelocity);
    vel.y += 1.5;
    // Spawn inside the thrower's hull (always a valid spot); the thrower is immune.
    const pk = this.spawnPickup(w, eyePos(p), vel, p.id, true);
    pk.pos.y -= 0.2;
    if (slot === p.active && p.weapons[slot ^ 1]) p.active ^= 1;
    p.cooldown[0] = Math.max(p.cooldown[0], 0.25);
    p.cooldown[1] = Math.max(p.cooldown[1], 0.25);
    this.events.push({ t: 'throw', player: p.id });
  }

  private explode(pos: Vec3, owner: number, def: WeaponDef, festive = false): void {
    const pr = def.projectile!;
    this.events.push({ t: 'explosion', pos: vcopy(pos), radius: pr.splashRadius, ...(festive ? { festive } : {}), ...(def.fireball ? { fireball: true } : {}) });
    for (const p of this.players) {
      if (!p.alive) continue;
      const h = p.crouched ? PLAYER.crouchHeight : PLAYER.height;
      const c = v3(p.pos.x, p.pos.y + h * 0.5, p.pos.z);
      // distance to the closest point of the player's box
      const qx = Math.max(p.pos.x - PLAYER.radius, Math.min(pos.x, p.pos.x + PLAYER.radius));
      const qy = Math.max(p.pos.y, Math.min(pos.y, p.pos.y + h));
      const qz = Math.max(p.pos.z - PLAYER.radius, Math.min(pos.z, p.pos.z + PLAYER.radius));
      const d = Math.hypot(pos.x - qx, pos.y - qy, pos.z - qz);
      if (d >= pr.splashRadius) continue;
      if (this.world.traceRay(pos, c).fraction < 0.98) continue; // behind cover
      const f = 1 - d / pr.splashRadius;
      let dmg = pr.splashDamage * f;
      if (p.id === owner) dmg *= pr.selfDamageScale;
      const push = vnorm(vsub(c, pos));
      this.applyDamage(p, dmg, owner, def.id, false, c, vscale(push, pr.splashKnockback * (0.4 + 0.6 * f)));
    }
  }

  // ----------------------------------------------------------- projectiles
  /** Rockets, bouncing grenades and sticky mines. What each does is entirely described by its weapon's `projectile` block. */
  private updateProjectiles(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      const def = WEAPONS[pr.kind];
      const cfg = def.projectile!;
      vset(pr.prevPos, pr.pos);
      if ((pr.frozenBy ?? -1) >= 0) continue; // held in a REARVIEW field: time stands still for it
      pr.life -= DT;
      pr.arm = Math.max(0, pr.arm - DT);
      let boom = pr.life <= 0;

      if (pr.attached >= 0) {
        // Hot potato: rides on its victim, and jumps to anyone they manage to touch.
        const host = this.getPlayer(pr.attached);
        if (!host?.alive) pr.attached = -1;
        else {
          pr.pos = v3(host.pos.x, host.pos.y + 1.15, host.pos.z);
          pr.vel = v3();
          if (pr.arm <= 0) {
            for (const q of this.players) {
              if (q === host || !q.alive || Math.hypot(q.pos.x - host.pos.x, q.pos.y - host.pos.y, q.pos.z - host.pos.z) > 1.3) continue;
              pr.attached = q.id;
              pr.arm = 0.6;
              this.events.push({ t: 'thud', pos: vcopy(pr.pos) });
              break;
            }
          }
        }
      } else if (pr.stuck) {
        // Attached to (or lying on) a surface: stay with it if it moves, drop if it goes away.
        const tr = this.world.traceBox(pr.pos, pr.pos, STICK_MIN, STICK_MAX);
        if (!tr.startSolid) pr.stuck = false;
        else if (tr.brush?.mover) { const d = tr.brush.delta; pr.pos.x += d.x; pr.pos.y += d.y; pr.pos.z += d.z; }
      } else {
        if ((pr.homeOn ?? -1) >= 0) this.homeIn(pr); // bounced back off a REARVIEW: guided, no gravity
        else pr.vel.y -= cfg.gravity * DT;
        const step = vlen(pr.vel) * DT;
        if (step > 1e-7 && this.catchProjectile(pr, step)) continue;
        if (step > 1e-7) {
          const dir = vscale(pr.vel, DT / step);
          const h = this.hitscan(pr.owner, pr.pos, dir, step, 0.12);
          if (h.victim && cfg.stickPlayers) {
            pr.attached = h.victim.id;
            pr.arm = 0.6;
            this.events.push({ t: 'thud', pos: vcopy(h.pos) });
          } else if (h.victim && cfg.contact) {
            const dmg = pr.damage ?? def.damage;
            if (dmg) this.applyDamage(h.victim, dmg, pr.owner, def.id, false, h.pos, v3());
            vset(pr.pos, vma(h.pos, dir, -0.1));
            boom = true;
          } else if (h.victim) {
            // thuds off a body and drops
            pr.vel = v3(-pr.vel.x * 0.25, Math.min(pr.vel.y, 0) * 0.25, -pr.vel.z * 0.25);
          } else if (h.hitWorld) {
            vset(pr.pos, vma(h.pos, h.normal, 0.02));
            if (cfg.sticky) {
              pr.stuck = true;
              pr.vel = v3();
              this.events.push({ t: 'thud', pos: vcopy(pr.pos) });
            } else if (cfg.bounce !== undefined) {
              const into = vdot(pr.vel, h.normal);
              pr.vel = vscale(vma(pr.vel, h.normal, -(1 + cfg.bounce) * into), 0.78);
              const speed = vlen(pr.vel);
              if (speed > 2) this.events.push({ t: 'thud', pos: vcopy(pr.pos) });
              if (h.normal.y > 0.7 && speed < 1.4) { pr.stuck = true; pr.vel = v3(); } // comes to rest
            } else {
              vset(pr.pos, vma(h.pos, dir, -0.1)); // back off the wall so the blast is not swallowed by it
              boom = true;
            }
          } else {
            vset(pr.pos, h.pos);
          }
        }
        if (pr.pos.y < this.map.killY) { this.projectiles.splice(i, 1); continue; }
      }

      // Traps: armed, in place, waiting.
      const trap = cfg.trap;
      if (trap && !boom && pr.stuck && pr.arm <= 0) {
        if (trap.type === 'sentry') {
          // Shoots the nearest visible player who is not its owner.
          if ((pr.timer -= DT) <= 0) {
            pr.timer = trap.interval ?? 0.25;
            const eye = v3(pr.pos.x, pr.pos.y + 0.45, pr.pos.z);
            let target: Player | null = null;
            let best = trap.radius;
            for (const p of this.players) {
              if (!p.alive || p.id === pr.owner) continue;
              const c = v3(p.pos.x, p.pos.y + (p.crouched ? 0.6 : 1), p.pos.z);
              const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
              if (d < best && this.world.traceRay(eye, c).fraction > 0.98) { best = d; target = p; }
            }
            if (target) {
              const c = v3(target.pos.x, target.pos.y + (target.crouched ? 0.6 : 1), target.pos.z);
              const dir = vnorm(vsub(c, eye));
              this.events.push({ t: 'fire', player: -1, weapon: def.id, origin: eye, dir, hand: -1 });
              this.events.push({ t: 'tracer', player: -1, weapon: def.id, from: eye, to: c, hand: -1 });
              this.applyDamage(target, trap.damage, pr.owner, def.id, false, c, vscale(dir, 0.3));
            }
          }
        } else if (trap.type === 'fire') {
          // A burning patch: everyone standing in it burns. Whoever dropped it
          // too, once it has been burning for a moment (time enough to fly off it).
          if ((pr.timer -= DT) <= 0) {
            pr.timer = trap.interval ?? 0.25;
            const ownerSafe = (cfg.fuse ?? 3) - pr.life < FIRE_OWNER_GRACE;
            for (const p of this.players) {
              if (!p.alive || (p.id === pr.owner && ownerSafe)) continue;
              if (Math.hypot(p.pos.x - pr.pos.x, p.pos.z - pr.pos.z) > trap.radius || p.pos.y > pr.pos.y + 1.5 || p.pos.y < pr.pos.y - 1) continue;
              this.applyDamage(p, trap.damage, pr.owner, def.id, false, v3(p.pos.x, p.pos.y + 0.4, p.pos.z), v3(), true);
            }
          }
        } else if (pr.gen === 2) {
          // An open gas canister: everyone inside the cloud chokes, owner included.
          if ((pr.timer -= DT) <= 0) {
            pr.timer = 0.5;
            for (const p of this.players) {
              if (!p.alive) continue;
              const c = v3(p.pos.x, p.pos.y + 0.9, p.pos.z);
              if (Math.hypot(c.x - pr.pos.x, c.y - pr.pos.y, c.z - pr.pos.z) < (trap.area ?? 4)) {
                this.applyDamage(p, trap.damage, pr.owner, def.id, false, c, v3());
              }
            }
          }
        } else {
          // Waiting for a foot. Distance is measured to the nearest point of the player's body.
          let victim: Player | null = null;
          for (const p of this.players) {
            if (!p.alive) continue;
            const h = p.crouched ? PLAYER.crouchHeight : PLAYER.height;
            const qx = Math.max(p.pos.x - PLAYER.radius, Math.min(pr.pos.x, p.pos.x + PLAYER.radius));
            const qy = Math.max(p.pos.y, Math.min(pr.pos.y, p.pos.y + h));
            const qz = Math.max(p.pos.z - PLAYER.radius, Math.min(pr.pos.z, p.pos.z + PLAYER.radius));
            if (Math.hypot(pr.pos.x - qx, pr.pos.y - qy, pr.pos.z - qz) < trap.radius) { victim = p; break; }
          }
          if (victim) {
            this.events.push({ t: 'trap', weapon: def.id, victim: victim.id, pos: vcopy(pr.pos) });
            if (trap.type === 'gas') {
              pr.gen = 2; // now a cloud
              pr.life = trap.duration ?? 6;
              pr.timer = 0;
            } else {
              if (trap.type === 'snap') {
                if (trap.damage) this.applyDamage(victim, trap.damage, pr.owner, def.id, false, vcopy(victim.pos), v3());
                victim.rooted = Math.max(victim.rooted, trap.root ?? 2);
                victim.vel = v3();
              } else {
                victim.vel = v3(this.rng.range(-3, 3), trap.launch ?? 18, this.rng.range(-3, 3));
                victim.grounded = false;
              }
              this.projectiles.splice(i, 1); // spent
              continue;
            }
          }
        }
      }

      // Proximity fuse: anyone at all, once armed. Mines have no friends.
      if (!boom && cfg.proximity && pr.arm <= 0) {
        for (const p of this.players) {
          if (!p.alive) continue;
          const c = v3(p.pos.x, p.pos.y + 0.9, p.pos.z);
          if (Math.hypot(c.x - pr.pos.x, c.y - pr.pos.y, c.z - pr.pos.z) < cfg.proximity && this.world.traceRay(pr.pos, c).fraction > 0.98) {
            boom = true;
            break;
          }
        }
      }

      if (boom) {
        if (cfg.splashRadius > 0) this.explode(pr.pos, pr.owner, def, def.id === 'pinata' && pr.gen === 1); // bomblets party too
        else this.events.push({ t: 'impact', pos: vcopy(pr.pos), normal: v3(0, 1, 0) }); // a bolt just stops
        this.projectiles.splice(i, 1);
        if (cfg.cluster && pr.gen === 0) {
          if (def.id === 'pinata') this.events.push({ t: 'party', pos: vcopy(pr.pos) });
          for (let n = 0; n < cfg.cluster; n++) {
            const at = v3(pr.pos.x, pr.pos.y + 0.25, pr.pos.z);
            this.projectiles.push({
              id: this.nextId++, kind: pr.kind, owner: pr.owner, pos: at, prevPos: vcopy(at),
              vel: v3(this.rng.range(-6, 6), this.rng.range(6, 10), this.rng.range(-6, 6)),
              life: this.rng.range(0.7, 1.2), stuck: false, arm: 0, gen: 1, attached: -1, timer: 0,
            });
          }
        }
      }
    }
  }

  // --------------------------------------------------------------- pickups
  private spawnPickup(w: WeaponInst, pos: Vec3, vel: Vec3, owner: number, lethal: boolean): Pickup {
    const pk: Pickup = {
      id: this.nextId++, weapon: w, pos: vcopy(pos), prevPos: vcopy(pos), vel: vcopy(vel),
      resting: false, lethal, owner, ownerTimer: owner >= 0 ? 0.8 : 0, age: 0, spawner: -1,
    };
    this.pickups.push(pk);
    return pk;
  }

  private spawnFromSpawner(i: number): void {
    const s = this.map.pickups[i];
    const pk = this.spawnPickup({ type: s.weapon, ammo: WEAPONS[s.weapon].ammo }, s.pos, v3(), -1, false);
    pk.resting = true;
    pk.spawner = i;
    this.spawners[i].pickupId = pk.id;
  }

  private updatePickups(): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      vset(pk.prevPos, pk.pos);
      pk.ownerTimer = Math.max(0, pk.ownerTimer - DT);
      if (pk.resting) {
        if (pk.spawner < 0 && this.world.movers.length) {
          // Dropped weapons ride platforms and fall when the floor leaves.
          const tr = this.world.traceBox(v3(pk.pos.x, pk.pos.y + 0.05, pk.pos.z), v3(pk.pos.x, pk.pos.y - 0.12, pk.pos.z), ITEM_MINS, ITEM_MAXS);
          if (tr.fraction === 1 && !tr.startSolid) { pk.resting = false; continue; }
          const d = tr.brush?.mover ? tr.brush.delta : null;
          if (d) { pk.pos.x += d.x; pk.pos.y += d.y; pk.pos.z += d.z; }
        }
        pk.age += DT;
        const limit = pk.weapon.ammo > 0 ? PICKUP.despawn : PICKUP.emptyDespawn;
        if (pk.spawner < 0 && pk.age > limit) this.pickups.splice(i, 1);
        continue;
      }
      pk.vel.y -= THROW.gravity * DT;
      const next = vma(pk.pos, pk.vel, DT);

      if (pk.lethal) {
        const d = vsub(next, pk.pos);
        const len = vlen(d);
        const h = len > 1e-6 ? this.hitscan(pk.owner, pk.pos, vscale(d, 1 / len), len, 0.2) : null;
        if (h?.victim) {
          const def = WEAPONS[pk.weapon.type];
          const push = vscale(vnorm(v3(pk.vel.x, 0, pk.vel.z)), THROW.knockback);
          h.victim.stun = Math.max(h.victim.stun, def.throwStun);
          this.applyDamage(h.victim, def.throwDamage, pk.owner, 'throw', h.head, h.pos, push);
          pk.lethal = false;
          pk.vel = v3(-pk.vel.x * 0.15, 3, -pk.vel.z * 0.15);
          continue;
        }
      }

      const tr = this.world.traceBox(pk.pos, next, ITEM_MINS, ITEM_MAXS);
      vset(pk.pos, tr.end);
      if (tr.allSolid) { pk.resting = true; pk.lethal = false; continue; }
      if (tr.fraction < 1) {
        pk.lethal = false;
        const into = vdot(pk.vel, tr.normal);
        pk.vel = vscale(vma(pk.vel, tr.normal, -(1 + THROW.bounce) * into), 0.6);
        if (vlen(pk.vel) > 1.5) this.events.push({ t: 'thud', pos: vcopy(pk.pos) });
        if (tr.normal.y > 0.7 && vlen(pk.vel) < 2.2) { pk.resting = true; pk.vel = v3(); }
      }
      if (pk.pos.y < this.map.killY) this.pickups.splice(i, 1);
    }

    if (this.rules.respawnPickups) {
      this.spawners.forEach((s, i) => {
        if (s.pickupId >= 0) {
          const pk = this.pickups.find((x) => x.id === s.pickupId);
          if (!pk || pk.spawner !== i) { s.pickupId = -1; s.timer = this.rules.pickupRespawn; }
        } else if ((s.timer -= DT) <= 0) {
          this.spawnFromSpawner(i);
        }
      });
    }
  }

  private updatePickupInteraction(p: Player): void {
    p.nearPickup = -1;
    if (p.bot) return;
    const free = p.weapons[p.active] === null ? p.active : p.weapons[p.active ^ 1] === null ? p.active ^ 1 : -1;
    const useEdge = (p.cmd.buttons & ~p.prevButtons & BTN.USE) !== 0 && p.runawaySlot < 0; // a running TIRADE cannot be swapped away
    let nearest: Pickup | null = null;
    let nearestD = Infinity;

    for (const pk of this.pickups) {
      if (pk.lethal || (pk.owner === p.id && pk.ownerTimer > 0)) continue;
      const d = Math.hypot(pk.pos.x - p.pos.x, pk.pos.z - p.pos.z);
      const dy = pk.pos.y - p.pos.y;
      if (d > PICKUP.radius || dy < -0.6 || dy > PICKUP.height) continue;
      const vehicle = WEAPONS[pk.weapon.type].category === 'vehicle';
      if (vehicle && (p.broomT > 0 || p.bikeT > 0 || p.tumbleT > 0)) continue; // one ride at a time (and not mid-tumble)
      // Walk-over pickup: only loaded weapons and only into a free hand (a broom is mounted with use).
      if (free >= 0 && pk.weapon.ammo > 0 && !vehicle) {
        this.take(p, pk, free);
        return;
      }
      if (d < nearestD) { nearestD = d; nearest = pk; }
    }

    if (nearest && WEAPONS[nearest.weapon.type].category === 'vehicle') {
      // SKYSWEEPER: climb on. Your hands stay as they are.
      p.nearPickup = nearest.id;
      if (useEdge) {
        if (nearest.spawner >= 0) nearest.spawner = -2;
        this.pickups.splice(this.pickups.indexOf(nearest), 1);
        if (nearest.weapon.type === 'slabrider') {
          // SLABRIDER: astride it, engine running.
          p.bikeT = nearest.weapon.ammo / 10;
          p.wheelie = false;
          this.events.push({ t: 'bike', kind: 'mount', player: p.id, pos: vcopy(p.pos) });
        } else {
          p.broomT = nearest.weapon.ammo / 10;
          p.broomGlide = 0;
          p.vel.y = Math.max(p.vel.y, 2); // a little hop up as it lifts off
          this.events.push({ t: 'broom', kind: 'mount', player: p.id, pos: vcopy(p.pos) });
        }
      }
      return;
    }
    if (!nearest && useEdge && p.broomT > 0) { this.dropBroom(p, 'dismount'); return; } // nothing to pick up: use gets you off the broom
    if (!nearest && useEdge && p.bikeT > 0) { this.dropBike(p, 'dismount'); return; } // ...or off the bike
    if (nearest) {
      p.nearPickup = nearest.id;
      if (useEdge) {
        const slot = free >= 0 ? free : p.active;
        const old = p.weapons[slot];
        if (old) {
          const fwd = aimDir(p.yaw, 0);
          this.spawnPickup(old, v3(p.pos.x, p.pos.y + 0.9, p.pos.z), v3(fwd.x * 3, 2.5, fwd.z * 3), p.id, false);
        }
        this.take(p, nearest, slot);
      }
    }
  }

  /**
   * SKYSWEEPER: off the broom (got off, or knocked off). You drift down for a
   * moment; the broom falls where you were, with its charge, for anyone to take
   * (if there is little enough left, it just crumbles).
   */
  private dropBroom(p: Player, kind: 'dismount' | 'knock'): void {
    const left = p.broomT;
    p.broomT = 0;
    p.broomGlide = BROOM.glide;
    this.events.push({ t: 'broom', kind, player: p.id, pos: vcopy(p.pos) });
    if (left < BROOM.minDrop) return;
    const pk = this.spawnPickup({ type: 'skysweeper', ammo: Math.round(left * 10) }, v3(p.pos.x, p.pos.y + 0.6, p.pos.z), v3(p.vel.x * 0.5, 1, p.vel.z * 0.5), p.id, false);
    pk.ownerTimer = Math.max(pk.ownerTimer, 1); // not straight back on by accident
  }

  /**
   * SLABRIDER: off the bike (got off, or knocked off). It stays where you were, with
   * its fuel, for anyone to take (if there is little enough left, it is a wreck).
   */
  private dropBike(p: Player, kind: 'dismount' | 'knock'): void {
    const left = p.bikeT;
    p.bikeT = 0;
    p.wheelie = false;
    this.events.push({ t: 'bike', kind, player: p.id, pos: vcopy(p.pos) });
    if (left < BIKE.minDrop) return;
    const pk = this.spawnPickup({ type: 'slabrider', ammo: Math.round(left * 10) }, v3(p.pos.x, p.pos.y + 0.3, p.pos.z), v3(p.vel.x * 0.5, 0, p.vel.z * 0.5), p.id, false);
    pk.ownerTimer = Math.max(pk.ownerTimer, 1); // not straight back on by accident
  }

  /** SLABRIDER: hit on a wheelie, off you fly. Returns the throw (away from the hit, and up). */
  private throwOff(p: Player, from: Vec3): Vec3 {
    this.dropBike(p, 'knock');
    p.tumbleT = BIKE.tumble;
    this.events.push({ t: 'bike', kind: 'thrown', player: p.id, pos: vcopy(p.pos) });
    let ax = p.pos.x - from.x, az = p.pos.z - from.z;
    let l = Math.hypot(ax, az);
    if (l < 0.2) { ax = -p.vel.x; az = -p.vel.z; l = Math.hypot(ax, az); } // hit from right here: off the back
    if (l < 0.2) { ax = Math.sin(p.yaw); az = Math.cos(p.yaw); l = 1; }
    p.grounded = false;
    return v3((ax / l) * BIKE.tumbleThrow, BIKE.tumbleUp, (az / l) * BIKE.tumbleThrow);
  }

  private take(p: Player, pk: Pickup, slot: number): void {
    p.weapons[slot] = pk.weapon;
    if (pk.spawner >= 0) pk.spawner = -2; // detach so the spawner starts its timer
    this.pickups.splice(this.pickups.indexOf(pk), 1);
    p.cooldown[slot] = Math.max(p.cooldown[slot], 0.22);
    this.events.push({ t: 'pickup', player: p.id, weapon: pk.weapon.type });
  }

  // ------------------------------------------------------------------ bots
  /** Practice dummies. They produce InputCmds exactly like a remote player would. */
  private botThink(p: Player): InputCmd {
    const cmd: InputCmd = { seq: this.tick, buttons: 0, moveF: 0, moveR: 0, yaw: p.spawn?.yaw ?? p.yaw, pitch: 0 };
    if (p.bot === 'strafe') {
      cmd.moveR = Math.floor(this.tick / 90) % 2 === 0 ? 1 : -1;
      cmd.buttons |= BTN.WALK;
    } else if (p.bot === 'turret') {
      const eye = eyePos(p);
      let target: Player | null = null;
      let bestD = TURRET_RANGE;
      for (const o of this.players) {
        if (o.bot || !o.alive) continue;
        const c = v3(o.pos.x, o.pos.y + 1, o.pos.z);
        const d = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
        if (d < bestD && this.world.traceRay(eye, c).fraction >= 0.999) { bestD = d; target = o; }
      }
      if (target) {
        const dx = target.pos.x - eye.x, dy = target.pos.y + 1 - eye.y, dz = target.pos.z - eye.z;
        const err = 0.07; // radians of aim noise
        cmd.yaw = Math.atan2(-dx, -dz) + this.rng.range(-err, err);
        cmd.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + this.rng.range(-err, err);
        if (this.tick % 80 === 0) cmd.buttons |= BTN.FIRE;
      } else {
        cmd.yaw = p.yaw;
      }
    }
    return cmd;
  }
}
