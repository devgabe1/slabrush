// Battle bots: how well each difficulty plays. Units: seconds, metres, radians.
//
// A bot plays through the same InputCmds a person sends (see sim/bot.ts), so
// everything here is about how good its hands and eyes are: how soon it
// reacts, how steady its aim is, how quickly it can turn. Only EXTERMINATION
// also bends the rules, with `dealt` and `taken`.

export type BotLevel = 'easy' | 'medium' | 'hard' | 'extermination';

export const BOT_LEVELS: readonly BotLevel[] = ['easy', 'medium', 'hard', 'extermination'];

/** What the lobby and the roster call each level. */
export const BOT_LEVEL_NAMES: Record<BotLevel, string> = {
  easy: 'EASY', medium: 'MEDIUM', hard: 'HARD', extermination: 'EXTERMINATION',
};

export interface BotSkill {
  reaction: number; // s an enemy must be in sight before the first shot
  aimError: number; // radians the aim is off when it first locks onto someone...
  aimSettle: number; // ...shrinking by this share per second while it keeps tracking them...
  aimFloor: number; // ...onto a wobble of up to this many radians that keeps wandering and never goes away
  track: number; // how quickly (per second) its aim catches up with where the target is: low = trails behind anyone moving
  burst: [fire: number, rest: number]; // s it keeps shooting, then s it pauses to re-aim
  tap: number; // s between pulls of a semi-automatic's trigger, at the quickest
  flinch: number; // radians its aim is thrown off by each hit it takes
  turnRate: number; // radians per second the view can swing round
  fov: number; // half-angle (radians) of what it notices on its own; outside it, only what shoots it
  sight: number; // m: enemies further away than this go unnoticed
  memory: number; // s it keeps chasing an enemy after losing sight of them
  lead: number; // 0..1: how much of a moving target's travel it aims ahead for
  headshots: number; // 0..1: share of the time it aims at the head instead of the chest
  strafe: [min: number, max: number]; // s between changes of direction while fighting
  hops: number; // 0..1: chance per second of a jump while fighting (and of hopping along when travelling)
  slides: number; // 0..1: chance per second of a slide while fighting fast
  aims: boolean; // holds the aim button at long range (tighter spread)
  dealt: number; // damage it deals is multiplied by this
  taken: number; // damage it takes is multiplied by this (0.8 = 1.25x the health)
}

// Balanced against a person on a flat floor (scripts/bottest.ts): seconds to kill
// someone with a pistol at 12 m, standing still / strafing, roughly
// EASY 13 / 15, MEDIUM 4.6 / 10, HARD 4.3 / 8, EXTERMINATION 1.6 / 3 (a perfect shot: 1.1).
// Weaker levels react slower, trail behind moving targets (track), shake more
// (aimFloor) and pause longer between bursts.
export const BOT_SKILL: Record<BotLevel, BotSkill> = {
  easy: {
    reaction: 1.1, aimError: 0.35, aimSettle: 1, aimFloor: 0.08, track: 1.5, burst: [0.6, 0.9], tap: 0.5, flinch: 0.2,
    turnRate: 2.2, fov: 0.9, sight: 25, memory: 1.5,
    lead: 0, headshots: 0, strafe: [1.4, 2.8], hops: 0, slides: 0, aims: false, dealt: 0.7, taken: 1.1,
  },
  medium: {
    reaction: 0.7, aimError: 0.25, aimSettle: 1.6, aimFloor: 0.06, track: 2, burst: [0.8, 0.8], tap: 0.35, flinch: 0.14,
    turnRate: 3.5, fov: 1.1, sight: 35, memory: 2.5,
    lead: 0.2, headshots: 0.05, strafe: [0.9, 1.8], hops: 0.1, slides: 0, aims: false, dealt: 0.8, taken: 1,
  },
  hard: {
    reaction: 0.45, aimError: 0.18, aimSettle: 2.5, aimFloor: 0.05, track: 2.2, burst: [1, 0.6], tap: 0.25, flinch: 0.1,
    turnRate: 5.5, fov: 1.3, sight: 45, memory: 3.5,
    lead: 0.5, headshots: 0.15, strafe: [0.6, 1.3], hops: 0.3, slides: 0.2, aims: true, dealt: 1, taken: 1,
  },
  extermination: {
    reaction: 0.28, aimError: 0.12, aimSettle: 3.5, aimFloor: 0.03, track: 3.2, burst: [1.4, 0.4], tap: 0.2, flinch: 0.06,
    turnRate: 8, fov: 1.8, sight: 60, memory: 6,
    lead: 0.8, headshots: 0.3, strafe: [0.4, 1], hops: 0.7, slides: 0.5, aims: true, dealt: 1.15, taken: 0.8,
  },
};

/** Room limits and defaults for bots. */
export const BOTS = {
  defaultLevel: 'medium' as BotLevel,
  /** m: unarmed, a bot goes for weapons up to this far away (armed, only ones close by: `nearPickup`). */
  pickupRange: 40,
  nearPickup: 6,
  /** s a bot tries to reach one weapon before giving up on it for a while (`pickupGiveUp`). */
  pickupTimeout: 6,
  pickupGiveUp: 10,
  /** m inside the zone's edge that a bot keeps to. */
  zoneMargin: 3,
  /** m: the furthest drop a bot will walk off (there is no fall damage; this keeps it off long falls into nowhere). */
  maxDrop: 8,
  /** m: how close to lava or spikes a bot will step (touching them kills). */
  hazardMargin: 0.4,
  /** s a bot keeps going round something by one side before trying the other. */
  sideGiveUp: 5,
};

/** Bot names (original). Each bot is shown as "BOT <name>". */
export const BOT_NAMES = [
  'GRAVEL', 'GASKET', 'CINDER', 'BOLT', 'SLAG', 'FLINT', 'GRIT', 'CRANK', 'SPROCKET', 'BRICK', 'TORQUE', 'CLINKER',
];
