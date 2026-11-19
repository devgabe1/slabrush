import type { Vec3 } from '../core/vec';
import type { WeaponId } from '../config/weapons';

// Data-only map description. The generator outputs exactly this structure
// from a seed, so every peer can rebuild an identical map locally.
export type MatId = 'concrete' | 'concreteDark' | 'tile' | 'metal' | 'hazard' | 'ice' | 'conveyor' | 'lava';
/** What standing on a brush does. 'deadly' kills on contact. */
export type Surface = 'normal' | 'ice' | 'conveyor' | 'deadly';
/** Which side of a ramp is the high one. */
export type RampDir = '+x' | '-x' | '+z' | '-z';
export type BotKind = 'static' | 'strafe' | 'turret';

/**
 * A brush that travels back and forth along (dx,dy,dz). Its position is a
 * pure function of the simulation tick, so every peer (and client-side
 * prediction) computes it without any state to synchronise.
 * Cycle: wait at start (waitA) -> move -> wait at end (waitB) -> move back.
 */
export interface MoverDef {
  dx: number;
  dy: number;
  dz: number;
  moveTime: number; // seconds for one trip
  waitA: number;
  waitB: number;
  phase: number; // seconds of offset into the cycle
}

export interface Solid {
  type: 'box' | 'ramp';
  min: Vec3;
  max: Vec3;
  high?: RampDir; // ramps only
  mat: MatId;
  surface?: Surface;
  push?: Vec3; // conveyor velocity (m/s)
  mover?: MoverDef; // moving platform / elevator / door
}

/** Axis-aligned trigger volumes. */
export type Trigger =
  | { type: 'jumppad'; min: Vec3; max: Vec3; vel: Vec3 } // sets your velocity
  | { type: 'teleporter'; min: Vec3; max: Vec3; dest: Vec3; pair: number } // moves you, keeps velocity
  | { type: 'lowgrav'; min: Vec3; max: Vec3; scale: number } // gravity multiplier while inside
  | { type: 'dark'; min: Vec3; max: Vec3 }; // visual only

export interface Palette {
  sky: number;
  fogNear: number;
  fogFar: number;
  sun: number;
  ambientSky: number;
  ambientGround: number;
  mats: Record<MatId, string>; // base colour (hex) of each procedural texture
}

export interface MapDef {
  name: string;
  seed: number;
  solids: Solid[];
  triggers: Trigger[];
  spawns: { pos: Vec3; yaw: number }[];
  pickups: { pos: Vec3; weapon: WeaponId }[];
  bots: { pos: Vec3; yaw: number; kind: BotKind; weapon?: WeaponId }[];
  killY: number; // falling below this is death (void)
  palette: Palette;
  /** Half the width of the playing area (m). The sudden-death zone starts no wider than this map needs. */
  extent?: number;
  /** Generator diagnostics, shown in the map lab. */
  info?: { archetype: string; attempt: number; structures: string[]; cells?: number };
}

export const box = (
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  mat: MatId, surface: Surface = 'normal',
): Solid => ({ type: 'box', min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, mat, surface });

export const ramp = (
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  high: RampDir, mat: MatId, surface: Surface = 'normal',
): Solid => ({ type: 'ramp', min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, high, mat, surface });
