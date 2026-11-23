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
  /** 'hull': any convex shape, given by its faces (surf ramps that run downhill, for one). */
  type: 'box' | 'ramp' | 'hull';
  min: Vec3;
  max: Vec3;
  high?: RampDir; // ramps only
  faces?: Vec3[][]; // hulls only: each face a convex polygon (either winding)
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
  | { type: 'dark'; min: Vec3; max: Vec3 } // visual only
  | { type: 'boost'; min: Vec3; max: Vec3; vel: Vec3 } // speed along vel raised to at least |vel| (horizontal)
  // Parkour courses (the sim ignores these; the parkour session times the run with them):
  | { type: 'start'; min: Vec3; max: Vec3 } // the clock starts when you leave it
  | { type: 'checkpoint'; min: Vec3; max: Vec3; index: number; spawn: Vec3; yaw: number } // fall, and you are back here
  | { type: 'finish'; min: Vec3; max: Vec3 };

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

/**
 * A surf ramp: a ridge running from (x0, y0) to (x1, y1) along x at z = zc, with a
 * slope down each side, `w` across and `h` high. y0 above y1 makes it run downhill.
 * `sides` picks which slopes it has ('both', or just the -z or +z face, with a wall behind).
 */
export function surfRidge(
  x0: number, y0: number, x1: number, y1: number, zc: number, w: number, h: number,
  mat: MatId, sides: 'both' | '-z' | '+z' = 'both',
): Solid {
  const t0 = { x: x0, y: y0, z: zc }, t1 = { x: x1, y: y1, z: zc };
  const l0 = { x: x0, y: y0 - h, z: sides === '+z' ? zc : zc - w }, l1 = { x: x1, y: y1 - h, z: sides === '+z' ? zc : zc - w };
  const r0 = { x: x0, y: y0 - h, z: sides === '-z' ? zc : zc + w }, r1 = { x: x1, y: y1 - h, z: sides === '-z' ? zc : zc + w };
  // One-sided, the missing slope's corners sit right under the ridge: that side is a vertical wall.
  const faces = [[t0, t1, l1, l0], [t0, r0, r1, t1], [l0, l1, r1, r0], [t0, l0, r0], [t1, r1, l1]];
  return hull(faces, mat);
}

/** A convex solid from its faces. */
export function hull(faces: Vec3[][], mat: MatId, surface: Surface = 'normal'): Solid {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const f of faces) for (const p of f) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z);
  }
  return { type: 'hull', min, max, faces: faces.map((f) => f.map((p) => ({ ...p }))), mat, surface };
}
