import type { Vec3 } from '../core/vec';
import { WEAPONS, type WeaponId } from '../config/weapons';
import type { MapDef, MatId, Palette, RampDir, Solid } from '../sim/map';
import { THEMES } from './themes';
import { COURSES } from './parkour';
import { finishMap, type MapFile, type MapKind } from './mapFile';
import { PROPS, PROP_KINDS, PROP_SIZES, variantFor, type PropKind } from './props';

// The map lab's editor: building a map by hand, block by block. Pure logic
// (no rendering, no input): the lab session aims, this places and removes.

export type Tool = 'block' | 'ramp' | 'deadly' | 'spikes' | 'spawn' | 'weapon' | 'pad' | 'lowgrav' | 'dark' | 'start' | 'checkpoint' | 'finish' | 'prop';

export const TOOL_NAMES: Record<Tool, string> = {
  block: 'BLOCK', ramp: 'RAMP', deadly: 'LAVA (deadly)', spikes: 'SPIKES (deadly)', spawn: 'SPAWN POINT', weapon: 'WEAPON SPOT', pad: 'JUMP PAD',
  lowgrav: 'LOW GRAVITY', dark: 'DARK ZONE', start: 'START', checkpoint: 'CHECKPOINT', finish: 'FINISH', prop: 'DECORATION',
};

/** Tools that place a volume (a zone you can walk into), sized like a block. */
const ZONES: Tool[] = ['lowgrav', 'dark'];
/** Tools that place something sized like a block (a block, a zone, a bed of spikes). */
const SIZED: Tool[] = ['block', 'ramp', 'deadly', 'spikes', ...ZONES];
export const isSized = (t: Tool) => SIZED.includes(t);

/** Block shapes (width x height x depth, m), picked with the mouse wheel (R turns them, Shift+wheel makes them taller or flatter). */
export const SHAPES: [number, number, number, string][] = [
  [4, 1, 4, 'platform'], [8, 1, 8, 'big platform'], [16, 1, 16, 'floor'], [2, 0.5, 2, 'stepping stone'],
  [1, 1, 1, 'cube'], [2, 1, 2, 'step'], [1, 4, 1, 'pillar'], [2, 8, 2, 'column'], [8, 4, 1, 'wall'], [8, 0.5, 1, 'beam'],
];

/** What a right click would remove (and the outline to show it). */
export interface Target { what: 'block' | 'spawn' | 'weapon' | 'trigger' | 'prop'; index: number; min: Vec3; max: Vec3; label: string; /** a bed of spikes: all its pieces */ indices?: number[] }

/** Every look a map can have: the battle themes, then the three courses'. */
export const EDITOR_PALETTES: Palette[] = [...THEMES, ...COURSES.slice(0, 3).map((c) => c.map.palette)];

/** Weapons a weapon spot can hold: any (not fists), or 'random' (a different one each time it fills). */
export const SPOT_WEAPONS: WeaponId[] = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => id !== 'fists');
export const weaponName = (w: WeaponId | 'random') => (w === 'random' ? 'RANDOM' : WEAPONS[w].name);

const G = 0.5; // grid
const snap = (v: number) => Math.round(v / G) * G;
/** How far ahead a block goes when you aim at nothing (to build out into the void). */
export const REACH = 8;

export interface Aim { point: Vec3; normal: Vec3; solid: number /* index into map.solids, -1 = nothing */; yaw: number }

/** One hotbar slot: what a click places (the tool, and for it: material, size, weapon). */
export interface Item { tool: Tool; mat: MatId; size: [number, number, number]; weapon: WeaponId | 'random'; prop?: PropKind }
const item = (tool: Tool, mat: MatId = 'concrete', weapon: WeaponId | 'random' = 'random'): Item =>
  ({ tool, mat, weapon, size: ZONES.includes(tool) ? [8, 6, 8] : [4, 1, 4] });
/** A decoration in a slot. */
const propItem = (prop: PropKind): Item => ({ ...item('prop'), prop });

/** What an item's picture shows (drawn by render/itemThumbs). */
export type Icon =
  | { kind: 'solid'; mat: MatId; size: [number, number, number]; ramp?: boolean }
  | { kind: 'spikes' } | { kind: 'spawn' } | { kind: 'pad' }
  | { kind: 'weapon'; weapon: WeaponId | 'random' }
  | { kind: 'zone'; dark: boolean }
  | { kind: 'marker'; which: 'start' | 'checkpoint' | 'finish' }
  | { kind: 'look'; palette: number }
  | { kind: 'prop'; prop: PropKind };

/** The picture of what a slot holds. */
export function iconOf(it: Item, mat: MatId): Icon {
  switch (it.tool) {
    case 'block': return { kind: 'solid', mat, size: it.size };
    case 'ramp': return { kind: 'solid', mat, size: it.size, ramp: true };
    case 'deadly': return { kind: 'solid', mat: 'lava', size: it.size };
    case 'spikes': return { kind: 'spikes' };
    case 'weapon': return { kind: 'weapon', weapon: it.weapon };
    case 'spawn': return { kind: 'spawn' };
    case 'prop': return { kind: 'prop', prop: it.prop ?? 'painting' };
    case 'pad': return { kind: 'pad' };
    case 'lowgrav': case 'dark': return { kind: 'zone', dark: it.tool === 'dark' };
    default: return { kind: 'marker', which: it.tool };
  }
}

/** An entry of the inventory (E): what it is, its picture, and what clicking it does to the slot in hand. */
export interface InvEntry { group: string; label: string; sub?: string; swatch?: string; icon: Icon; on: boolean; apply(): void }

export class MapEditor {
  /** The hotbar: nine slots, the one in hand is `slot`. Everything placed comes from the item in hand. */
  hotbar: Item[];
  slot = 0;
  get held(): Item { return this.hotbar[this.slot]; }
  get tool(): Tool { return this.held.tool; }
  set tool(t: Tool) { this.held.tool = t; }
  /** The block size placed next (width x height x depth). */
  get size(): [number, number, number] { return this.held.size; }
  set size(v: [number, number, number]) { this.held.size = v; }
  set shape(i: number) { this.size = [SHAPES[i][0], SHAPES[i][1], SHAPES[i][2]]; }
  /** The size's name: the shape it is, or 'custom'. */
  get shapeName(): string {
    const [w, h, d] = this.size;
    return SHAPES.find((s) => s[1] === h && ((s[0] === w && s[2] === d) || (s[0] === d && s[2] === w)))?.[3] ?? 'custom';
  }
  /** The material in hand (one the map's look has; otherwise its first). */
  get matId(): MatId { return this.mats().includes(this.held.mat) ? this.held.mat : this.mats()[0] ?? 'concrete'; }
  get mat(): number { return Math.max(0, this.mats().indexOf(this.matId)); }
  set mat(i: number) { this.held.mat = this.mats()[i] ?? 'concrete'; }
  get weapon(): WeaponId | 'random' { return this.held.weapon; }
  set weapon(w: WeaponId | 'random') { this.held.weapon = w; }
  palette = 0;
  private undos: string[] = [];

  constructor(public file: MapFile) {
    const [m0, m1] = this.mats();
    this.hotbar = file.kind === 'battle'
      ? [item('block', m0), item('ramp', m0), item('block', m1 ?? m0), item('deadly'), item('spikes'), item('spawn'), item('weapon'), item('pad'), item('lowgrav')]
      : [item('block', m0), item('ramp', m0), item('deadly'), item('spikes'), item('start'), item('checkpoint'), item('finish'), item('pad'), item('lowgrav')];
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
  /** The materials blocks can be made of (the map's look has them). */
  mats(): MatId[] { return (Object.keys(this.map.palette.mats) as MatId[]).filter((m) => m !== 'lava'); }
  cycle(what: 'mat' | 'palette', step: number): void {
    const n = { mat: this.mats().length, palette: EDITOR_PALETTES.length }[what];
    const i = (((this[what] + step) % n) + n) % n;
    if (what === 'mat') this.mat = i;
    else this.setLook(i);
  }

  /** The map's look (sky, light, the colours of its materials). */
  setLook(i: number): void {
    this.save();
    this.palette = i;
    this.map.palette = EDITOR_PALETTES[i];
    finishMap(this.map);
  }

  /** Pick a hotbar slot (0-8), or step through them (the wheel). */
  pickSlot(i: number): void { this.slot = ((i % 9) + 9) % 9; }

  /**
   * The inventory: everything that can go in the slot in hand. Blocks (one per
   * material: keeps the slot's shape if it holds a block), shapes (the slot's
   * block or zone takes that size; RAMP makes it a ramp), hazards, gameplay
   * things, weapon spots (battle) and the map's look.
   */
  inventory(): InvEntry[] {
    const h = this.held, pal = this.map.palette.mats, out: InvEntry[] = [];
    const put = (it: Item) => () => { this.hotbar[this.slot] = { ...it, size: [...it.size] as [number, number, number] }; };
    const isBlock = h.tool === 'block' || h.tool === 'ramp';
    for (const m of this.mats()) {
      out.push({ group: 'BLOCKS', label: m.replace(/([A-Z])/g, ' $1').toUpperCase(), swatch: pal[m], icon: { kind: 'solid', mat: m, size: [2, 2, 2] }, on: isBlock && this.matId === m,
        apply: () => { if (isBlock) h.mat = m; else this.hotbar[this.slot] = item('block', m); } });
    }
    const sized = isSized(h.tool);
    for (const [w, hh, d, name] of [...SHAPES, [4, 1, 4, 'ramp'], [4, 2, 8, 'long ramp']] as [number, number, number, string][]) {
      const ramp = name.includes('ramp');
      out.push({ group: 'SHAPES', label: name.toUpperCase(), sub: `${w}×${hh}×${d}`, icon: { kind: 'solid', mat: this.matId, size: [w, hh, d], ramp }, on: sized && this.size.join() === [w, hh, d].join() && (h.tool === 'ramp') === ramp,
        apply: () => {
          if (!sized) this.hotbar[this.slot] = item('block', this.mats()[0]);
          const it = this.held;
          it.size = [w, hh, d];
          if (ramp && (it.tool === 'block' || it.tool === 'ramp')) it.tool = 'ramp';
          else if (!ramp && it.tool === 'ramp') it.tool = 'block';
        } });
    }
    out.push({ group: 'HAZARDS', label: 'LAVA', sub: 'deadly', swatch: pal.lava, icon: { kind: 'solid', mat: 'lava', size: [2, 1, 2] }, on: h.tool === 'deadly', apply: put(item('deadly')) });
    out.push({ group: 'HAZARDS', label: 'SPIKES', sub: 'deadly', swatch: '#5a5c62', icon: { kind: 'spikes' }, on: h.tool === 'spikes', apply: put(item('spikes')) });
    // Decorations: small, medium, large. Floor ones stand on a block's top, wall ones hang on its side.
    for (const sz of PROP_SIZES) {
      for (const k of PROP_KINDS.filter((q) => PROPS[q].size === sz)) {
        out.push({ group: `${sz.toUpperCase()} DECORATIONS`, label: PROPS[k].name, sub: PROPS[k].mount === 'wall' ? 'on a wall' : 'on the floor',
          icon: { kind: 'prop', prop: k }, on: h.tool === 'prop' && h.prop === k, apply: put(propItem(k)) });
      }
    }
    const game: Tool[] = this.file.kind === 'battle' ? ['spawn', 'pad', 'lowgrav', 'dark'] : ['start', 'checkpoint', 'finish', 'pad', 'lowgrav', 'dark'];
    for (const t of game) out.push({ group: 'GAMEPLAY', label: TOOL_NAMES[t], icon: iconOf(item(t), this.matId), on: h.tool === t, apply: put(item(t)) });
    if (this.file.kind === 'battle') {
      for (const w of ['random', ...SPOT_WEAPONS] as (WeaponId | 'random')[]) {
        out.push({ group: 'WEAPON SPOTS', label: weaponName(w), sub: w === 'random' ? 'a different one each time' : undefined, icon: { kind: 'weapon', weapon: w }, on: h.tool === 'weapon' && h.weapon === w, apply: put(item('weapon', 'concrete', w)) });
      }
    }
    EDITOR_PALETTES.forEach((p, i) => out.push({ group: 'THE MAP\'S LOOK', label: `LOOK ${i + 1}`, icon: { kind: 'look', palette: i }, swatch: '#' + p.sky.toString(16).padStart(6, '0'), sub: p.mats.grass ? 'grass' : p.mats.sand ? 'desert' : p.mats.panel ? 'neon' : 'arena', on: this.palette === i, apply: () => this.setLook(i) }));
    return out;
  }


  /** Put a tool in the slot in hand. A zone starts room-sized (8 x 6 x 8) if the block in hand is flatter than a person. */
  select(t: Tool): void {
    this.tool = t;
    if (ZONES.includes(t) && this.size[1] < 3) this.size = [8, 6, 8];
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
      case 'block': case 'ramp': case 'deadly': case 'lowgrav': case 'dark': return this.solidAt(a);
      case 'spikes': { const b = this.solidAt(a); return b && { min: b.min, max: { ...b.max, y: b.min.y + 0.9 } }; } // (a bed of spikes over the block's footprint)
      case 'spawn': case 'weapon': { const c = this.spot(a, 1); return c && { min: { x: c.x - 0.4, y: c.y, z: c.z - 0.4 }, max: { x: c.x + 0.4, y: c.y + 1.8, z: c.z + 0.4 } }; }
      case 'prop': {
        const k = this.held.prop ?? 'painting', s = this.propSpot(a, k), d = PROPS[k];
        if (!s) return null;
        const p = s.pos, wall = d.mount === 'wall';
        // a wall one is thin across the wall, wide along it; a floor one is as wide as it is
        const alongZ = !wall || Math.abs(a.normal.x) > Math.abs(a.normal.z);
        const hx = alongZ ? (wall ? 0.1 : d.half) : d.half, hz = alongZ ? d.half : 0.1;
        return { min: { x: p.x - hx, y: wall ? p.y - d.height / 2 : p.y, z: p.z - hz }, max: { x: p.x + hx, y: wall ? p.y + d.height / 2 : p.y + d.height, z: p.z + hz } };
      }
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
    if (!isSized(this.tool)) return null;
    const [w, h, d] = this.size, hit = this.map.solids[a.solid], n = a.normal;
    const mat: MatId = this.tool === 'deadly' ? 'lava' : this.matId;
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

  /**
   * Where a decoration goes at this aim: a floor kind on the top of a block (facing the way
   * you look), a wall kind on the side of one (facing out of it). null: not there.
   */
  propSpot(a: Aim, k: PropKind): { pos: Vec3; yaw: number } | null {
    const hit = this.map.solids[a.solid], n = a.normal;
    if (!hit || hit.type !== 'box' || hit.mover) return null;
    if (PROPS[k].mount === 'floor') return n.y > 0.5 ? { pos: { x: a.point.x, y: hit.max.y, z: a.point.z }, yaw: a.yaw } : null;
    if (Math.abs(n.y) > 0.5) return null;
    const len = Math.hypot(n.x, n.z) || 1, nx = n.x / len, nz = n.z / len;
    return { pos: { x: a.point.x + nx * 0.02, y: a.point.y, z: a.point.z + nz * 0.02 }, yaw: Math.atan2(-nx, -nz) };
  }

  /** Place the current tool's thing. False if it cannot go there. */
  place(a: Aim): boolean {
    a = { ...a, yaw: Math.atan2(Math.sin(a.yaw), Math.cos(a.yaw)) }; // (the camera's yaw grows past a full turn)
    const b = this.preview(a);
    if (!b) return false;
    this.save();
    const m = this.map, p = { x: (b.min.x + b.max.x) / 2, y: b.min.y, z: (b.min.z + b.max.z) / 2 };
    switch (this.tool) {
      case 'block': case 'deadly': case 'ramp': m.solids.push(this.solidAt(a)!); break;
      case 'lowgrav': m.triggers.push({ type: 'lowgrav', min: b.min, max: b.max, scale: 0.35 }); break;
      case 'dark': m.triggers.push({ type: 'dark', min: b.min, max: b.max }); break;
      case 'spikes':
        // iron spikes in rows over the footprint: a square shaft, then a narrower point
        for (let x = b.min.x + 0.55; x < b.max.x; x += 1.1) {
          for (let z = b.min.z + 0.55; z < b.max.z; z += 1.1) {
            m.solids.push({ type: 'box', min: { x: x - 0.13, y: b.min.y, z: z - 0.13 }, max: { x: x + 0.13, y: b.min.y + 0.6, z: z + 0.13 }, mat: 'iron', surface: 'deadly' });
            m.solids.push({ type: 'box', min: { x: x - 0.06, y: b.min.y + 0.6, z: z - 0.06 }, max: { x: x + 0.06, y: b.min.y + 0.9, z: z + 0.06 }, mat: 'iron', surface: 'deadly' });
          }
        }
        break;
      case 'prop': {
        const k = this.held.prop ?? 'painting', s = this.propSpot(a, k)!;
        m.props = [...(m.props ?? []), { kind: k, pos: s.pos, yaw: s.yaw, variant: variantFor(s.pos.x, s.pos.y, s.pos.z) }];
        break;
      }
      case 'spawn': m.spawns.push({ pos: p, yaw: a.yaw }); break;
      case 'weapon': m.pickups.push({ pos: p, weapon: this.weapon }); break;
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
      return { what: 'trigger', index: tr, min: t.min, max: t.max, label: t.type === 'jumppad' ? 'JUMP PAD' : t.type === 'checkpoint' ? `CHECKPOINT ${t.index}` : t.type === 'lowgrav' ? 'LOW GRAVITY' : t.type === 'dark' ? 'DARK ZONE' : t.type.toUpperCase() };
    }
    // a decoration you are standing right by (its footprint, plus a little): before the block under it
    const pr = (m.props ?? []).findIndex((q) => Math.hypot(q.pos.x - p.x, q.pos.z - p.z) < PROPS[q.kind].half + 0.6 && p.y > q.pos.y - 0.6 && p.y < q.pos.y + PROPS[q.kind].height + 0.6);
    if (pr >= 0) {
      const q = m.props![pr], d = PROPS[q.kind];
      return { what: 'prop', index: pr, min: { x: q.pos.x - d.half, y: q.pos.y, z: q.pos.z - d.half }, max: { x: q.pos.x + d.half, y: q.pos.y + d.height, z: q.pos.z + d.half }, label: d.name.toUpperCase() };
    }
    const sp = m.spawns.findIndex((s) => near(s.pos));
    if (sp >= 0) return { what: 'spawn', index: sp, ...post(m.spawns[sp].pos), label: `SPAWN POINT ${sp + 1}` };
    const pk = m.pickups.findIndex((s) => near(s.pos));
    if (pk >= 0) return { what: 'weapon', index: pk, ...post(m.pickups[pk].pos), label: `WEAPON SPOT (${m.pickups[pk].weapon.toUpperCase()})` };
    const b = m.solids[a.solid];
    if (!b) return null;
    if (isSpike(b)) {
      // the whole bed: every spike joined to this one
      const bed = [a.solid];
      for (let i = 0; i < bed.length; i++) {
        const s = m.solids[bed[i]];
        m.solids.forEach((o, j) => {
          if (!bed.includes(j) && isSpike(o) && Math.abs(o.min.y - s.min.y) < 0.7 && Math.hypot((o.min.x + o.max.x - s.min.x - s.max.x) / 2, (o.min.z + o.max.z - s.min.z - s.max.z) / 2) < 1.6) bed.push(j);
        });
      }
      const all = bed.map((j) => m.solids[j]);
      const lo = (k: 'x' | 'y' | 'z') => Math.min(...all.map((s) => s.min[k])), hi = (k: 'x' | 'y' | 'z') => Math.max(...all.map((s) => s.max[k]));
      return { what: 'block', index: a.solid, indices: bed, min: { x: lo('x'), y: lo('y'), z: lo('z') }, max: { x: hi('x'), y: hi('y'), z: hi('z') }, label: `SPIKES (${bed.length / 2} spikes)` };
    }
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
    else if (t.what === 'prop') m.props!.splice(t.index, 1);
    else for (const i of [...(t.indices ?? [t.index])].sort((x, y) => y - x)) m.solids.splice(i, 1);
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

/** A piece of a spike (its shaft or point). */
const isSpike = (s: Solid) => s.mat === 'iron' && s.surface === 'deadly' && s.max.x - s.min.x < 0.3;

/** The way a ramp rises: away from you, along the axis you face most. */
function facing(yaw: number): RampDir {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? '+x' : '-x') : (fz > 0 ? '+z' : '-z');
}

