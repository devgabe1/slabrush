import type { Vec3 } from '../core/vec';
import type { WeaponId } from '../config/weapons';
import type { BotKind, Surface } from './map';

// Input buttons, packed in a bitmask so an input command is tiny on the wire.
export const BTN = {
  JUMP: 1,
  CROUCH: 2,
  WALK: 4,
  FIRE: 8,
  THROW: 16,
  USE: 32,
  SLOT1: 64,
  SLOT2: 128,
  SWAP: 256,
  FIRE2: 512, // second fire button: the right-hand weapon while dual wielding
  DUCK: 1024, // crouch without ever sliding (CROUCH slides when you are fast)
} as const;

/** One tick of player input. In Phase 2 clients send these to the host. */
export interface InputCmd {
  seq: number;
  buttons: number;
  moveF: number; // -1..1
  moveR: number; // -1..1
  yaw: number;
  pitch: number;
  /**
   * Server tick the client was looking at when it produced this input (the
   * interpolated past it renders other players in). The host rewinds hit
   * boxes to this tick for lag compensation. Undefined for the host itself.
   */
  viewTick?: number;
  /**
   * Mouse wheel notches this input (+ = scrolled up / away, - = down / towards
   * you). Holding someone in a MONOLOGUE beam it pushes them away or pulls them
   * in; otherwise any notch switches weapons. Absent = no scrolling.
   */
  wheel?: number;
}

export const emptyCmd = (): InputCmd => ({ seq: 0, buttons: 0, moveF: 0, moveR: 0, yaw: 0, pitch: 0 });

export interface WeaponInst {
  type: WeaponId;
  ammo: number;
}

export interface Player {
  id: number;
  name: string;
  color: number;
  look: number[]; // [face, torso, legs]: cosmetic only, see config/looks.ts
  bot: BotKind | null;
  spawn: { pos: Vec3; yaw: number } | null; // fixed spawn (bots)

  // --- movement state (everything pmove reads/writes) ---
  pos: Vec3; // feet centre
  prevPos: Vec3; // position at the previous tick, for render interpolation
  vel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  groundNormal: Vec3;
  groundSurface: Surface;
  crouched: boolean;
  sliding: boolean;
  slideBoostTimer: number;
  wallJumpsLeft: number;
  wallJumpTimer: number;
  groundTime: number; // seconds spent on the ground since landing (0 in the air); decides whether a jump is a hop
  rooted: number; // seconds left caught in a trap: no walking, no jumping
  launchTimer: number; // air steering is off until this runs out (set by jump pads)
  teleTimer: number; // teleporters ignore you until this runs out
  landSpeed: number;
  stun: number;
  prevButtons: number;

  // --- combat state ---
  /** Holding the aim button with an aimable weapon in hand (see isAiming). Drawn for everyone. */
  aiming: boolean;

  // --- melee status effects ---
  bleed: number; // seconds of bleeding left (SHIV)
  bleedStacks: number;
  bleedBy: number; // who gets the kill if it finishes them
  bleedAcc: number; // bleed damage not yet applied (it lands in chunks)
  soaked: number; // seconds left drenched (FISH): icy footing
  batted: number; // seconds a wall impact still counts (SLUGGER)
  battedBy: number;
  comboTarget: number; // FISTS: who the current combo is on
  comboCount: number;
  comboTimer: number;

  /** TIRADE: the slot whose runaway trigger is firing (it will not stop until empty), or -1. */
  runawaySlot: number;

  // --- the grabbing beam (MONOLOGUE) ---
  beamT: number; // seconds this player's beam has been on (0 = off)
  beamHurt: boolean; // both fire buttons down: the beam burns whoever it holds
  beamAcc: number; // beam damage not yet applied (it lands in chunks)
  holding: number; // id of the player held in this player's beam, or -1
  holdDist: number; // how far in front of the eyes they are held
  heldBy: number; // id of whoever holds this player in a beam, or -1: frozen, carried
  flungBy: number; // who last let go of this player: a fatal fall soon after is their kill
  flungT: number; // seconds that still counts
  health: number;
  alive: boolean;
  respawnTimer: number;
  weapons: (WeaponInst | null)[];
  active: number;
  /** Per weapon slot, so two dual-wielded weapons fire independently. */
  cooldown: number[];
  burstLeft: number[]; // shots still to come from the current burst
  burstTimer: number[];
  spin: number; // how long a spin-up weapon has been revving
  infiniteAmmo: boolean;
  nearPickup: number; // id of the pickup the USE key would grab, or -1
  noclip: boolean; // map lab free-fly
  kills: number;
  deaths: number;

  cmd: InputCmd;
  /**
   * Remote players only (set by the host every tick): the inputs to run this
   * tick. Usually one; none if nothing has arrived yet (the player simply
   * waits); several when catching up after a hiccup. Running exactly the
   * inputs the client sent, no more and no fewer, is what keeps the client's
   * prediction and the host in agreement. null = run `cmd` once (host player, bots, offline).
   */
  batch: InputCmd[] | null;
}

/** A weapon lying in the world, or flying through it after being thrown. */
export interface Pickup {
  id: number;
  weapon: WeaponInst;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  resting: boolean;
  lethal: boolean; // true while a thrown weapon can still hurt
  owner: number; // who threw/dropped it
  ownerTimer: number; // owner cannot auto-pickup until this runs out
  age: number; // seconds resting
  spawner: number; // index into map.pickups, or -1
}

export interface Projectile {
  id: number;
  kind: WeaponId;
  owner: number;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  life: number; // fuse
  stuck: boolean; // attached to / resting on a surface
  arm: number; // seconds until a proximity fuse goes live (also: cooldown before a hot potato can be passed on)
  gen: number; // 0 = fired by a weapon, 1 = a bomblet from a cluster
  attached: number; // id of the player it is stuck to, or -1
  timer: number; // traps: time until the next shot / damage tick
}

export type KillCause = WeaponId | 'void' | 'throw' | 'zone' | 'left' | 'lava' | 'crush';

/** Sudden-death zone: outside the circle hurts. */
export interface Zone {
  x: number;
  z: number;
  radius: number;
}

/**
 * Things that happened during a tick. The sim only produces state + events;
 * the client turns events into sounds, particles and HUD feedback. In Phase 2
 * the host forwards them to the other peers.
 */
export type SimEvent =
  | { t: 'fire'; player: number; weapon: WeaponId; origin: Vec3; dir: Vec3; hand: number } // hand: -1 single, 0 left, 1 right
  | { t: 'tracer'; player: number; weapon: WeaponId; from: Vec3; to: Vec3; hand: number } // player -1: a ricochet segment
  | { t: 'impact'; pos: Vec3; normal: Vec3 }
  | { t: 'hit'; attacker: number; victim: number; damage: number; head: boolean; pos: Vec3; killed: boolean; dot?: boolean; cause?: KillCause } // dot: damage over time (bleeding), no hitmarker; cause: what did it
  | { t: 'status'; kind: 'bleed' | 'soak' | 'splat' | 'combo'; attacker: number; victim: number; pos: Vec3 } // a melee power went off
  | { t: 'kill'; killer: number; victim: number; cause: KillCause; pos: Vec3 }
  | { t: 'explosion'; pos: Vec3; radius: number; festive?: boolean } // festive: a PINATA bomblet (party sounds)
  | { t: 'jump' | 'land' | 'walljump' | 'slide' | 'pad' | 'tele'; player: number; pos: Vec3; speed: number }
  | { t: 'pickup'; player: number; weapon: WeaponId }
  | { t: 'throw'; player: number }
  | { t: 'empty'; player: number }
  | { t: 'respawn'; player: number; yaw: number }
  | { t: 'thud'; pos: Vec3 }
  | { t: 'trap'; weapon: WeaponId; victim: number; pos: Vec3 } // a trap went off on someone
  | { t: 'swap'; a: number; b: number } // swap gun: a hit b, they traded places
  | { t: 'beam'; kind: 'grab' | 'drop' | 'fling'; player: number; victim: number; pos: Vec3 } // MONOLOGUE
  | { t: 'party'; pos: Vec3 }; // a PINATA burst open
