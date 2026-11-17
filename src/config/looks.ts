// Character customization: what a player looks like. Purely cosmetic — hit
// boxes are the same for everyone. A look is three indices, one per list;
// the models themselves are built in render/models.ts (same order).
export const FACES = [
  'CYCLOPS', 'GOOGLY', 'VISOR', 'TV HEAD', 'PUMPKIN', 'SKULL',
  'TRAFFIC CONE', 'BUCKET', 'TOASTER', 'FROG', 'ALIEN', 'SMILEY',
  'BLOCKHEAD', 'SCRAPBOT', 'CAT HOOD', 'ASTRONAUT', 'DISCO BALL', 'MOAI',
] as const;

export const TORSOS = [
  'SLAB', 'BARREL', 'TUXEDO', 'HAZARD VEST', 'ARMOUR', 'CRATE',
  'BACKPACK', 'RIBCAGE', 'MUSCLE', 'TRASH CAN', 'JETPACK', 'CAPE',
  'HOODIE', 'SPACESUIT', 'SCRAP CHASSIS', 'PIXEL TEE',
] as const;

export const LEGS = [
  'STUBS', 'STILTS', 'BOOTS', 'SPRINGS', 'PEG LEG', 'ROBOT',
  'SHORTS', 'TREADS', 'CHICKEN', 'WHEELS', 'FLIPPERS', 'BELL BOTTOMS',
  'PIXEL PANTS', 'MOON BOOTS', 'ROLLER SKATES', 'HOVER',
] as const;

/** [face, torso, legs] */
export type Look = [number, number, number];

export const LOOK_PARTS = [FACES, TORSOS, LEGS] as const;
export const LOOK_LABELS = ['FACE', 'TORSO', 'LEGS'] as const;

export const randomLook = (): Look => [
  Math.floor(Math.random() * FACES.length), // cosmetic, so plain randomness is fine
  Math.floor(Math.random() * TORSOS.length),
  Math.floor(Math.random() * LEGS.length),
];

/** Make anything (saved settings, a network message) into a valid look. */
export function cleanLook(v: unknown): Look {
  const a = Array.isArray(v) ? v : [];
  const pick = (n: unknown, len: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) < len ? (n as number) : 0);
  return [pick(a[0], FACES.length), pick(a[1], TORSOS.length), pick(a[2], LEGS.length)];
}
