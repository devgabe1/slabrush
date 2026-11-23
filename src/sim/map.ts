import type { Vec3 } from '../core/vec';
import type { WeaponId } from '../config/weapons';

// Data-only map description. The generator outputs exactly this structure
// from a seed, so every peer can rebuild an identical map locally.
export type BaseMat = 'concrete' | 'concreteDark' | 'tile' | 'metal' | 'hazard' | 'ice' | 'conveyor' | 'lava';
/** Extra materials, for themed maps (the parkour courses): a palette only needs the ones its map uses. */
export type ThemeMat = 'grass' | 'dirt' | 'stone' | 'planks' | 'leaves' | 'sand' | 'sandstone' | 'glass' | 'panel' | 'panelAlt';
export type MatId = BaseMat | ThemeMat;
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
  mats: Record<BaseMat, string> & Partial<Record<ThemeMat, string>>; // base colour (hex) of each procedural texture
}

/**
 * Living scenery. All of it is decoration: drawn and animated by the renderer
 * from the clock alone, never solid, unknown to the simulation.
 */
export type LifeDef =
  /** birds circling a point, wings flapping */
  | { kind: 'flock'; center: Vec3; radius: number; count: number; color: number; size: number; speed: number }
  /** small things fluttering round a point (butterflies, embers); `glow`: drawn bright */
  | { kind: 'swarm'; center: Vec3; spread: number; count: number; colors: number[]; size: number; glow?: boolean }
  /** a falling curtain of water, lava or sand: a box whose stripes stream down */
  | { kind: 'fall'; min: Vec3; max: Vec3; color: number; speed: number }
  /** a fire, flickering (braziers, torches) */
  | { kind: 'flame'; pos: Vec3; size: number }
  /** figures walking from a to b and back, one behind the other */
  | { kind: 'walkers'; a: Vec3; b: Vec3; count: number; gap: number; shape: 'beast' | 'camel' | 'alien'; colors: number[]; size: number; speed: number }
  /** clouds drifting along x through x0..x1, wrapping round */
  | { kind: 'clouds'; x0: number; x1: number; boxes: { x: number; y: number; z: number; w: number; d: number }[]; speed: number }
  /**
   * Aliens building a giant stepped pyramid: the lower tiers stand, the top ones
   * go up block by block, carried in by saucers from a stockpile; a mothership
   * looks on. It finishes, glows, is taken apart again and rebuilt, endlessly.
   */
  | { kind: 'pyramidWorks'; center: Vec3; block: number; base: number; prebuilt: number; saucers: number }
  /** grains blowing along x through x0..x1 (a sand gust), wrapping round */
  | { kind: 'wind'; x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; count: number; color: number; speed: number };

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
  /** Scenery that glows and is not solid (neon signs, light strips, clouds): drawn unlit, in its own colour. */
  decor?: { min: Vec3; max: Vec3; color: number }[];
  /** Digital billboards: animated screens on the face (which way it looks) of a flat box. Not solid. */
  screens?: { min: Vec3; max: Vec3; face: '+x' | '-x' | '+z' | '-z'; style: number }[];
  /** Streams of lights moving from a to b (traffic on the highways). */
  traffic?: { a: Vec3; b: Vec3; color: number; count: number; speed: number }[];
  /** Giant holograms turning in the sky. */
  holos?: { pos: Vec3; size: number; color: number; kind: number }[];
  /** Things that move about, for a map that feels alive (drawn only: never solid, the sim ignores them). See LifeDef. */
  life?: LifeDef[];
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

