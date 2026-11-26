// Decorations for the map lab: paintings, lamps, statues and the like. Pure
// data (no rendering): what each kind is called, how big it is, and whether it
// stands on a floor or hangs on a wall. A decoration that stands on the floor
// blocks movement (see propBlocks, and playSolids in sim/map.ts); one on a wall
// does not, since the wall it hangs on is already solid. The renderer draws them
// (render/props.ts).

export type PropKind =
  | 'painting' | 'torch' | 'lantern' | 'vase' | 'plant' | 'banner' | 'rug' | 'flag' | 'clock'
  | 'statue' | 'column' | 'fountain' | 'tapestry' | 'brazier' | 'bench' | 'palm'
  | 'obelisk' | 'arch' | 'mural' | 'totem' | 'oak'
  // Egypt
  | 'scarab' | 'ankh' | 'eyeOfHorus' | 'stele' | 'canopicJars' | 'papyrusReeds' | 'lotusBowl' | 'ushabti' | 'offeringTable'
  | 'pharaoh' | 'anubis' | 'papyrusColumn' | 'lotusColumn' | 'chariot' | 'sarcophagus'
  | 'sphinx' | 'pylon' | 'stepPyramid' | 'solarBarque' | 'colossus';

export type PropSize = 'small' | 'medium' | 'large';

export interface PropDef {
  name: string;
  size: PropSize;
  /** 'floor': stands on the top of a block. 'wall': hangs on the side of one. */
  mount: 'floor' | 'wall';
  /** Half its width (m), for the outline shown while placing and for picking it out. */
  half: number;
  /** Its height (m) above where it stands (or, on a wall, its height round where it hangs). */
  height: number;
}

export const PROPS: Record<PropKind, PropDef> = {
  painting: { name: 'PAINTING', size: 'small', mount: 'wall', half: 0.85, height: 1.3 },
  torch: { name: 'WALL TORCH', size: 'small', mount: 'wall', half: 0.2, height: 0.6 },
  lantern: { name: 'LANTERN', size: 'small', mount: 'floor', half: 0.2, height: 1.5 },
  vase: { name: 'VASE', size: 'small', mount: 'floor', half: 0.3, height: 1.0 },
  plant: { name: 'POTTED BUSH', size: 'small', mount: 'floor', half: 0.45, height: 1.6 },
  banner: { name: 'BANNER', size: 'small', mount: 'wall', half: 0.6, height: 2.2 },
  rug: { name: 'RUG', size: 'small', mount: 'floor', half: 1.2, height: 0.05 },
  flag: { name: 'FLAG', size: 'small', mount: 'floor', half: 0.5, height: 2.9 },
  clock: { name: 'CLOCK', size: 'small', mount: 'wall', half: 0.6, height: 1.2 },
  statue: { name: 'STATUE', size: 'medium', mount: 'floor', half: 0.6, height: 2.6 },
  column: { name: 'FLUTED COLUMN', size: 'medium', mount: 'floor', half: 0.55, height: 4.4 },
  fountain: { name: 'FOUNTAIN', size: 'medium', mount: 'floor', half: 1.9, height: 2.2 },
  tapestry: { name: 'TAPESTRY', size: 'medium', mount: 'wall', half: 1.3, height: 3.2 },
  brazier: { name: 'BRAZIER', size: 'medium', mount: 'floor', half: 0.7, height: 2.7 },
  bench: { name: 'BENCH', size: 'medium', mount: 'floor', half: 1.2, height: 1.0 },
  palm: { name: 'PALM TREE', size: 'medium', mount: 'floor', half: 1.2, height: 4.6 },
  obelisk: { name: 'OBELISK', size: 'large', mount: 'floor', half: 1.1, height: 9.4 },
  arch: { name: 'ARCH', size: 'large', mount: 'floor', half: 2.5, height: 5.8 },
  mural: { name: 'MURAL', size: 'large', mount: 'wall', half: 3.0, height: 4.0 },
  totem: { name: 'TOTEM', size: 'large', mount: 'floor', half: 0.8, height: 7.2 },
  oak: { name: 'OAK', size: 'large', mount: 'floor', half: 2.4, height: 8.2 },
  // Egypt: small
  scarab: { name: 'SCARAB', size: 'small', mount: 'wall', half: 0.75, height: 1.1 },
  ankh: { name: 'ANKH', size: 'small', mount: 'wall', half: 0.5, height: 1.5 },
  eyeOfHorus: { name: 'EYE OF HORUS', size: 'small', mount: 'wall', half: 0.6, height: 0.9 },
  stele: { name: 'STELE', size: 'small', mount: 'floor', half: 0.5, height: 2.0 },
  canopicJars: { name: 'CANOPIC JARS', size: 'small', mount: 'floor', half: 0.5, height: 1.0 },
  papyrusReeds: { name: 'PAPYRUS REEDS', size: 'small', mount: 'floor', half: 0.6, height: 2.7 },
  lotusBowl: { name: 'LOTUS BOWL', size: 'small', mount: 'floor', half: 0.5, height: 0.8 },
  ushabti: { name: 'USHABTI', size: 'small', mount: 'floor', half: 0.3, height: 0.95 },
  offeringTable: { name: 'OFFERING TABLE', size: 'small', mount: 'floor', half: 0.7, height: 0.9 },
  // Egypt: medium
  pharaoh: { name: 'PHARAOH', size: 'medium', mount: 'floor', half: 0.6, height: 2.5 },
  anubis: { name: 'ANUBIS', size: 'medium', mount: 'floor', half: 0.6, height: 2.2 },
  papyrusColumn: { name: 'PAPYRUS COLUMN', size: 'medium', mount: 'floor', half: 0.6, height: 4.4 },
  lotusColumn: { name: 'LOTUS COLUMN', size: 'medium', mount: 'floor', half: 0.6, height: 4.5 },
  chariot: { name: 'CHARIOT', size: 'medium', mount: 'floor', half: 1.2, height: 1.8 },
  sarcophagus: { name: 'SARCOPHAGUS', size: 'medium', mount: 'floor', half: 0.5, height: 2.2 },
  // Egypt: large
  sphinx: { name: 'SPHINX', size: 'large', mount: 'floor', half: 2.3, height: 3.2 },
  pylon: { name: 'PYLON', size: 'large', mount: 'floor', half: 2.6, height: 7.2 },
  stepPyramid: { name: 'STEP PYRAMID', size: 'large', mount: 'floor', half: 2.8, height: 6.0 },
  solarBarque: { name: 'SOLAR BARQUE', size: 'large', mount: 'floor', half: 2.0, height: 4.4 },
  colossus: { name: 'COLOSSUS', size: 'large', mount: 'floor', half: 1.4, height: 5.4 },
};

export const PROP_KINDS = Object.keys(PROPS) as PropKind[];

/**
 * Whether a decoration is solid. Floor pieces are, except ones flat enough to walk
 * over (the rug, 5 cm high): those would only block a player who could step on them anyway.
 * Wall pieces never are: the wall they hang on already is.
 */
export const propBlocks = (k: PropKind): boolean => PROPS[k].mount === 'floor' && PROPS[k].height > 0.1;
export const PROP_SIZES: PropSize[] = ['small', 'medium', 'large'];

export const propName = (k?: PropKind): string => (k && PROPS[k] ? PROPS[k].name : 'DECORATION');

/**
 * Which of a few pictures a decoration shows (paintings, murals, banners): worked
 * out from where it is put, so the same spot always gives the same one, and a
 * room of paintings is not all one picture. Stored in the map, so it never changes.
 */
export function variantFor(x: number, y: number, z: number): number {
  const h = Math.sin(x * 12.9898 + y * 37.719 + z * 78.233) * 43758.5453;
  return Math.floor((h - Math.floor(h)) * 4);
}
