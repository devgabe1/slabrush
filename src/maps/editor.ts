import type { Vec3 } from '../core/vec';
import { WEAPON_TIERS, type WeaponId } from '../config/weapons';
import type { MapDef, MatId, Palette, RampDir, Solid } from '../sim/map';
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
    switch (this.tool) {
      case 'block': case 'ramp': case 'deadly': return this.solidAt(a);
      case 'spawn': case 'weapon': { const c = this.spot(a, 1); return c && { min: { x: c.x - 0.4, y: c.y, z: c.z - 0.4 }, max: { x: c.x + 0.4, y: c.y + 1.8, z: c.z + 0.4 } }; }
      case 'pad': { const c = this.spot(a, 2); return c && { min: { x: c.x - 1, y: c.y, z: c.z - 1 }, max: { x: c.x + 1, y: c.y + 0.5, z: c.z + 1 } }; }
      default: { const c = this.spot(a, 2); return c && { min: { x: c.x - 3, y: c.y, z: c.z - 3 }, max: { x: c.x + 3, y: c.y + 4, z: c.z + 3 } }; } // start, checkpoint, finish: a volume 6 m across
    }
  }

  /**
   * The block (or ramp, or lava) a click would place: lined up with the block
   * aimed at, so pieces join. On top of a block it sits on that block's grid
   * (in steps of its own size); against a side, flush with the neighbour's top
   * and in line with it. Aimed at a ramp: the next ramp from its top end (same
   * width, slope and direction), or a landing there with the block tool. A ramp
   * against a block's side rises towards it, its top meeting the block's top.
   * In the open (nothing aimed at): on the half-metre grid, REACH m ahead.
   */
  solidAt(a: Aim): Solid | null {
    if (this.tool !== 'block' && this.tool !== 'ramp' && this.tool !== 'deadly') return null;
    const [w, h, d] = this.size, hit = this.map.solids[a.solid], n = a.normal;
    const mat: MatId = this.tool === 'deadly' ? 'lava' : this.mats()[this.mat] ?? 'concrete';
    const make = (x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, high: RampDir = facing(a.yaw)): Solid => {
      const min = { x: x0, y: y0, z: z0 }, max = { x: x0 + sx, y: y0 + sy, z: z0 + sz };
      return this.tool === 'ramp' ? { type: 'ramp', min, max, high, mat, surface: 'normal' }
        : { type: 'box', min, max, mat, surface: this.tool === 'deadly' ? 'deadly' : 'normal' };
    };
    if (!hit) return make(snap(a.point.x - w / 2), snap(a.point.y - h / 2), snap(a.point.z - d / 2), w, h, d);
    const tile = (min: number, p: number, size: number) => min + Math.floor((p - min) / size) * size;
    if (hit.type === 'ramp') {
      // continue it: the next piece starts where this one ends, at its top
      const ax = hit.high!.endsWith('x') ? 'x' : 'z', sg = hit.high![0] === '+' ? 1 : -1;
      const len = hit.max[ax] - hit.min[ax], rise = hit.max.y - hit.min.y;
      const start = sg > 0 ? hit.max[ax] : hit.min[ax] - (this.tool === 'ramp' ? len : ax === 'x' ? w : d);
      if (this.tool === 'ramp') {
        return ax === 'x' ? make(start, hit.max.y, hit.min.z, len, rise, hit.max.z - hit.min.z, hit.high) : make(hit.min.x, hit.max.y, start, hit.max.x - hit.min.x, rise, len, hit.high);
      }
      return ax === 'x' ? make(start, hit.max.y - h, tile(hit.min.z, a.point.z, d), w, h, d) : make(tile(hit.min.x, a.point.x, w), hit.max.y - h, start, w, h, d);
    }
    if (n.y > 0.5) return make(tile(hit.min.x, a.point.x, w), hit.max.y, tile(hit.min.z, a.point.z, d), w, h, d);
    if (n.y < -0.5) return make(tile(hit.min.x, a.point.x, w), hit.min.y - h, tile(hit.min.z, a.point.z, d), w, h, d);
    // against a side: flush with its top, in line with it. A ramp rises towards it, from its foot to its
    // top (so you can walk up onto it), never steeper than 45 degrees.
    const ramp = this.tool === 'ramp', rh = ramp ? hit.max.y - hit.min.y : h, top = hit.max.y - rh;
    if (Math.abs(n.x) > Math.abs(n.z)) {
      const len = ramp ? Math.max(w, rh) : w, x0 = n.x > 0 ? hit.max.x : hit.min.x - len;
      return make(x0, top, tile(hit.min.z, a.point.z, d), len, rh, d, n.x > 0 ? '-x' : '+x');
    }
    const len = ramp ? Math.max(d, rh) : d, z0 = n.z > 0 ? hit.max.z : hit.min.z - len;
    return make(tile(hit.min.x, a.point.x, w), top, z0, w, rh, len, n.z > 0 ? '-z' : '+z');
  }

  /**
   * Where a spawn point, weapon spot, pad or marker goes: the middle of a
   * `cell`-sized square of the block aimed at, on its top (aimed at its side,
   * on top all the same, at the edge you aimed at). null: nothing to stand on.
   */
  private spot(a: Aim, cell: number): Vec3 | null {
    const hit = this.map.solids[a.solid];
    if (!hit || hit.type === 'ramp' || a.normal.y < -0.5) return null;
    const c = (min: number, max: number, p: number) => Math.min(max - cell / 2, Math.max(min + cell / 2, min + Math.floor((p - min) / cell) * cell + cell / 2));
    return { x: c(hit.min.x, hit.max.x, a.point.x), y: hit.max.y, z: c(hit.min.z, hit.max.z, a.point.z) };
  }

  /** Place the current tool's thing. False if it cannot go there. */
  place(a: Aim): boolean {
    const b = this.preview(a);
    if (!b) return false;
    this.save();
    const m = this.map, p = { x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 };
    switch (this.tool) {
      case 'block': case 'deadly': case 'ramp': m.solids.push(this.solidAt(a)!); break;
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

}

/** The way a ramp rises: away from you, along the axis you face most. */
function facing(yaw: number): RampDir {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? '+x' : '-x') : (fz > 0 ? '+z' : '-z');
}

