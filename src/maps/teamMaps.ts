import { TEAM } from '../config/game';
import { LEGENDARIES, LEGENDARY_CHANCE, TIER_WEIGHT, WEAPON_TIERS, type WeaponId } from '../config/weapons';
import { Rng, hashSeed } from '../core/rng';
import { v3, type Vec3 } from '../core/vec';
import { box, ramp, type LifeDef, type MapDef, type MatId, type Palette, type RampDir, type Solid, type Surface, type Trigger } from '../sim/map';
import { variantFor, type PropKind } from './props';

// TEAM matches are played on three hand-built maps, never on generated ones:
//   SUNGATE OASIS    - Egyptian temples facing each other across the Nile at golden hour
//   ARCADE SKYLINE   - two neon rooftops over a highway canyon at night
//   FROSTFANG FJORD  - two Viking longhouses across a frozen lake under the aurora
//
// Every map is a mirror image across x = 0: RED's half (west, -x) is BLUE's half
// (east, +x) flipped, so neither side has the better ground. Each half is built
// once, in "own side" coordinates (u: metres from the middle towards your own
// end), by Kit.half. The weapon spots are fixed, but what lies in them is rolled
// from the match seed by tier weight (TIER_WEIGHT), as on generated maps: nothing
// is guaranteed. A spot and its mirror image always roll the same weapon.

export interface TeamMap {
  id: string;
  name: string;
  /** Builds the map; `seed` only decides the weapons. Deterministic: every peer builds the same map. */
  build(seed: number): MapDef;
  /** Left out of the rotation for now (still built and tested, so it can come back by deleting this). */
  off?: boolean;
}

/** Yaws (the game's: facing (-sin, -cos)) in own-side terms; Kit mirrors them for RED. */
const IN = Math.PI / 2; // facing the middle of the map (towards the enemy)
const OUT = -Math.PI / 2; // facing your own end
const NORTH = Math.PI; // facing +z
const SOUTH = 0; // facing -z

type Face = '+x' | '-x' | '+z' | '-z';

/** Collects a map's pieces. Inside half(), x is own-side u and is mirrored for RED. */
class Kit {
  /** 1: building the middle or BLUE's half (east); -1: RED's half (west, the mirror image). */
  s = 1;
  solids: Solid[] = [];
  triggers: Trigger[] = [];
  spawns: { pos: Vec3; yaw: number }[] = [];
  spots: { pos: Vec3; key: string }[] = [];
  decor: NonNullable<MapDef['decor']> = [];
  screens: NonNullable<MapDef['screens']> = [];
  traffic: NonNullable<MapDef['traffic']> = [];
  holos: NonNullable<MapDef['holos']> = [];
  life: LifeDef[] = [];
  props: NonNullable<MapDef['props']> = [];
  private n = 0;

  /** Builds one half twice: BLUE's, then RED's (mirrored). Spots are paired by order. */
  half(fn: (k: Kit) => void): void {
    for (const s of [1, -1]) { this.s = s; this.n = 0; fn(this); }
    this.s = 1;
  }

  /** This half's team colour (TEAM.colors: RED is 0, BLUE is 1). */
  get team(): number { return TEAM.colors[this.s > 0 ? 1 : 0]; }

  x(u: number): number { return this.s * u; }
  pt(u: number, y: number, z: number): Vec3 { return v3(this.s * u, y, z); }
  private span(u0: number, u1: number): [number, number] { const a = this.s * u0, b = this.s * u1; return a < b ? [a, b] : [b, a]; }
  private dir<D extends RampDir>(d: D): D { return (this.s > 0 || d[1] === 'z' ? d : d === '+x' ? '-x' : '+x') as D; }
  private yaw(y: number): number { return this.s > 0 ? y : -y; }
  private area(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number): { min: Vec3; max: Vec3 } {
    const [a, b] = this.span(u0, u1);
    return { min: v3(a, Math.min(y0, y1), Math.min(z0, z1)), max: v3(b, Math.max(y0, y1), Math.max(z0, z1)) };
  }

  box(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, mat: MatId, surface?: Surface): Solid {
    const a = this.area(u0, y0, z0, u1, y1, z1);
    const s = box(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, mat, surface);
    this.solids.push(s);
    return s;
  }
  /** `high`: the side that is up, in own-side terms ('-x' = towards the middle). */
  ramp(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, high: RampDir, mat: MatId): Solid {
    const a = this.area(u0, y0, z0, u1, y1, z1);
    const s = ramp(a.min.x, a.min.y, a.min.z, a.max.x, a.max.y, a.max.z, this.dir(high), mat);
    this.solids.push(s);
    return s;
  }
  /** Something glowing and not solid (neon, runes, sails). */
  glow(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, color: number): void {
    this.decor.push({ ...this.area(u0, y0, z0, u1, y1, z1), color });
  }
  screen(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, face: Face, style: number): void {
    this.screens.push({ ...this.area(u0, y0, z0, u1, y1, z1), face: this.dir(face), style });
  }
  prop(kind: PropKind, u: number, y: number, z: number, yaw = IN): void {
    const x = this.s * u;
    this.props.push({ kind, pos: v3(x, y, z), yaw: this.yaw(yaw), variant: variantFor(x, y, z) });
  }
  spawn(u: number, y: number, z: number, yaw = IN): void { this.spawns.push({ pos: this.pt(u, y, z), yaw: this.yaw(yaw) }); }
  /** A weapon spot. In a half its key pairs it with its mirror image; in the middle give one. */
  spot(u: number, y: number, z: number, key?: string): void { this.spots.push({ pos: this.pt(u, y, z), key: key ?? `half${this.n++}` }); }
  pad(u0: number, u1: number, z0: number, z1: number, y: number, up: number): void {
    this.triggers.push({ type: 'jumppad', ...this.area(u0, y, z0, u1, y + 0.5, z1), vel: v3(0, up, 0) });
  }
  dark(u0: number, y0: number, z0: number, u1: number, y1: number, z1: number, level: number, tint: number): void {
    this.triggers.push({ type: 'dark', ...this.area(u0, y0, z0, u1, y1, z1), level, tint });
  }

  /** Ground all round the play area (|x| > X or |z| > Z), its top at y 0, out to the horizon. */
  outskirts(X: number, Z: number, mat: MatId): void {
    const F = 400;
    this.solids.push(box(-F, -1, -F, -X, 0, F, mat), box(X, -1, -F, F, 0, F, mat), box(-X, -1, -F, X, 0, -Z, mat), box(-X, -1, Z, X, 0, F, mat));
  }

  finish(id: string, name: string, seed: number, palette: Palette, extent: number, killY: number, prize: string): MapDef {
    // The weapons: one roll per key, in order, so a spot and its mirror image match.
    const rng = new Rng((seed ^ hashSeed(id)) >>> 0);
    const pool = WEAPON_TIERS.flatMap((ids, t) => ids.map((w) => ({ w, weight: TIER_WEIGHT[t] })));
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    const roll = (): WeaponId => {
      let r = rng.next() * total;
      for (const p of pool) if ((r -= p.weight) < 0) return p.w;
      return pool[pool.length - 1].w;
    };
    const rolled = new Map<string, WeaponId>();
    for (const s of this.spots) if (!rolled.has(s.key)) rolled.set(s.key, roll());
    // Now and then the prize spot in the middle holds a legendary (LEGENDARY_CHANCE), on its own roll.
    const luck = new Rng((seed ^ 0x51e9d4a7) >>> 0);
    if (LEGENDARIES.length && luck.next() < LEGENDARY_CHANCE) rolled.set(prize, LEGENDARIES[luck.int(0, LEGENDARIES.length - 1)]);
    return {
      name, seed: seed >>> 0, solids: this.solids, triggers: this.triggers, spawns: this.spawns,
      pickups: this.spots.map((s) => ({ pos: s.pos, weapon: rolled.get(s.key)! })),
      bots: [], killY, palette, extent,
      decor: this.decor, screens: this.screens, traffic: this.traffic, holos: this.holos, life: this.life, props: this.props,
    };
  }
}

/** A steady pseudo-random number 0..1 for a few numbers (scenery only: the same on every peer). */
function hash(a: number, b = 0, c = 0): number {
  const h = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return h - Math.floor(h);
}

/** A stepped pyramid of `tiers` layers, centred on (x, z), standing on y. */
function stepPyramid(k: Kit, x: number, z: number, y: number, half: number, tiers: number, step: number, mat: MatId): void {
  for (let i = 0; i < tiers; i++) {
    const h = half * (1 - i / tiers);
    k.solids.push(box(x - h, y + i * step, z - h, x + h, y + (i + 1) * step, z + h, mat));
  }
}

// =====================================================================
// SUNGATE OASIS
// Two temples of the sun face each other across the Nile. Each team spawns in
// its temple courtyard (a colonnade of papyrus columns, pharaohs and braziers)
// behind a great pylon gate whose tower tops are a walkway for sharpshooters.
// Sphinxes guard the gates. The north lane runs past a tomb (a mummy still walks
// it, in the dark) with a roof to climb; the south lane through the ruins of a
// hall of lotus columns, full of cobras. In the middle the river is crossed by
// two bridges and an island with a step pyramid (the prize on its capstone)
// between two obelisks; or wade it, under the bridges, among the reeds.
// On the horizon: the great pyramids, a camel caravan, and aliens building
// another pyramid block by block.
// =====================================================================

const OASIS_PALETTE: Palette = {
  sky: 0xf2c58a, fogNear: 70, fogFar: 300, sun: 0xffd59a, ambientSky: 0xffe2b8, ambientGround: 0x7a5a38,
  mats: {
    concrete: '#c8a874', concreteDark: '#8a6a44', tile: '#2fa39a', metal: '#a07040', hazard: '#e0b020', ice: '#a8d8e0', conveyor: '#4a3a2a', lava: '#ff7a1a',
    sand: '#e2c48c', sandstone: '#d7b479', stone: '#b39466', planks: '#8a5a30', log: '#6b4a2b', leaves: '#5a8a2a', water: '#2f86a8',
  },
};

function oasis(seed: number): MapDef {
  const k = new Kit();
  const GOLD = 0xffc84a;

  // ---- the middle: the river, the island and its step pyramid, two bridges ----
  k.box(-5, -2, -26, 5, -0.9, 26, 'water'); // the river bed (wade it: knee deep)
  k.box(-5, -1, -8, 5, 0, 8, 'sand'); // the island
  // The step pyramid: tiers you jump up (0.95 m each), the prize on the capstone.
  k.box(-3.5, 0, -3.5, 3.5, 0.95, 3.5, 'sandstone');
  k.box(-2.6, 0.95, -2.6, 2.6, 1.9, 2.6, 'sandstone');
  k.box(-1.7, 1.9, -1.7, 1.7, 2.85, 1.7, 'sandstone');
  k.box(-0.9, 2.85, -0.9, 0.9, 3.5, 0.9, 'stone');
  for (const [x0, z0, x1, z1] of [[-0.9, -0.9, 0.9, -0.8], [-0.9, 0.8, 0.9, 0.9], [-0.9, -0.8, -0.8, 0.8], [0.8, -0.8, 0.9, 0.8]]) k.glow(x0, 3.5, z0, x1, 3.56, z1, GOLD); // the gilded rim of the capstone
  k.spot(0, 3.5, 0, 'prize');
  k.prop('obelisk', 0, 0, 6.6, SOUTH);
  k.prop('obelisk', 0, 0, -6.6, NORTH);
  k.prop('lotusBowl', 0, 0, 4.6);
  k.prop('lotusBowl', 0, 0, -4.6);
  // The bridges, high enough to wade under.
  for (const z of [18, -18]) {
    k.box(-5, 1.2, z - 1.5, 5, 1.6, z + 1.5, 'planks');
    k.box(-5, 1.6, z - 1.5, 5, 2.3, z - 1.3, 'log');
    k.box(-5, 1.6, z + 1.3, 5, 2.3, z + 1.5, 'log');
    k.spot(0, 1.6, z, z > 0 ? 'bridgeN' : 'bridgeS');
  }
  // Under the bridges and round the banks: reeds and lotus in the water.
  for (const z of [-23, -12.5, 12.5, 23]) k.prop('papyrusReeds', 0, -0.9, z);

  // ---- each half ----
  k.half((k) => {
    k.box(5, -1, -26, 44, 0, 26, 'sand');
    // Boundary: the temple's back wall, low walls along the sides (the desert beyond).
    k.box(43, -1, -28, 45, 9, 28, 'sandstone');
    k.box(5, -1, 26, 45, 3.2, 28, 'sandstone');
    k.box(5, -1, -28, 45, 3.2, -26, 'sandstone');
    // Ghats: stone steps down into the river.
    for (const z of [-11.5, 11.5]) k.box(3.8, -0.9, z - 1.5, 5, -0.45, z + 1.5, 'stone');
    // Ramps up onto the bridges.
    for (const z of [18, -18]) k.ramp(5, 0, z - 1.5, 9, 1.6, z + 1.5, '-x', 'planks');

    // The pylon gate: two towers joined by a lintel, the tops one walkway (y 5).
    k.box(27, 0, 4, 31, 5, 14, 'sandstone');
    k.box(27, 0, -14, 31, 5, -4, 'sandstone');
    k.box(27, 4.4, -4, 31, 5, 4, 'sandstone');
    k.box(27, 5, -14, 27.5, 6, 14, 'sandstone'); // the parapet, facing the river
    for (const z of [-12, -6, 0, 6, 12]) k.glow(26.96, 5.2, z - 0.6, 27, 5.8, z + 0.6, k.team); // team lamps along the parapet
    k.ramp(31, 0, 10.5, 41, 5, 13.5, '-x', 'sandstone'); // up from the courtyard
    k.ramp(31, 0, -13.5, 41, 5, -10.5, '-x', 'sandstone');
    k.prop('mural', 27, 2.4, 9, IN);
    k.prop('mural', 27, 2.4, -9, IN);
    k.prop('eyeOfHorus', 27, 3.75, 0, IN); // over the gate
    k.prop('banner', 31, 2.6, 6, OUT);
    k.prop('banner', 31, 2.6, -6, OUT);
    k.spot(29, 5, 9);
    // Sphinxes guarding the gate, braziers in it.
    k.prop('sphinx', 22, 0, 8.5, IN);
    k.prop('sphinx', 22, 0, -8.5, IN);
    k.prop('brazier', 32.5, 0, 5.5, IN);
    k.prop('brazier', 32.5, 0, -5.5, IN);

    // The courtyard: where the team spawns.
    for (const u of [34, 37, 40]) for (const z of [8.5, -8.5]) k.prop('papyrusColumn', u, 0, z);
    k.prop('pharaoh', 42, 0, 1.6, IN);
    k.prop('pharaoh', 42, 0, -1.6, IN);
    k.prop('offeringTable', 41.4, 0, 0, IN);
    k.prop('ankh', 43, 2.6, 5, IN);
    k.prop('ankh', 43, 2.6, -5, IN);
    k.prop('scarab', 43, 5.5, 0, IN);
    k.prop('mural', 43, 4.5, 19.5, IN);
    k.prop('mural', 43, 4.5, -19.5, IN);
    k.glow(42.96, 7.4, -3, 43, 8, 3, GOLD); // the sun disc over the shrine
    for (const z of [-6, -2, 2, 6]) k.spawn(38.5, 0, z);
    k.spawn(35.5, 0, -4);
    k.spawn(35.5, 0, 4);
    // Further out, along the side lanes (respawns keep away from the enemy).
    k.spawn(37, 0, 20);
    k.spawn(37, 0, -20);
    k.prop('colossus', 41.2, 0, 17, IN);
    k.prop('colossus', 41.2, 0, -17, IN);

    // The field between the gate and the river: ruins and palms for cover.
    k.box(10, 0, -3.5, 17, 1.1, -2.3, 'sandstone'); // a fallen obelisk
    k.box(9, 0, -3.3, 10, 0.75, -2.5, 'sandstone'); // ...its broken tip
    k.box(14, 0, 3, 15.2, 1.4, 4.2, 'stone'); // column stumps
    k.box(18.5, 0, 0.6, 19.5, 0.8, 1.6, 'stone');
    k.prop('chariot', 16, 0, 11, IN);
    k.prop('stele', 24.5, 0, 0, IN);
    for (const z of [6.2, -6.2, 24, -24]) k.prop('palm', 7.3, 0, z);
    k.prop('palm', 11, 0, 15.5);
    k.prop('palm', 11, 0, -15.5);
    k.prop('papyrusReeds', 5.7, 0, 14.2);
    k.prop('papyrusReeds', 5.7, 0, -14.2);
    k.prop('papyrusReeds', 5.7, 0, 21.8);
    k.prop('papyrusReeds', 5.7, 0, -21.8);
    k.spot(13, 0, 7.5);
    k.spot(18, 0, -6);
    k.spot(8, 0, -9.5);

    // North lane: a mastaba tomb (doors at both ends, dark inside, the roof up a ramp).
    k.box(12, 0, 17, 20, 3, 17.6, 'sandstone');
    k.box(12, 0, 17.6, 12.6, 3, 20, 'sandstone');
    k.box(12, 0, 22, 12.6, 3, 26, 'sandstone');
    k.box(12, 2.3, 20, 12.6, 3, 22, 'sandstone');
    k.box(19.4, 0, 17.6, 20, 3, 20, 'sandstone');
    k.box(19.4, 0, 22, 20, 3, 26, 'sandstone');
    k.box(19.4, 2.3, 20, 20, 3, 22, 'sandstone');
    k.box(12, 3, 17, 20, 3.4, 26, 'sandstone');
    k.ramp(20, 0, 17, 24, 3.4, 19.5, '-x', 'sandstone');
    k.dark(12.6, 0, 17.6, 19.4, 3, 26, 0.55, 0x1a1008);
    k.prop('sarcophagus', 16, 0, 25, SOUTH);
    k.prop('canopicJars', 13.4, 0, 25.2);
    k.prop('ushabti', 18.6, 0, 25.3, SOUTH);
    k.prop('ushabti', 18.6, 0, 18.4, NORTH);
    k.prop('torch', 14, 1.9, 17.6, NORTH);
    k.prop('torch', 18, 1.9, 17.6, NORTH);
    k.prop('eyeOfHorus', 12, 2.65, 21, IN);
    k.prop('anubis', 11.2, 0, 19.2, IN);
    k.prop('anubis', 11.2, 0, 22.8, IN);
    k.life.push({ kind: 'mummy', a: k.pt(13.6, 0, 21.4), b: k.pt(18.4, 0, 21.4), size: 1, speed: 0.6 });
    k.spot(16, 0, 21);
    k.spot(16, 3.4, 22.5);

    // South lane: the ruined hall of lotus columns, and its snakes.
    for (const u of [10, 15, 20]) for (const z of [-17, -22]) k.prop('lotusColumn', u, 0, z);
    k.box(12, 0, -24.5, 13, 1.2, -19.5, 'sandstone');
    k.box(17, 0, -21, 18, 1.6, -15.5, 'sandstone');
    k.box(21.5, 0, -25, 25, 0.9, -23.5, 'stone');
    k.prop('stele', 24.5, 0, -17, IN);
    k.prop('canopicJars', 8, 0, -24.5);
    k.life.push({ kind: 'snakes', min: k.pt(9, 0, -25), max: k.pt(23, 0, -15), count: 5 });
    k.spot(20, 0, -19.5);

    // Butterflies over the reeds.
    k.life.push({ kind: 'swarm', center: k.pt(6, 1.6, 22), spread: 3, count: 6, colors: [0xffffff, 0xffe14a, 0x8ad8ff], size: 0.3 });
  });
  // (k.pt mirrors x, so the snakes' box has min and max the wrong way round on RED's side.)
  for (const l of k.life) if (l.kind === 'snakes' && l.min.x > l.max.x) [l.min.x, l.max.x] = [l.max.x, l.min.x];

  // ---- beyond the walls ----
  k.outskirts(45, 28, 'sand');
  // The great pyramids to the north, a smaller one to the west, dunes all round.
  stepPyramid(k, -40, 120, 0, 32, 16, 3.2, 'sandstone');
  stepPyramid(k, 35, 150, 0, 38, 18, 3.6, 'sandstone');
  stepPyramid(k, 95, 110, 0, 20, 10, 2.8, 'sandstone');
  stepPyramid(k, -120, -40, 0, 18, 9, 2.6, 'sandstone');
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2, r = 75 + hash(i) * 50;
    const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8, w = 10 + hash(i, 1) * 14, h = 2 + hash(i, 2) * 5;
    k.solids.push(box(x - w, 0, z - w * 0.6, x + w, h, z + w * 0.6, 'sand'));
  }
  for (let i = 0; i < 10; i++) k.props.push({ kind: 'palm', pos: v3(-70 + i * 15 + hash(i, 4) * 6, 0, 36 + hash(i, 5) * 10), yaw: hash(i, 6) * 6, variant: 0 });
  k.life.push({ kind: 'walkers', a: v3(-90, 0, 52), b: v3(90, 0, 52), count: 5, gap: 3.5, shape: 'camel', colors: [0xc89a5a, 0xb07a42, 0xd8b070], size: 1.1, speed: 1.1 });
  k.life.push({ kind: 'pyramidWorks', center: v3(0, 0, -125), block: 4, base: 13, prebuilt: 4, saucers: 6 });
  k.life.push({ kind: 'flock', center: v3(0, 16, 0), radius: 22, count: 7, color: 0xf4f0e8, size: 0.8, speed: 6 }); // ibises over the river
  k.life.push({ kind: 'wind', x0: -70, x1: 70, z0: -30, z1: 30, y0: 0.5, y1: 10, count: 140, color: 0xe2c48c, speed: 3 });
  k.life.push({ kind: 'clouds', x0: -300, x1: 300, boxes: [0, 1, 2, 3, 4, 5].map((i) => ({ x: -250 + i * 100, y: 70 + hash(i, 7) * 20, z: -150 + hash(i, 8) * 300, w: 30, d: 14 })), speed: 1.5 });

  return k.finish('oasis', 'SUNGATE OASIS', seed, OASIS_PALETTE, 46, -22, 'prize');
}

// =====================================================================
// ARCADE SKYLINE
// Night over a megacity. Each team holds a rooftop; between them a highway
// canyon drops forty storeys to the traffic (fall in and you are gone). Cross
// on the open glass bridge (the prize lies in the middle of it), hop the
// hovering stepping pads, ride a shuttle platform, or climb your billboard
// tower and duel on the skybridge six metres up. The rooftops are a retro
// playground: giant arcade cabinets, a cassette tape the size of a wall, a
// puzzle cube, a joystick, a floppy disk to stand on. Neon in each team's
// colour, screens flickering, holograms over the canyon, flying traffic.
// =====================================================================

const SKYLINE_PALETTE: Palette = {
  sky: 0x1c0b34, fogNear: 55, fogFar: 260, sun: 0xd0a0ff, ambientSky: 0xb890ff, ambientGround: 0x3a1848,
  mats: {
    concrete: '#3a3f56', concreteDark: '#22252f', tile: '#3a2266', metal: '#4e5f88', hazard: '#ff2e88', ice: '#2a6a9a', conveyor: '#22242e', lava: '#ff3a8a',
    glass: '#ffd890', panel: '#2ee8ff', panelAlt: '#ff2e88', iron: '#33363f', silver: '#c8ccd8',
  },
};

const NEON = [0x2ee8ff, 0xff2e88, 0xffe14a, 0x8aff3a, 0xb45ae8];

function skyline(seed: number): MapDef {
  const k = new Kit();

  // ---- the canyon (x -6..6): the ways across ----
  // The glass bridge: wide open, the prize in the middle.
  k.box(-6, -0.4, -2.5, 6, 0, 2.5, 'metal');
  for (const z of [-2.5, 2.3]) {
    k.box(-6, 0, z, 6, 1, z + 0.2, 'iron');
    k.glow(-6, 1, z, 6, 1.06, z + 0.2, 0x2ee8ff);
  }
  k.glow(-6, -0.6, -2.3, 6, -0.4, 2.3, 0xff2e88); // lit from underneath
  k.spot(0, 0, 0, 'prize');
  // The stepping pads: three running jumps.
  for (const x of [-2.4, 2.4]) {
    k.box(x - 1.2, -0.5, -13, x + 1.2, 0, -10, 'metal');
    k.glow(x - 1.2, -0.7, -12.8, x + 1.2, -0.5, -10.2, 0xffe14a);
  }
  k.spot(-2.4, 0, -11.5, 'pads');
  k.spot(2.4, 0, -11.5, 'pads');
  // Two shuttles, one setting out from each side.
  const shuttle = { dy: 0, dz: 0, moveTime: 3.2, waitA: 1.6, waitB: 1.6, phase: 0 };
  k.solids.push({ ...box(-6, -0.4, 15, -2, 0, 18.5, 'panel'), mover: { ...shuttle, dx: 8 } });
  k.solids.push({ ...box(2, -0.4, -19.5, 6, 0, -16, 'panel'), mover: { ...shuttle, dx: -8 } });
  // The skybridge between the billboard towers, six metres up.
  k.box(-9, 5.6, 10, 9, 6, 12, 'metal');
  k.glow(-9, 5.4, 10.2, 9, 5.6, 11.8, 0xb45ae8);
  k.spot(0, 6, 11, 'sky');
  // Far below: the highway, both ways, two decks.
  for (const [x, y, dir, color] of [[-3, -18, 1, 0xfff2d0], [3, -18, -1, 0xff3a3a], [-2, -26, -1, 0xff3a3a], [2, -26, 1, 0xfff2d0]] as const) {
    k.traffic.push({ a: v3(x, y, -160 * dir), b: v3(x, y, 160 * dir), color, count: 30, speed: 22 + hash(x, y) * 8 });
  }
  k.holos.push({ pos: v3(0, 24, 0), size: 6, color: 0x2ee8ff, kind: 0 });
  k.holos.push({ pos: v3(0, 30, -60), size: 9, color: 0xff2e88, kind: 1 });
  k.holos.push({ pos: v3(0, 34, 60), size: 8, color: 0xffe14a, kind: 3 });
  k.life.push({ kind: 'swarm', center: v3(0, 8, 0), spread: 10, count: 16, colors: NEON, size: 0.12, glow: true });

  // ---- each rooftop ----
  k.half((k) => {
    const team = k.team;
    // The tower under the roof, and the roof.
    k.box(6, -60, -23, 44, -0.5, 23, 'glass');
    k.box(6, -0.5, -23, 44, 0, 23, 'concrete');
    k.screen(5.8, -14, -18, 6, -3, -8, '-x', k.s > 0 ? 2 : 5); // billboards down the canyon wall
    k.screen(5.8, -24, 4, 6, -6, 9, '-x', k.s > 0 ? 8 : 11);
    // Parapets: too high to hop over on the sides, waist high along the canyon (mind the drop).
    k.box(6, 0, 22.4, 44, 1.4, 23, 'concreteDark');
    k.box(6, 0, -23, 44, 1.4, -22.4, 'concreteDark');
    k.glow(6, 1.4, 22.4, 44, 1.48, 23, team);
    k.glow(6, 1.4, -23, 44, 1.48, -22.4, team);
    for (const [z0, z1] of [[-22.4, -19.5], [-16, -13], [-10, -2.5], [2.5, 15], [18.5, 22.4]]) {
      k.box(6, 0, z0, 6.4, 1, z1, 'iron');
      k.glow(6, 1, z0, 6.4, 1.05, z1, team);
    }
    // The back wall and its giant screen.
    k.box(43, 0, -23, 44, 9, 23, 'concreteDark');
    k.screen(42.8, 2, -10, 43, 8.5, 10, '-x', k.s > 0 ? 3 : 7);
    k.glow(42.9, 8.6, -10.2, 43, 8.8, 10.2, team);
    for (const z of [-20, 20]) k.glow(42.6, 2, z - 0.4, 43, 8.8, z + 0.4, NEON[(z > 0 ? 1 : 0) + (k.s > 0 ? 2 : 0)]); // neon pillars

    // The arcade's entrance: a canopy over the spawn.
    for (const [u, z] of [[33, -7], [33, 6.4], [40.4, -7], [40.4, 6.4]]) k.box(u, 0, z, u + 0.6, 4, z + 0.6, 'iron');
    k.box(33, 4, -7.5, 41, 4.4, 7.5, 'metal');
    k.glow(32.9, 4, -7.5, 33, 4.4, 7.5, team); // the marquee
    k.screen(32.8, 4.6, -5, 33, 6.4, 5, '-x', k.s > 0 ? 4 : 9);
    for (const u of [36, 39]) for (const z of [-4, 0, 4]) k.spawn(u, 0, z);
    k.spawn(37, 0, 18);
    k.spawn(37, 0, -18);
    k.prop('flag', 41.5, 0, -6, IN);
    k.prop('flag', 41.5, 0, 6, IN);
    k.prop('plant', 32, 0, 8.6);
    k.prop('plant', 32, 0, -8.6);

    // Arcade cabinets (cover), screens facing the canyon.
    const cabinet = (u: number, z: number, style: number) => {
      k.box(u - 0.6, 0, z - 0.8, u + 0.6, 2.6, z + 0.8, 'iron');
      k.box(u - 1, 0.9, z - 0.75, u - 0.6, 1.1, z + 0.75, 'metal');
      k.screen(u - 0.62, 1.3, z - 0.6, u - 0.6, 2.1, z + 0.6, '-x', style);
      k.glow(u - 0.65, 2.2, z - 0.7, u - 0.6, 2.5, z + 0.7, NEON[style % NEON.length]);
      k.glow(u - 0.9, 1.1, z - 0.3, u - 0.75, 1.15, z - 0.15, 0xff3040);
      k.glow(u - 0.9, 1.1, z + 0.15, u - 0.75, 1.15, z + 0.3, 0x3aff60);
    };
    cabinet(31, -12, 1);
    cabinet(31, -14, 6);
    cabinet(31, 12, 10);
    cabinet(31, 14, 0);
    k.spot(28, 0, -13);
    k.spot(28, 0, 13);

    // A cassette tape on its edge, as tall as a wall: shoot through the reels.
    const cu = 20, c0 = 19.6, c1 = 20.4;
    k.box(c0, 0, -9, c1, 1.2, -3, 'concreteDark');
    k.box(c0, 2.6, -9, c1, 3.8, -3, 'concreteDark');
    for (const [z0, z1] of [[-9, -8.2], [-6.6, -5.4], [-3.8, -3]]) k.box(c0, 1.2, z0, c1, 2.6, z1, 'concreteDark');
    for (const zc of [-7.4, -4.6]) k.glow(cu - 0.1, 1.7, zc - 0.2, cu + 0.1, 2.1, zc + 0.2, 0xf4f4f0); // reel hubs
    k.glow(c0 - 0.04, 2.9, -8.6, c0, 3.5, -3.4, 0xffe14a); // the label
    k.glow(c1, 2.9, -8.6, c1 + 0.04, 3.5, -3.4, 0xffe14a);
    k.spot(22, 0, -6);

    // A puzzle cube, mid-twist colours on every side.
    const q = 22, qz = 6, h = 1.35, cell = 0.9;
    k.box(q - h, 0, qz - h, q + h, 2 * h, qz + h, 'concreteDark');
    const colours = [0xff3030, 0x30d040, 0x3070ff, 0xffe030, 0xf4f4f0, 0xff8a20];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const c = (f: number) => colours[Math.floor(hash(i + f * 3, j) * 6)]; // (the same pattern on both sides)
      const a = -h + 0.06 + i * cell, b = a + cell - 0.12, y = 0.06 + j * cell, t = y + cell - 0.12;
      k.glow(q - h - 0.03, y, qz + a, q - h, t, qz + b, c(0));
      k.glow(q + h, y, qz + a, q + h + 0.03, t, qz + b, c(1));
      k.glow(q + a, y, qz - h - 0.03, q + b, t, qz - h, c(2));
      k.glow(q + a, y, qz + h, q + b, t, qz + h + 0.03, c(3));
      k.glow(q + a, 2 * h, qz - h + 0.06 + j * cell, q + b, 2 * h + 0.03, qz - h + j * cell + cell - 0.06, c(4));
    }

    // A joystick, ball and all.
    k.box(13.8, 0, -18.2, 16.2, 0.8, -15.8, 'iron');
    k.box(14.8, 0.8, -17.2, 15.2, 3.2, -16.8, 'iron');
    k.glow(14.4, 3.2, -17.6, 15.6, 4.4, -16.4, 0xff3040);
    k.glow(14.1, 0.8, -15.9 - 0.6, 14.5, 0.86, -15.9 - 0.2, 0xffe14a);
    k.glow(15.5, 0.8, -15.9 - 0.6, 15.9, 0.86, -15.9 - 0.2, 0x2ee8ff);
    k.spot(12, 0, -18);

    // A floppy disk to stand on: metal shutter, white label.
    k.box(16, 0, 14, 20.5, 0.9, 18.5, 'metal');
    k.box(17.2, 0.9, 14, 19.3, 0.95, 15.6, 'silver');
    k.glow(16.6, 0.9, 16.4, 19.9, 0.93, 18.2, 0xf4f4f0);
    k.spot(18.2, 0.9, 17.3);

    // The billboard tower: a ramp up behind, the skybridge off the front.
    k.box(9, 0, 9, 13, 6, 13, 'concreteDark');
    k.ramp(13, 0, 9.3, 21, 6, 11.3, '-x', 'metal');
    k.box(9, 6, 12.7, 13, 6.9, 13, 'iron');
    k.box(9, 6, 9, 13, 6.9, 9.3, 'iron');
    k.glow(9, 6.9, 12.7, 13, 6.95, 13, team);
    k.glow(9, 6.9, 9, 13, 6.95, 9.3, team);
    k.screen(8.8, 0.5, 9.2, 9, 5.3, 12.8, '-x', k.s > 0 ? 0 : 6);
    k.spot(11, 6, 11.4);

    // Rooftop clutter: air conditioners, a water tank on legs.
    k.box(25, 0, -21, 27, 1.3, -19, 'iron');
    k.box(35, 0, -21.5, 37.5, 1.3, -20, 'iron');
    for (const [u, z] of [[24.5, 17.5], [27, 17.5], [24.5, 20], [27, 20]]) k.box(u, 0, z, u + 0.3, 3, z + 0.3, 'iron');
    k.box(24.2, 3, 17.2, 27.6, 5.6, 20.6, 'metal');
    k.glow(24.15, 4.2, 17.2, 24.2, 4.4, 20.6, team);
    k.spot(27, 0, 1);
  });

  // ---- the city all round ----
  for (let gx = -7; gx <= 7; gx++) for (let gz = -7; gz <= 7; gz++) {
    const cx = gx * 16 + (hash(gx, gz) - 0.5) * 4, cz = gz * 16 + (hash(gz, gx) - 0.5) * 4;
    const w = 4 + hash(gx, gz, 1) * 3, d = 4 + hash(gx, gz, 2) * 3;
    if (Math.abs(cx) - w < 8) continue; // the canyon stays open
    if (Math.abs(cx) - w < 52 && Math.abs(cz) - d < 30) continue; // nothing near enough to jump to
    if (hash(gx, gz, 3) < 0.12) continue;
    const top = -20 + hash(gx, gz, 4) * 80;
    k.solids.push(box(cx - w, -60, cz - d, cx + w, top, cz + d, 'glass'));
    k.decor.push({ min: v3(cx - w - 0.05, top, cz - d - 0.05), max: v3(cx + w + 0.05, top + 0.3, cz + d + 0.05), color: NEON[Math.floor(hash(gx, gz, 5) * NEON.length)] });
    if (hash(gx, gz, 6) < 0.3) {
      // A billboard on the side facing the arena.
      const alongX = Math.abs(cx) > Math.abs(cz);
      const face = alongX ? (cx > 0 ? '-x' : '+x') : (cz > 0 ? '-z' : '+z');
      const y0 = top - 14, y1 = top - 4;
      if (alongX) { const fx = cx > 0 ? cx - w - 0.2 : cx + w; k.screens.push({ min: v3(fx, y0, cz - d * 0.7), max: v3(fx + 0.2, y1, cz + d * 0.7), face, style: (gx * 7 + gz * 3 + 99) % 12 }); }
      else { const fz = cz > 0 ? cz - d - 0.2 : cz + d; k.screens.push({ min: v3(cx - w * 0.7, y0, fz), max: v3(cx + w * 0.7, y1, fz + 0.2), face, style: (gx * 5 + gz * 11 + 99) % 12 }); }
    }
    if (top > 40 && hash(gx, gz, 7) < 0.35) k.holos.push({ pos: v3(cx, top + 12, cz), size: 4 + hash(gx, gz, 8) * 4, color: NEON[Math.floor(hash(gx, gz, 9) * NEON.length)], kind: Math.floor(hash(gx, gz, 10) * 4) });
  }
  // Flying traffic between the towers.
  for (let i = 0; i < 6; i++) {
    const y = 18 + i * 7, z = (i % 2 ? 1 : -1) * (45 + i * 12);
    k.traffic.push({ a: v3(-200, y, z), b: v3(200, y, z), color: NEON[i % NEON.length], count: 8, speed: 28 + i * 4 });
    k.traffic.push({ a: v3((i % 2 ? -1 : 1) * (70 + i * 10), y + 3, 200), b: v3((i % 2 ? -1 : 1) * (70 + i * 10), y + 3, -200), color: 0xfff2d0, count: 8, speed: 30 });
  }
  k.life.push({ kind: 'walkers', a: v3(-60, 12.5, -45), b: v3(-44, 12.5, -45), count: 2, gap: 3, shape: 'alien', colors: [0x8aff3a], size: 1, speed: 0.7 });

  return k.finish('skyline', 'ARCADE SKYLINE', seed, SKYLINE_PALETTE, 46, -30, 'prize');
}

// =====================================================================
// FROSTFANG FJORD
// A frozen lake in a fjord at dusk, the aurora overhead and a dragon circling
// higher still. Each team spawns in its Viking longhouse (a hearth fire down
// the middle, benches, tapestries) whose snow-drifted roof you can run up.
// In the middle of the lake a longship lies frozen in the ice: board it through
// the gaps in its shields, the prize on its deck. North of it the coils of the
// world serpent arch out of the ice, its skull grinning; beyond, a ring of
// rune stones before a frozen waterfall. South, the great ash tree stands in a
// pine wood. Each team has a watchtower. Fishing holes lie
// open to the dark water. Two ravens circle; wolves pace the ridge.
// =====================================================================

const FJORD_PALETTE: Palette = {
  sky: 0x5c78a8, fogNear: 45, fogFar: 260, sun: 0xdce8ff, ambientSky: 0xc8d8f0, ambientGround: 0x48526a,
  mats: {
    concrete: '#9aa4b0', concreteDark: '#5a6470', tile: '#3a5a7a', metal: '#5a6068', hazard: '#d9a520', ice: '#a8d8ec', conveyor: '#33383d', lava: '#ff6a1a',
    snow: '#eef3f8', log: '#5e4028', planks: '#7a5634', stone: '#7c8288', leaves: '#2f4f3a', water: '#1e4a6a', basalt: '#3a3d48', iron: '#4a4c52',
  },
};

const AURORA = [0x5affb0, 0x3ae8c0, 0x8a6aff, 0x5ad8ff];
const RUNE = 0x6af0ff;

/** A snowy pine: a trunk you can hide behind, tiers of branches above head height, snow on each. */
function pine(k: Kit, u: number, z: number, h: number): void {
  k.box(u - 0.35, 0, z - 0.35, u + 0.35, h * 0.8, z + 0.35, 'log');
  for (let i = 0; i < 3; i++) {
    const w = 1.8 - i * 0.5, y = 2.1 + i * (h - 2.1) / 3.2, t = y + 0.9;
    k.box(u - w, y, z - w, u + w, t, z + w, 'leaves');
    k.box(u - w + 0.15, t, z - w + 0.15, u + w - 0.15, t + 0.2, z + w - 0.15, 'snow');
  }
}

function fjord(seed: number): MapDef {
  const k = new Kit();

  // ---- the lake (x -14..14, z -12..12) and its shores ----
  k.box(-14, -1, -12, 14, -0.35, 12, 'ice', 'ice');
  k.box(-14, -1, 12, 14, 0, 25, 'snow');
  k.box(-14, -1, -25, 14, 0, -12, 'snow');
  // Fishing holes cut in the ice, lanterns beside them. (Harmless: on ice nobody, bots least of all, could keep out of a deadly one.)
  for (const x of [-7.5, 7.5]) {
    k.box(x - 0.8, -0.35, -5.6, x + 0.8, -0.34, -4, 'water', 'ice');
    k.prop('lantern', x, -0.35, -3.2);
  }

  // The longship, frozen in the ice: a deck to fight over, gaps in the gunwales to board by.
  k.box(-1.6, -0.35, -8.5, 1.6, 0.3, 1.5, 'planks');
  for (const x of [-1.8, 1.6]) for (const [z0, z1] of [[-8.5, -6], [-4, -2], [0, 1.5]]) {
    k.box(x, -0.35, z0, x + 0.2, 1.1, z1, 'planks');
    for (let z = z0 + 0.15; z + 0.7 <= z1; z += 0.85) k.glow(x < 0 ? x - 0.04 : x + 0.2, 0.2, z, x < 0 ? x : x + 0.24, 0.9, z + 0.7, hash(z, x) < 0.5 ? 0xb8322a : 0xd9a920); // shields
  }
  k.box(-1.2, -0.35, 1.5, 1.2, 0.9, 2.7, 'planks'); // the prow...
  k.box(-0.6, -0.35, 2.7, 0.6, 1.4, 3.7, 'planks');
  k.box(-0.3, 1.4, 3.1, 0.3, 3.6, 3.7, 'log'); // ...rising to a dragon's head
  k.box(-0.35, 3.2, 3.7, 0.35, 3.8, 4.5, 'log');
  k.glow(-0.37, 3.55, 4.1, -0.35, 3.7, 4.3, 0xffb030);
  k.glow(0.35, 3.55, 4.1, 0.37, 3.7, 4.3, 0xffb030);
  k.box(-1.2, -0.35, -9.7, 1.2, 0.9, -8.5, 'planks'); // the stern...
  k.box(-0.6, -0.35, -10.7, 0.6, 1.4, -9.7, 'planks');
  k.box(-0.3, 1.4, -10.7, 0.3, 3.4, -10.1, 'log'); // ...and its curled tail
  k.box(-0.3, 3, -11.3, 0.3, 3.4, -10.7, 'log');
  k.box(-0.2, 0.3, -3.2, 0.2, 7.5, -2.8, 'log'); // the mast, the yard and a striped sail
  k.box(-3.2, 6.3, -3.15, 3.2, 6.6, -2.85, 'log');
  for (let i = 0; i < 6; i++) k.decor.push({ min: v3(-3 + i, 3.2, -3.1), max: v3(-2 + i, 6.3, -3.06), color: i % 2 ? 0xe8dcc0 : 0xb8322a });
  k.spot(0, 0.3, -5, 'prize');

  // The world serpent: its coils arch out of the ice, its skull faces the ship.
  for (const [x, h] of [[5, 3], [9, 2.6], [12.5, 2.1]]) for (const s of [-1, 1]) {
    const cx = s * x;
    k.box(cx - 1.6, -0.35, 7.5, cx - 0.8, h, 9.3, 'basalt');
    k.box(cx + 0.8, -0.35, 7.5, cx + 1.6, h, 9.3, 'basalt');
    k.box(cx - 1.6, h, 7.5, cx + 1.6, h + 0.8, 9.3, 'basalt');
    k.glow(cx - 1.2, h + 0.8, 8.2, cx + 1.2, h + 1.1, 8.6, RUNE); // glowing spines
  }
  k.box(-2, -0.35, 7, 2, 1.8, 10.6, 'basalt');
  k.box(-1.3, -0.35, 5.8, 1.3, 1.2, 7, 'basalt');
  k.glow(-1.6, 1.25, 6.94, -0.9, 1.6, 7, RUNE); // eyes
  k.glow(0.9, 1.25, 6.94, 1.6, 1.6, 7, RUNE);
  for (const x of [-1, -0.5, 0.4, 0.9]) k.glow(x, 0.3, 5.76, x + 0.12, 0.9, 5.8, 0xf4f0e0); // fangs
  k.box(-0.9, 1.8, 9, 0.9, 2.6, 10.4, 'basalt'); // the brow

  // North shore: a ring of rune stones before a frozen waterfall.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8, x = Math.cos(a) * 4.2, z = 18 + Math.sin(a) * 4.2;
    const along = Math.abs(Math.cos(a)) > Math.abs(Math.sin(a));
    const hx = along ? 0.3 : 0.5, hz = along ? 0.5 : 0.3, top = 2.2 + hash(Math.round(Math.abs(x) * 10), Math.round(z * 10)) * 0.8; // (by |x|: the ring is a mirror image too)
    k.box(x - hx, 0, z - hz, x + hx, top, z + hz, 'stone');
    k.box(x - hx + 0.05, top, z - hz + 0.05, x + hx - 0.05, top + 0.15, z + hz - 0.05, 'snow');
    k.glow(x - hx - 0.02, 1, z - hz - 0.02, x + hx + 0.02, 1.6, z + hz + 0.02, RUNE);
  }
  k.prop('brazier', 0, 0, 18, SOUTH);
  k.spot(0, 0, 15.2, 'runes');
  k.box(-50, -1, 25, 50, 14, 32, 'stone'); // the fjord's north cliff
  k.box(-50, 14, 25, 50, 14.6, 32, 'snow');
  k.box(-4, 0, 24, 4, 13, 25, 'ice'); // the frozen waterfall
  k.life.push({ kind: 'fall', min: v3(-3.5, 0, 23.6), max: v3(3.5, 13, 24), color: 0xbfe8ff, speed: 1 });

  // South shore: the great ash tree.
  k.box(-1.2, 0, -19.2, 1.2, 9, -16.8, 'log');
  for (const [x0, z0, x1, z1] of [[-2.4, -18.4, -1.2, -17.6], [1.2, -18.4, 2.4, -17.6], [-0.4, -20.4, 0.4, -19.2], [-0.4, -16.8, 0.4, -15.8]]) k.box(x0, 0, z0, x1, 0.6, z1, 'log'); // roots
  k.box(-6, 6.5, -18.4, 6, 7.1, -17.6, 'log'); // branches
  k.box(-0.4, 6.5, -23, 0.4, 7.1, -13, 'log');
  for (const [x0, y0, z0, x1, y1, z1] of [[-7, 7.1, -22, 7, 9, -14], [-5, 9, -21, 5, 10.8, -15], [-3, 10.8, -20, 3, 12.2, -16]]) {
    k.box(x0, y0, z0, x1, y1, z1, 'leaves');
    k.box(x0 + 0.3, y1, z0 + 0.3, x1 - 0.3, y1 + 0.3, z1 - 0.3, 'snow');
  }
  for (const y of [2, 3.5, 5]) k.glow(-1.24, y, -18.3, -1.2, y + 0.6, -17.7, RUNE); // runes on its bark
  for (const y of [2, 3.5, 5]) k.glow(1.2, y, -18.3, 1.24, y + 0.6, -17.7, RUNE);
  k.life.push({ kind: 'swarm', center: v3(0, 4, -18), spread: 5, count: 12, colors: [RUNE, 0xffe9a0], size: 0.12, glow: true });
  k.spot(0, 0, -14.2, 'tree');
  k.box(-50, -1, -32, 50, 6, -25, 'stone'); // the southern ridge
  k.box(-50, 6, -32, 50, 6.5, -25, 'snow');

  // ---- each half ----
  k.half((k) => {
    k.box(14, -1, -25, 46, 0, 25, 'snow');
    // The palisade at your back.
    k.box(44, 0, -25, 45, 4.5, 25, 'log');
    for (let z = -24.5; z < 25; z += 1.25) k.box(44.05, 4.5, z, 44.95, 5 + hash(z) * 0.6, z + 0.6, 'log');

    // The longhouse.
    const H = 3.4;
    k.box(30, 0, -6, 30.6, H, -2, 'log'); // the front, a wide door in the middle
    k.box(30, 0, 2, 30.6, H, 6, 'log');
    k.box(30, 2.8, -2, 30.6, H, 2, 'log');
    k.box(41.4, 0, -6, 42, H, 6, 'log'); // the back
    for (const z0 of [-6, 5.4]) { // the sides, a door in each
      k.box(30.6, 0, z0, 34, H, z0 + 0.6, 'log');
      k.box(36, 0, z0, 41.4, H, z0 + 0.6, 'log');
      k.box(34, 2.6, z0, 36, H, z0 + 0.6, 'log');
    }
    k.ramp(29.4, H, -6.6, 42.6, 6, 0, '+z', 'planks'); // the roof, walkable
    k.ramp(29.4, H, 0, 42.6, 6, 6.6, '-z', 'planks');
    k.box(29.2, 5.6, -0.9, 29.6, 6.6, -0.5, 'log'); // crossed gable boards
    k.box(29.2, 5.6, 0.5, 29.6, 6.6, 0.9, 'log');
    k.ramp(37.5, 0, 6.6, 42.5, H, 12, '-z', 'snow'); // a snowdrift up onto the roof
    k.spot(36, 6, 0);
    // Inside: the hearth, benches, tapestries, torchlight.
    k.dark(30.6, 0, -5.4, 41.4, H, 5.4, 0.35, 0x201008);
    const F = 0.05; // the plank floor's top (over the snow)
    k.box(30.6, -0.5, -5.4, 41.4, F, 5.4, 'planks');
    k.box(33, 0, -1, 39, 0.3, 1, 'stone');
    k.life.push({ kind: 'flame', pos: k.pt(34.5, 0.5, 0), size: 0.8 });
    k.life.push({ kind: 'flame', pos: k.pt(37.5, 0.5, 0), size: 0.8 });
    for (const u of [33, 38]) for (const z of [-4.1, 4.1]) k.prop('bench', u, F, z, z > 0 ? NORTH : SOUTH);
    k.prop('tapestry', 41.4, 1.8, 0, IN);
    k.prop('torch', 30.6, 2, 4, OUT);
    k.prop('torch', 30.6, 2, -4, OUT);
    k.prop('banner', 30, 2.2, 4, IN);
    k.prop('banner', 30, 2.2, -4, IN);
    k.glow(29.96, 2.9, -1.8, 30, 3.3, 1.8, k.team); // the team's colours over the door
    k.prop('brazier', 28.8, 0, 3.2, IN);
    k.prop('brazier', 28.8, 0, -3.2, IN);
    k.prop('stele', 27.5, 0, 6.5, IN);
    k.prop('stele', 27.5, 0, -6.5, IN);
    for (const z of [-3, 0, 3]) k.spawn(40.5, F, z);
    k.spawn(36, F, -2.6);
    k.spawn(36, F, 2.6);
    k.spawn(31.6, F, 0);
    k.spawn(38, 0, 18);
    k.spawn(38, 0, -18);

    // The watchtower: posts, a platform with a rail to hide behind, a roof, a ramp up.
    for (const [u, z] of [[21.6, 14.6], [25, 14.6], [21.6, 18], [25, 18]]) k.box(u, 0, z, u + 0.4, 7.2, z + 0.4, 'log');
    k.box(21.6, 4, 14.6, 25.4, 4.4, 18.4, 'planks');
    k.box(21.6, 4.4, 14.6, 21.9, 5.3, 18.4, 'log');
    k.box(21.6, 4.4, 18.1, 25.4, 5.3, 18.4, 'log');
    k.box(21.6, 4.4, 14.6, 25.4, 5.3, 14.9, 'log');
    k.box(21.4, 7.2, 14.4, 25.6, 7.5, 18.6, 'planks');
    k.box(21.6, 7.5, 14.6, 25.4, 7.7, 18.4, 'snow');
    k.ramp(25.4, 0, 15, 31.4, 4.4, 17, '-x', 'planks');
    k.prop('lantern', 22.6, 4.4, 17.4);
    k.spot(23.6, 4.4, 16.3);

    // The field: a snow fort, a woodpile, a sled, boulders.
    k.box(17, 0, 2, 17.6, 1.1, 6.5, 'snow');
    k.box(17, 0, 6.5, 20, 1.1, 7.1, 'snow');
    k.box(17, 0, 1.4, 20, 1.1, 2, 'snow');
    k.spot(18.6, 0, 4.2);
    k.box(24, 0, -6, 27, 1.3, -4.6, 'log');
    k.box(24.3, 1.3, -5.8, 26.7, 1.5, -4.8, 'snow');
    k.spot(25.5, 0, -8);
    k.box(19.5, 0, 10.5, 21.5, 0.5, 11.5, 'planks'); // an overturned sled
    k.box(26, 0, 9, 28, 1.2, 10.8, 'stone');
    k.box(26.2, 1.2, 9.2, 27.8, 1.4, 10.6, 'snow');
    k.spot(27, 0, 12.5);

    // The pine wood to the south, boulders between the trunks.
    for (const [u, z, h] of [[16, -16, 6], [19.5, -21.5, 7], [23, -15.5, 6.5], [26.5, -21, 7.5], [29.5, -15, 6], [33, -20.5, 7], [37, -14.5, 6.5], [40.5, -21, 7]]) pine(k, u, z, h);
    k.box(20.5, 0, -18.5, 22.3, 1.3, -17, 'stone');
    k.box(20.7, 1.3, -18.3, 22.1, 1.5, -17.2, 'snow');
    k.box(31, 0, -18.4, 32.6, 1.1, -16.8, 'stone');
    k.spot(25, 0, -18.4);
    k.spot(16, 0, -11);
  });

  // ---- the sky and the mountains ----
  k.outskirts(46, 25, 'snow');
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1, x = side * (70 + hash(i) * 60), z = -120 + i * 18, w = 14 + hash(i, 1) * 16, h = 30 + hash(i, 2) * 45;
    k.solids.push(box(x - w, 0, z - w, x + w, h * 0.6, z + w, 'stone'));
    k.solids.push(box(x - w * 0.6, h * 0.6, z - w * 0.6, x + w * 0.6, h, z + w * 0.6, 'snow'));
  }
  for (let i = 0; i < 10; i++) {
    const x = -135 + i * 30, w = 14 + hash(i, 3) * 10, h = 22 + hash(i, 4) * 22, z = 130 + hash(i, 5) * 30; // far enough back for the aurora to show over them
    k.solids.push(box(x - w, 0, z, x + w, h, z + w * 1.5, 'stone'));
    k.solids.push(box(x - w * 0.7, h, z + 2, x + w * 0.7, h + 6, z + w * 1.2, 'snow'));
  }
  // The aurora: rippling ribbons of light.
  for (let r = 0; r < 3; r++) for (let i = 0; i < 26; i++) {
    const x = -130 + i * 10, y = 55 + r * 9 + Math.sin(i * 0.55 + r) * 5, z = 60 + r * 18 + Math.sin(i * 0.3 + r * 2) * 14;
    k.decor.push({ min: v3(x, y, z), max: v3(x + 10.2, y + 5 + Math.sin(i * 0.9) * 1.5, z + 0.6), color: AURORA[(i + r) % AURORA.length] });
  }
  k.life.push({ kind: 'dragon', center: v3(0, 48, 0), radius: 70, size: 1.1, speed: 9 });
  k.life.push({ kind: 'flock', center: v3(0, 18, 0), radius: 16, count: 2, color: 0x111114, size: 1, speed: 6 }); // two ravens
  k.life.push({ kind: 'walkers', a: v3(-40, 14.6, 28), b: v3(40, 14.6, 28), count: 2, gap: 2.5, shape: 'beast', colors: [0x6a6e78, 0x9a9ea8], size: 0.9, speed: 1.2 }); // wolves on the cliff
  k.life.push({ kind: 'wind', x0: -60, x1: 60, z0: -26, z1: 26, y0: 0.5, y1: 22, count: 260, color: 0xffffff, speed: 1.4 }); // snow
  k.life.push({ kind: 'clouds', x0: -300, x1: 300, boxes: [0, 1, 2, 3, 4].map((i) => ({ x: -250 + i * 120, y: 85 + hash(i, 9) * 15, z: -160 + hash(i, 10) * 120, w: 36, d: 16 })), speed: 1 });

  return k.finish('fjord', 'FROSTFANG FJORD', seed, FJORD_PALETTE, 46, -22, 'prize');
}

/** Every team map, in the rotation or not (see `off`). */
export const TEAM_MAPS: TeamMap[] = [
  { id: 'team:oasis', name: 'SUNGATE OASIS', build: oasis, off: true }, // disabled for now: delete `off` to bring it back
  { id: 'team:skyline', name: 'ARCADE SKYLINE', build: skyline },
  { id: 'team:fjord', name: 'FROSTFANG FJORD', build: fjord },
];

/** A team map by id (as sent in MatchState.mapId), or undefined. Finds disabled ones too (a host may still have one on). */
export const teamMap = (id: string | undefined): TeamMap | undefined => TEAM_MAPS.find((m) => m.id === id);

/**
 * The team map for a match: from the seed, but never the one just played
 * (`last`, its id), so back-to-back matches change scenery.
 */
export function pickTeamMap(seed: number, last?: string): TeamMap {
  const on = TEAM_MAPS.filter((m) => !m.off);
  const pool = on.length > 1 ? on.filter((m) => m.id !== last) : on;
  return pool[(seed >>> 0) % pool.length];
}
