import type { Vec3 } from '../core/vec';
import { WEAPON_TIERS, type WeaponId } from '../config/weapons';
import type { MapDef, MatId, Palette, RampDir } from '../sim/map';
import { THEMES } from './themes';
import { COURSES } from './parkour';
import { finishMap, type MapFile, type MapKind } from './mapFile';

// The map lab's editor: building a map by hand, block by block. Pure logic
// (no rendering, no input): the lab session aims, this places and removes.

export type Tool = 'block' | 'ramp' | 'deadly' | 'spawn' | 'weapon' | 'pad' | 'start' | 'checkpoint' | 'finish';

export const TOOL_NAMES: Record<Tool, string> = {
  block: 'BLOCK', ramp: 'RAMP', deadly: 'LAVA (deadly)', spawn: 'SPAWN POINT', weapon: 'WEAPON SPOT', pad: 'JUMP PAD',
  start: 'START', checkpoint: 'CHECKPOINT', finish: 'FINISH',
};

/** Block shapes (width x height x depth, m), picked with the mouse wheel (R turns them, Shift+wheel makes them taller or flatter). */
export const SHAPES: [number, number, number, string][] = [
  [4, 1, 4, 'platform'], [8, 1, 8, 'big platform'], [16, 1, 16, 'floor'], [2, 0.5, 2, 'stepping stone'],
  [1, 1, 1, 'cube'], [2, 1, 2, 'step'], [1, 4, 1, 'pillar'], [2, 8, 2, 'column'], [8, 4, 1, 'wall'], [8, 0.5, 1, 'beam'],
];

/** What a right click would remove (and the outline to show it). */
export interface Target { what: 'block' | 'spawn' | 'weapon' | 'trigger'; index: number; min: Vec3; max: Vec3; label: string }

/** Every look a map can have: the battle themes, then the three courses'. */
export const EDITOR_PALETTES: Palette[] = [...THEMES, ...COURSES.slice(0, 3).map((c) => c.map.palette)];

/** Weapons a weapon spot can hold. */
export const SPOT_WEAPONS: WeaponId[] = WEAPON_TIERS.flat();

const G = 0.5; // grid
const snap = (v: number) => Math.round(v / G) * G;
/** How far ahead a block goes when you aim at nothing (to build out into the void). */
export const REACH = 8;

export interface Aim { point: Vec3; normal: Vec3; solid: number /* index into map.solids, -1 = nothing */; yaw: number }

export class MapEditor {
  tool: Tool;
  /** The block size placed next (width x height x depth): a shape from SHAPES, turned, resized, or copied from a block. */
  size: [number, number, number] = [4, 1, 4];
  private preset = 0;
  get shape(): number { return this.preset; }
  set shape(i: number) { this.preset = i; this.size = [SHAPES[i][0], SHAPES[i][1], SHAPES[i][2]]; }
  /** The size's name: the shape it is, or 'custom'. */
  get shapeName(): string {
    const [w, h, d] = this.size;
    return SHAPES.find((s) => s[1] === h && ((s[0] === w && s[2] === d) || (s[0] === d && s[2] === w)))?.[3] ?? 'custom';
  }
  mat = 0;
  weapon = 0;
  palette = 0;
  private undos: string[] = [];

  constructor(public file: MapFile) {
    this.tool = 'block';
    this.palette = Math.max(0, EDITOR_PALETTES.findIndex((p) => JSON.stringify(p) === JSON.stringify(file.map.palette)));
  }

  /** A new, nearly empty map: a floor to start from (battle), or a start platform (parkour). */
  static blank(kind: MapKind, author: string): MapFile {
    const palette = kind === 'battle' ? THEMES[0] : COURSES[0].map.palette;
    const map: MapDef = {
      name: 'UNTITLED', seed: 0, triggers: [], spawns: [], pickups: [], bots: [], killY: -20, palette,
      solids: kind === 'battle'
        ? [{ type: 'box', min: { x: -12, y: -1, z: -12 }, max: { x: 12, y: 0, z: 12 }, mat: 'concrete', surface: 'normal' }]
        : [{ type: 'box', min: { x: -4, y: -1, z: -4 }, max: { x: 4, y: 0, z: 4 }, mat: (palette.mats.dirt ? 'dirt' : 'concrete') as MatId, surface: 'normal' }],
    };
    finishMap(map);
    const id = `${kind}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    return { format: 'slabrush-map', version: 1, kind, id, name: 'UNTITLED', author, map };
  }

  get map(): MapDef { return this.file.map; }
  tools(): Tool[] {
    return this.file.kind === 'battle' ? ['block', 'ramp', 'deadly', 'spawn', 'weapon', 'pad'] : ['block', 'ramp', 'deadly', 'start', 'checkpoint', 'finish', 'pad'];
  }
  /** The materials blocks can be made of (the map's look has them). */
  mats(): MatId[] { return (Object.keys(this.map.palette.mats) as MatId[]).filter((m) => m !== 'lava'); }
  cycle(what: 'shape' | 'mat' | 'weapon' | 'palette', step: number): void {
    const n = { shape: SHAPES.length, mat: this.mats().length, weapon: SPOT_WEAPONS.length, palette: EDITOR_PALETTES.length }[what];
    this[what] = (((this[what] + step) % n) + n) % n;
    if (what === 'shape' && (this.tool === 'spawn' || this.tool === 'weapon' || this.tool === 'pad' || this.tool === 'start' || this.tool === 'checkpoint' || this.tool === 'finish')) this.tool = 'block'; // (the wheel is about blocks)
    if (what === 'palette') { this.save(); this.map.palette = EDITOR_PALETTES[this.palette]; this.mat = Math.min(this.mat, this.mats().length - 1); }
  }

  /** Turn the block a quarter turn (width and depth swap). */
  rotate(): void { this.size = [this.size[2], this.size[1], this.size[0]]; }
  /** Taller (+1) or flatter (-1), by half a metre (0.5 to 16 m). */
  taller(step: number): void { this.size[1] = Math.max(0.5, Math.min(16, this.size[1] + step * 0.5)); }

  /** Copy the block aimed at: its size and material (and whether it is a ramp or lava) become the ones you place. */
  pick(a: Aim): boolean {
    const b = this.map.solids[a.solid];
    if (!b) return false;
    this.size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    this.tool = b.surface === 'deadly' ? 'deadly' : b.type === 'ramp' ? 'ramp' : 'block';
    const m = this.mats().indexOf(b.mat);
    if (m >= 0) this.mat = m;
    return true;
  }

  /** What placing would add here: a box (for the preview), or null where it cannot go. */
  preview(a: Aim): { min: Vec3; max: Vec3 } | null {
    const up = a.normal.y > 0.5;
    switch (this.tool) {
      case 'block': case 'ramp': case 'deadly': return this.blockAt(a);
      case 'spawn': case 'weapon': return up ? { min: { x: a.point.x - 0.4, y: a.point.y, z: a.point.z - 0.4 }, max: { x: a.point.x + 0.4, y: a.point.y + 1.8, z: a.point.z + 0.4 } } : null;
      case 'pad': return up ? this.flat(a.point, 1, 0.5) : null;
      default: return up ? this.flat(a.point, 3, 4) : null; // start, checkpoint, finish: a volume 6 m across
    }
  }

  /** Place the current tool's thing. False if it cannot go there. */
  place(a: Aim): boolean {
    const b = this.preview(a);
    if (!b) return false;
    this.save();
    const m = this.map, p = { x: snap(a.point.x), y: a.point.y, z: snap(a.point.z) };
    switch (this.tool) {
      case 'block': m.solids.push({ type: 'box', ...b, mat: this.mats()[this.mat] ?? 'concrete', surface: 'normal' }); break;
      case 'deadly': m.solids.push({ type: 'box', ...b, mat: 'lava', surface: 'deadly' }); break;
      case 'ramp': m.solids.push({ type: 'ramp', ...b, high: facing(a.yaw), mat: this.mats()[this.mat] ?? 'concrete', surface: 'normal' }); break;
      case 'spawn': m.spawns.push({ pos: p, yaw: a.yaw }); break;
      case 'weapon': m.pickups.push({ pos: p, weapon: SPOT_WEAPONS[this.weapon] }); break;
      case 'pad': m.triggers.push({ type: 'jumppad', ...b, vel: { x: 0, y: 13, z: 0 } }); break;
      case 'start':
        // one start: placing it again moves it; its spawn points (a row of six) go with it
        m.triggers = m.triggers.filter((t) => t.type !== 'start');
        m.triggers.push({ type: 'start', ...b });
        m.spawns = [0, -1, 1, -2, 2, -3].map((k) => ({ pos: { x: p.x + Math.cos(a.yaw) * k * 0.9, y: p.y + 0.02, z: p.z - Math.sin(a.yaw) * k * 0.9 }, yaw: a.yaw }));
        break;
      case 'finish':
        m.triggers = m.triggers.filter((t) => t.type !== 'finish');
        m.triggers.push({ type: 'finish', ...b });
        break;
      case 'checkpoint':
        m.triggers.push({ type: 'checkpoint', ...b, index: 0, spawn: { ...p, y: p.y + 0.02 }, yaw: a.yaw });
        this.renumber();
        break;
    }
    finishMap(m);
    return true;
  }

  /**
   * What a right click would remove: a spawn point, weapon spot or trigger
   * near the point first (they are small and easy to miss), otherwise the block.
   */
  target(a: Aim): Target | null {
    const m = this.map, p = a.point, near = (q: Vec3) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1.5;
    const inside = (t: { min: Vec3; max: Vec3 }) => p.x > t.min.x - 0.3 && p.x < t.max.x + 0.3 && p.z > t.min.z - 0.3 && p.z < t.max.z + 0.3 && p.y > t.min.y - 0.6 && p.y < t.max.y;
    const post = (q: Vec3) => ({ min: { x: q.x - 0.4, y: q.y, z: q.z - 0.4 }, max: { x: q.x + 0.4, y: q.y + 1.8, z: q.z + 0.4 } });
    const tr = m.triggers.findIndex(inside);
    if (tr >= 0) {
      const t = m.triggers[tr];
      return { what: 'trigger', index: tr, min: t.min, max: t.max, label: t.type === 'jumppad' ? 'JUMP PAD' : t.type === 'checkpoint' ? `CHECKPOINT ${t.index}` : t.type.toUpperCase() };
    }
    const sp = m.spawns.findIndex((s) => near(s.pos));
    if (sp >= 0) return { what: 'spawn', index: sp, ...post(m.spawns[sp].pos), label: `SPAWN POINT ${sp + 1}` };
    const pk = m.pickups.findIndex((s) => near(s.pos));
    if (pk >= 0) return { what: 'weapon', index: pk, ...post(m.pickups[pk].pos), label: `WEAPON SPOT (${m.pickups[pk].weapon.toUpperCase()})` };
    const b = m.solids[a.solid];
    if (!b) return null;
    const dims = `${b.max.x - b.min.x}×${b.max.y - b.min.y}×${b.max.z - b.min.z}`;
    return { what: 'block', index: a.solid, min: b.min, max: b.max, label: `${b.surface === 'deadly' ? 'LAVA' : b.type === 'ramp' ? 'RAMP' : 'BLOCK'} ${dims} ${b.surface === 'deadly' ? '' : b.mat}`.trim() };
  }

  /** Remove what is aimed at (see target). */
  remove(a: Aim): boolean {
    const t = this.target(a), m = this.map;
    if (!t) return false;
    this.save();
    if (t.what === 'trigger') {
      if (m.triggers[t.index].type === 'start') m.spawns = [];
      m.triggers.splice(t.index, 1);
      this.renumber();
    } else if (t.what === 'spawn') m.spawns.splice(t.index, 1);
    else if (t.what === 'weapon') m.pickups.splice(t.index, 1);
    else m.solids.splice(t.index, 1);
    finishMap(m);
    return true;
  }

  undo(): boolean {
    const s = this.undos.pop();
    if (!s) return false;
    this.file.map = JSON.parse(s);
    return true;
  }

  /** What is missing before the map can be played, saved for others or submitted ('' = nothing). */
  problem(): string {
    const m = this.map, has = (t: string) => m.triggers.some((x) => x.type === t);
    if (this.file.kind === 'battle') return m.spawns.length < 2 ? 'Place at least 2 spawn points.' : '';
    return !has('start') ? 'Place the START.' : !has('finish') ? 'Place the FINISH.' : '';
  }

  private save(): void {
    this.undos.push(JSON.stringify(this.map));
    if (this.undos.length > 100) this.undos.shift();
  }

  /** Checkpoints are numbered in the order they were placed. */
  private renumber(): void {
    let n = 0;
    for (const t of this.map.triggers) if (t.type === 'checkpoint') t.index = ++n;
  }

  /** A volume `half` m either side of a point on a floor, `h` high. */
  private flat(p: Vec3, half: number, h: number): { min: Vec3; max: Vec3 } {
    const x = snap(p.x), z = snap(p.z);
    return { min: { x: x - half, y: p.y, z: z - half }, max: { x: x + half, y: p.y + h, z: z + half } };
  }

  /** A block of the current shape against the face aimed at (on top, below, or beside it), on the grid. */
  private blockAt(a: Aim): { min: Vec3; max: Vec3 } {
    const [w, h, d] = this.size;
    const { point: p, normal: n } = a;
    const c = { x: snap(p.x - w / 2) + w / 2, y: snap(p.y - h / 2) + h / 2, z: snap(p.z - d / 2) + d / 2 };
    if (n.y > 0.5) c.y = p.y + h / 2;
    else if (n.y < -0.5) c.y = p.y - h / 2;
    else if (Math.abs(n.x) > Math.abs(n.z)) c.x = p.x + Math.sign(n.x) * w / 2;
    else c.z = p.z + Math.sign(n.z) * d / 2;
    return { min: { x: c.x - w / 2, y: c.y - h / 2, z: c.z - d / 2 }, max: { x: c.x + w / 2, y: c.y + h / 2, z: c.z + d / 2 } };
  }
}

/** The way a ramp rises: away from you, along the axis you face most. */
function facing(yaw: number): RampDir {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? '+x' : '-x') : (fz > 0 ? '+z' : '-z');
}

