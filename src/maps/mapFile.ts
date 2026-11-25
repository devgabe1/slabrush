import type { Vec3 } from '../core/vec';
import { WEAPONS, type WeaponId } from '../config/weapons';
import type { MapDef, MatId, Palette, RampDir, Solid, Surface, Trigger } from '../sim/map';
import type { Course } from './parkour';

// Maps made in the map lab: the file format (JSON), the check every file from
// outside goes through (an import, a submission, a saved map), and the
// compact code a map is submitted as.

export type MapKind = 'battle' | 'parkour';

export interface MapFile {
  format: 'slabrush-map';
  version: 1;
  kind: MapKind;
  id: string; // a-z, 0-9 and dashes: unique per map (rotation, records)
  name: string;
  author: string;
  map: MapDef;
}

/** Every material a map may use (the textures know them all). */
export const MAT_IDS: MatId[] = ['concrete', 'concreteDark', 'tile', 'metal', 'hazard', 'ice', 'conveyor', 'lava',
  'grass', 'dirt', 'stone', 'planks', 'leaves', 'sand', 'sandstone', 'glass', 'panel', 'panelAlt', 'log', 'ember', 'basalt',
  'snow', 'moonstone', 'crystal', 'water', 'iron'];

/** How much a map may hold (a file is someone else's data: never unbounded). */
export const LIMITS = { solids: 3000, triggers: 200, spawns: 16, pickups: 64, coord: 1500 };

const SURFACES: Surface[] = ['normal', 'ice', 'conveyor', 'deadly'];
const DIRS: RampDir[] = ['+x', '-x', '+z', '-z'];

const fail = (why: string): never => { throw new Error(`Not a valid map: ${why}.`); };
const num = (v: unknown, what: string, lo = -LIMITS.coord, hi = LIMITS.coord): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fail(`${what} is not a number in range`);
/** An angle (radians): any finite number, brought back into -PI..PI (the camera's yaw keeps growing as you turn round). */
export const angle = (v: unknown, what: string): number => { const a = num(v, what, -1e6, 1e6); return Math.atan2(Math.sin(a), Math.cos(a)); };
const vec = (v: unknown, what: string): Vec3 => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o.x, what), y: num(o.y, what), z: num(o.z, what) };
};
const box = (o: Record<string, unknown>, what: string) => {
  const min = vec(o.min, what), max = vec(o.max, what);
  if (!(min.x < max.x && min.y < max.y && min.z < max.z)) fail(`${what} has no size`);
  return { min, max };
};
const list = (v: unknown, what: string, max: number): Record<string, unknown>[] => {
  if (!Array.isArray(v)) fail(`${what} missing`);
  if ((v as unknown[]).length > max) fail(`too many ${what} (${(v as unknown[]).length}, at most ${max})`);
  return v as Record<string, unknown>[];
};
const text = (v: unknown, max: number, dflt: string) =>
  (typeof v === 'string' ? v : '').replace(/[<>&"\\]/g, '').trim().slice(0, max) || dflt;
const color = (v: unknown, what: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fail(`${what} is not a colour`));

/**
 * A map file from anywhere (import, submission, storage): checked field by
 * field and rebuilt from scratch, so nothing unexpected gets through. Only
 * what the editor makes is kept. Throws (with the reason) if it is not a map.
 * `complete` false: a draft is fine (no spawn points, start or finish yet).
 */
export function cleanMapFile(v: unknown, complete = true): MapFile {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.format !== 'slabrush-map') fail('not a SLABRUSH map file');
  if (o.version !== 1) fail('made by a newer version of the game');
  const kind: MapKind = o.kind === 'parkour' ? 'parkour' : o.kind === 'battle' ? 'battle' : fail('unknown kind');
  const m = (o.map ?? {}) as Record<string, unknown>;
  const p = (m.palette ?? {}) as Record<string, unknown>;
  const mats = {} as Record<string, string>;
  for (const id of MAT_IDS) if ((p.mats as Record<string, unknown> | undefined)?.[id] !== undefined) mats[id] = color((p.mats as Record<string, unknown>)[id], `colour of ${id}`);
  const palette: Palette = {
    sky: num(p.sky, 'sky', 0, 0xffffff), fogNear: num(p.fogNear, 'fog', 0, 5000), fogFar: num(p.fogFar, 'fog', 1, 5000),
    sun: num(p.sun, 'sun', 0, 0xffffff), ambientSky: num(p.ambientSky, 'light', 0, 0xffffff), ambientGround: num(p.ambientGround, 'light', 0, 0xffffff),
    mats: mats as Palette['mats'],
  };
  const solids: Solid[] = list(m.solids, 'blocks', LIMITS.solids).map((s, i) => {
    const what = `block ${i + 1}`;
    const type = s.type === 'ramp' ? 'ramp' : s.type === 'box' ? 'box' : fail(`${what} has an unknown shape`);
    const mat = MAT_IDS.includes(s.mat as MatId) ? (s.mat as MatId) : fail(`${what} has an unknown material`);
    const surface = s.surface === undefined ? 'normal' : SURFACES.includes(s.surface as Surface) ? (s.surface as Surface) : fail(`${what} has an unknown surface`);
    const out: Solid = { type, ...box(s, what), mat, surface };
    if (type === 'ramp') out.high = DIRS.includes(s.high as RampDir) ? (s.high as RampDir) : fail(`${what} is a ramp with no direction`);
    return out;
  });
  const triggers: Trigger[] = list(m.triggers, 'triggers', LIMITS.triggers).map((t, i) => {
    const what = `trigger ${i + 1}`;
    const b = box(t, what);
    switch (t.type) {
      case 'jumppad': return { type: 'jumppad', ...b, vel: vec(t.vel, what) };
      case 'start': return { type: 'start', ...b };
      case 'finish': return { type: 'finish', ...b };
      case 'checkpoint': return { type: 'checkpoint', ...b, index: num(t.index, what, 1, LIMITS.triggers), spawn: vec(t.spawn, what), yaw: angle(t.yaw, what) };
      case 'lowgrav': return { type: 'lowgrav', ...b, scale: num(t.scale, what, 0.1, 1) };
      case 'dark': return { type: 'dark', ...b };
      default: return fail(`${what} is of a kind the editor does not make`);
    }
  });
  const spawns = list(m.spawns, 'spawn points', LIMITS.spawns).map((s, i) => ({ pos: vec(s.pos, `spawn ${i + 1}`), yaw: angle(s.yaw, `spawn ${i + 1}`) }));
  const pickups = list(m.pickups, 'weapon spots', LIMITS.pickups).map((s, i) => ({
    pos: vec(s.pos, `weapon spot ${i + 1}`),
    weapon: s.weapon === 'random' ? 'random' as const : typeof s.weapon === 'string' && s.weapon in WEAPONS && s.weapon !== 'fists' ? (s.weapon as WeaponId) : fail(`weapon spot ${i + 1} has an unknown weapon`),
  }));
  if (complete && kind === 'battle' && spawns.length < 2) fail('a battle map needs at least 2 spawn points');
  if (complete && kind === 'parkour' && (!triggers.some((t) => t.type === 'start') || !triggers.some((t) => t.type === 'finish') || !spawns.length)) fail('a parkour map needs a start and a finish');
  const name = text(o.name, 24, 'UNTITLED').toUpperCase();
  const id = typeof o.id === 'string' && /^[a-z0-9-]{1,40}$/.test(o.id) ? o.id : fail('bad id');
  return {
    format: 'slabrush-map', version: 1, kind, id, name, author: text(o.author, 14, 'PLAYER'),
    map: { name, seed: 0, solids, triggers, spawns, pickups, bots: [], palette, killY: num(m.killY, 'kill height'), extent: num(m.extent ?? 24, 'extent', 1, LIMITS.coord) },
  };
}

/** Where falling off kills you, and how wide the battle zone starts: worked out from the blocks. */
export function finishMap(map: MapDef): void {
  const s = map.solids;
  // iron spikes need iron in the map's look (most looks have none): the palette is copied, never changed in place
  if (s.some((b) => b.mat === 'iron') && !map.palette.mats.iron) map.palette = { ...map.palette, mats: { ...map.palette.mats, iron: '#5a5c62' } };
  map.killY = (s.length ? Math.min(...s.map((b) => b.min.y)) : 0) - 20;
  map.extent = Math.max(4, ...s.map((b) => Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z))));
}

/** A parkour map as a course the game can run (solo or raced). */
export function courseFromFile(f: MapFile): Course {
  const tops = f.map.solids.filter((s) => s.surface !== 'deadly').map((s) => s.max.y);
  return {
    id: f.id, name: f.name, blurb: `A course by ${f.author}.`, difficulty: 'MEDIUM', map: f.map,
    fallY: (tops.length ? Math.min(...tops) : 0) - 10,
    checkpoints: f.map.triggers.filter((t) => t.type === 'checkpoint').length,
    route: [], // (no autopilot route for hand-made courses)
  };
}

// ---------------------------------------------------------------- submission codes
// A map squeezed into a short text (deflate + base64url), so it fits in a link.

export async function encodeMap(f: MapFile): Promise<string> {
  const data = new Blob([JSON.stringify(f)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(data).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeMap(code: string): Promise<MapFile> {
  const bin = atob(code.trim().replace(/-/g, '+').replace(/_/g, '/'));
  if (bin.length > 2_000_000) fail('too big');
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const data = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const json = await new Response(data).text();
  if (json.length > 8_000_000) fail('too big');
  return cleanMapFile(JSON.parse(json));
}
