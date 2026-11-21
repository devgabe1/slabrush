// ALL weapon balance lives here. To add a weapon: add an id and an entry
// below, a model in render/models.ts and a sound in audio/sfx.ts (TypeScript
// will complain until both exist).
//
// `npm run test:weapons` prints a balance table (DPS, time to kill, damage
// per pickup) computed from these numbers.
export type WeaponId =
  | 'fists'
  // pistols
  | 'rivet' | 'pepper' | 'magnate' | 'gambler'
  // automatics
  | 'chatter' | 'hornet' | 'ledger' | 'kingpin'
  // shotguns
  | 'slab' | 'twins'
  // precision
  | 'needle' | 'bouncer' | 'verdict' | 'stapler'
  // explosives
  | 'postman' | 'lobber' | 'pineapple' | 'clinger' | 'bigone' | 'pinata' | 'potato'
  // melee
  | 'shiv' | 'slugger' | 'banhammer' | 'fish'
  // weird
  | 'zapper' | 'gust' | 'swapper' | 'toaster' | 'icebox' | 'reeler'
  // traps
  | 'snapper' | 'popper' | 'sentry' | 'stinker'
  // legendary
  | 'monologue' | 'tirade' | 'heckler' | 'jethammer' | 'afterburn' | 'rearview' | 'kiblast';

/** Melee right-click specials (see WeaponDef.special). */
export type MeleeSpecial =
  /** Hold: hits from the front do `block` less (0.75 = 75% less) and barely push you; you move at `slow` of your speed and cannot attack. */
  | { kind: 'guard'; name: string; block: number; slow: number }
  /** A dash along your aim at `speed` for `time` s; the first player in the way takes `damage` (backstab rules apply). Uses one use. */
  | { kind: 'lunge'; name: string; speed: number; time: number; damage: number; cooldown: number }
  /** Hold to wind up (up to `time` s), let go to swing: damage, shove and lift grow with the wind-up. Uses one use. */
  | { kind: 'charge'; name: string; time: number; damage: [number, number]; knockback: [number, number]; launch: [number, number]; cooldown: number }
  /** Leap (`leap` up, `forward` along your aim) and crash down: a shockwave of `damage` (half at the edge) and a throw within `radius`. Uses no use. */
  | { kind: 'slam'; name: string; leap: number; forward: number; radius: number; damage: number; launch: number; push: number; cooldown: number }
  /** A wave in front (`range` m, `cone` degrees): everyone in it is soaked for `soak` s, shoved and dazed. No damage. Uses one use. */
  | { kind: 'splash'; name: string; range: number; cone: number; push: number; soak: number; stun: number; cooldown: number };

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** 0 = basic (placed near spawns), 1 = standard, 2 = power (placed in contested spots). */
  tier: 0 | 1 | 2;
  kind: 'hitscan' | 'projectile' | 'melee';
  /**
   * 1 = one-handed. Carry two one-handed weapons and you hold both at once:
   * the first fire button uses the left one, the second the right one.
   * 2 = two-handed (the default): one in your hands, the other on your back.
   */
  hands?: 1 | 2;
  /**
   * 'trap' = a one-handed item you toss a short way; it sticks where it
   * lands, arms itself, and waits for someone to come by. What it does then
   * is described by `projectile.trap`.
   * 'legendary' = rare: most maps have none, and never more than one (see
   * LEGENDARY_CHANCE). Not part of the tiers.
   */
  category?: 'trap' | 'legendary';
  damage: number; // per pellet / per hit (projectiles: direct-hit bonus on top of splash)
  headMult: number;
  fireInterval: number; // seconds between trigger pulls
  auto: boolean; // hold to fire
  ammo: number; // total uses; there is no reserve. Melee weapons wear out too.
  pellets: number;
  spread: number; // cone half-angle in degrees
  range: number;
  /** damage falloff: full damage until [0], scales down to [2] at [1] meters */
  falloff?: [start: number, end: number, minScale: number];
  knockback: number; // m/s pushed along the shot direction (once per victim)
  knockUp?: number; // extra upward m/s on the victim
  selfKnockback?: number; // m/s pushing the SHOOTER backwards: recoil as a movement tool
  recoil: { pitch: number; yaw: number; kick: number }; // degrees up, degrees random sideways, viewmodel kick

  burst?: { count: number; interval: number }; // one trigger pull fires `count` shots
  bounces?: number; // hitscan ricochets off walls this many times
  bounceBonus?: number; // damage multiplier gained per ricochet (0.35 = +35%)
  swap?: boolean; // a hit swaps places with the victim
  backstab?: number; // melee damage multiplier when hitting from behind
  meleePad?: number; // how forgiving the melee swing is (meters added around hit boxes)
  spinUp?: number; // seconds the trigger must be held before the first shot (minigun)
  pierce?: boolean; // the shot passes through every player in its path
  stun?: number; // seconds of slow applied to whoever is hit
  gamble?: [min: number, max: number]; // damage is rolled per shot instead of using `damage`
  consumed?: boolean; // the weapon leaves your hand when its last use is spent (grenades)
  /** Has a scope: aiming looks through it at this field of view (degrees) instead of the iron sights. */
  scope?: number;

  // --- melee powers (one each) ---
  /** Cuts bleed: `dps` per stack for `seconds` after the last cut, up to `maxStacks` stacks. */
  bleed?: { dps: number; seconds: number; maxStacks: number };
  /** Drenches the victim for this many seconds: slippery footing (like ice), and the ZAPPER hurts double. */
  soak?: number;
  /** For `window` s after a hit, slamming into a wall at more than `minSpeed` m/s costs `perMps` per m/s of impact. */
  wallSplat?: { window: number; minSpeed: number; perMps: number };
  /** Every `hits`-th hit in a row on the same target (each within `window` s) is an uppercut. */
  combo?: { hits: number; window: number; mult: number; launch: number; stun: number };
  /**
   * The right-click special of a melee weapon (when it is the one weapon in
   * your hands; dual wielding, right-click fires the right hand as usual).
   * The moving parts (dash, leap, guarding slowly) live in pmove, so they are
   * predicted like running; what they do to others is the simulation's.
   */
  special?: MeleeSpecial;
  /**
   * A harpoon line (REELER): whoever is hit is reeled in, thrown on an arc
   * that lands them `stop` m in front of you, from any distance: `lift` m/s up
   * when close, and from far away a higher arc rather than more than `max`
   * m/s along the ground. They cannot steer out of it.
   */
  reel?: { stop: number; lift: number; max: number };
  /** Damage multiplier against a soaked target (electricity and water). */
  vsSoaked?: number;
  /**
   * A grabbing beam (MONOLOGUE). Hold the trigger: the beam locks onto the
   * first player it touches, freezes them in mid-air at its end, and they go
   * wherever you point. On its own it does no harm; hold the second fire
   * button as well to burn whoever is held, at twice the drain. Swing them
   * and let go to throw them; the wheel pushes them away or pulls them in.
   * `ammo` is its charge, in percent.
   */
  beam?: {
    drain: number; // charge (percent) spent per second while the beam is on (twice that while burning)
    dps: number; // damage per second to whoever is held, only while both fire buttons are down
    minDist: number; // how close the held player is kept (metres from your eyes)
    maxDist: number; // and how far
    wheelStep: number; // metres each notch of the wheel pushes them away / pulls them in
    carry: number; // the fastest (m/s) a held player can be swung around
    release: number; // let go of the trigger: they keep the swing, up to this speed (m/s): that is the throw
    throwLift: number; // and a little upward help (m/s) when they are thrown hard, so a throw carries
    credit: number; // seconds after being let go during which a fatal fall still counts as your kill
  };
  /**
   * A megaphone (HECKLER). While the trigger is held it pulses a cone of sound
   * `pulse` times a second, as strong as the holder is LOUD: their microphone
   * level, measured on their own machine and sent with their input. Shouting
   * shoves, hurts and throws off aim; a whisper (below `whisper`) does
   * nothing; no microphone at all gives a weak fixed pulse (`noMic`).
   * While it is on, the holder's voice reaches everyone on the map, through a
   * megaphone. `ammo` is its charge, in percent.
   */
  shout?: {
    drain: number; // charge (percent) per second while held
    range: number; // metres the cone reaches
    cone: number; // half-angle of the cone, degrees
    push: number; // shove per pulse at full loudness, point blank (m/s)
    lift: number; // and up (m/s), so people leave the ground
    dps: number; // damage per second at full loudness, point blank
    aimKick: number; // degrees a full-loudness pulse throws a victim's aim around
    whisper: number; // loudness below this does nothing
    noMic: number; // loudness used for players with no microphone (or voice off)
    credit: number; // seconds after a blast during which a fatal fall is the heckler's kill
  };
  /**
   * Runaway trigger (TIRADE): one pull and it fires until it is empty,
   * whatever you do with the trigger. It may fire several rounds in one tick
   * (its fireInterval can be shorter than a tick). While it runs you cannot
   * switch weapons, throw it or swap it at a pickup.
   */
  runaway?: boolean;
  /**
   * A rocket on a hammer (JETHAMMER). It never swings: hold the trigger and
   * the rocket drives you in a straight line along your aim (nearly level),
   * faster and faster. Anyone you run into dies; a wall hurts you and leaves
   * you stunned. Let go and you keep your speed. `ammo` is its fuel, percent.
   * The movement itself lives in pmove, so it is predicted like running is.
   */
  jet?: {
    open: number; // seconds from the press to lift-off: the compartment opens and the thruster comes out
    start: number; // m/s at ignition (or your speed along the line, if more)
    accel: number; // m/s per second while it burns
    speed: number; // top speed (m/s)
    maxPitch: number; // radians: the line is never steeper than this, up or down
    drain: number; // fuel (percent) per second
    killSpeed: number; // m/s above which running into someone kills them
    boom: number; // m/s at which the sound barrier goes (a sonic boom)
    splatSpeed: number; // m/s above which a wall hurts (slower, you just stop)
    splatDamage: number;
    stun: number; // seconds stunned after a wall
  };
  /**
   * A flamethrower with its fuel tank on your back (AFTERBURN). The flame is
   * its ordinary hitscan cone. Point it down while in the air and it is a
   * rocket: thrust against your aim, plus a wobble you do not control
   * (pmove, so it is predicted), dropping burning patches (its `projectile`)
   * as you go. A shot in the back of whoever holds it hits the tank: they go up.
   */
  /**
   * A charged energy wave (KI BLAST). Hold the trigger to gather it (up to
   * `charge` s; you walk at `slow` of your speed meanwhile), let go to release
   * a beam for `time` s. The longer the charge, the wider (`radius`) and
   * deadlier (`dps`) it is; under `minCharge` it fizzles and costs nothing.
   * Everyone in the beam is burned and shoved along it; walls stop it; the
   * shooter can sweep it, at most `turn` radians a second. One use per blast.
   */
  ki?: {
    charge: number;
    minCharge: number;
    slow: number;
    time: number;
    range: number;
    radius: [number, number]; // at the least and the fullest charge (m)
    dps: [number, number];
    push: number; // m/s along the beam, per second inside it
    turn: number;
    recoil: number; // m/s pushing the shooter back, per second of beam
  };
  /**
   * A refraction field (REARVIEW). While the trigger is held, an oval field
   * hangs in front of you: other players' bullets, lasers and projectiles
   * that reach it hit the glass and stick there for `linger` seconds,
   * shivering (projectiles' fuses pause), then bounce back, yours now:
   * guided, slow enough to watch, back at whoever fired them. They follow
   * their shooter, steer round walls rather than through them, and give up
   * after `homeLife` seconds. Bullets come back as slugs
   * (its own `projectile`, at twice that speed) carrying the damage they would
   * have done. It never hurts anyone by itself. `ammo` is its charge, percent.
   */
  mirror?: {
    linger: number; // seconds a shot sticks to the glass before it bounces back
    homeSpeed: number; // m/s it flies back at (everything, bullets and rockets alike)
    homeTurn: number; // radians per second it can turn while chasing
    homeLife: number; // seconds it keeps chasing before it is spent
    distance: number; // metres in front of your eyes
    radius: number; // of the field
    drain: number; // charge (percent) per second while it is up
    max: number; // the most it can hold at once; more is simply absorbed
  };
  torch?: {
    maxLift: number; // metres above the ground beneath: higher than this it only holds you, it will not climb
    downPitch: number; // radians below the horizon that count as pointing down
    thrust: number; // m/s per second, against the aim, while flying on it
    wobble: number; // m/s per second of sideways shove that wanders
    trailEvery: number; // seconds between burning patches dropped while flying
    tankDamage: number; // the tank going up: splash damage...
    tankRadius: number; // ...radius...
    tankPush: number; // ...and shove
  };
  /** tracer look; null = no tracer. Omitted = default yellow. */
  tracer?: { color: number; width: number; life: number } | null;

  projectile?: {
    speed: number;
    gravity: number;
    inherit?: number; // fraction of the thrower's velocity added
    splashDamage: number;
    splashRadius: number;
    splashKnockback: number;
    selfDamageScale: number;
    contact: boolean; // explodes on touching a player
    fuse?: number; // seconds until it explodes by itself (default 6)
    bounce?: number; // restitution; omitted = explodes on walls (unless sticky)
    sticky?: boolean; // glues itself to the first surface
    proximity?: number; // once armed, explodes when a player comes this close
    cluster?: number; // splits into this many bomblets when it goes off
    stickPlayers?: boolean; // latches onto the player it hits, and jumps to anyone they touch
    /** What an armed trap does (mines use `proximity` + splash instead). */
    trap?: {
      type: 'snap' | 'spring' | 'sentry' | 'gas' | 'fire'; // fire: a burning patch, armed at once, burns all but its owner
      radius: number; // how close someone must come to set it off (sentry: its firing range)
      damage: number; // on trigger / per sentry shot / per half second in the gas
      root?: number; // snap: seconds the victim cannot move
      launch?: number; // spring: upward speed given to the victim
      interval?: number; // sentry: seconds between shots; fire: between burns
      duration?: number; // gas: how long the cloud lasts
      area?: number; // gas: radius of the cloud
    };
    armTime?: number;
  };
  throwDamage: number; // damage when the weapon itself is thrown at someone
  throwStun: number; // seconds of slow
}

const NO_RECOIL = { pitch: 0, yaw: 0, kick: 0.6 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // What you have when unarmed. Weak, but it pushes people around.
  fists: {
    id: 'fists', name: 'FISTS', tier: 0, kind: 'melee',
    damage: 24, headMult: 1, fireInterval: 0.38, auto: true, ammo: Infinity,
    pellets: 1, spread: 0, range: 2.1, knockback: 3.5,
    combo: { hits: 3, window: 0.9, mult: 2.2, launch: 8.5, stun: 0.6 }, // one-two-UPPERCUT
    special: { kind: 'guard', name: 'GUARD', block: 0.75, slow: 0.55 }, // fists up
    recoil: { pitch: 0, yaw: 0, kick: 0.5 }, throwDamage: 0, throwStun: 0,
  },

  // ------------------------------------------------------------- pistols
  // The honest sidearm: precise, rewards headshots.
  rivet: {
    id: 'rivet', name: 'RIVET', tier: 0, kind: 'hitscan', hands: 1,
    damage: 24, headMult: 2, fireInterval: 0.16, auto: false, ammo: 12,
    pellets: 1, spread: 0.5, range: 150, knockback: 0.6,
    recoil: { pitch: 1.3, yaw: 0.5, kick: 1 }, throwDamage: 22, throwStun: 0.6,
  },
  // Burst pistol: three rounds per pull. Forgiving up close, wasteful at range.
  pepper: {
    id: 'pepper', name: 'PEPPER', tier: 0, kind: 'hitscan', hands: 1,
    damage: 14, headMult: 1.6, fireInterval: 0.42, auto: false, ammo: 21,
    pellets: 1, spread: 1.5, range: 120, falloff: [20, 50, 0.6], knockback: 0.3,
    burst: { count: 3, interval: 0.055 },
    recoil: { pitch: 0.8, yaw: 0.6, kick: 0.7 }, throwDamage: 22, throwStun: 0.6,
  },
  // Revolver: six heavy rounds. A headshot kills outright.
  magnate: {
    id: 'magnate', name: 'MAGNATE', tier: 1, kind: 'hitscan', hands: 1,
    damage: 46, headMult: 2.2, fireInterval: 0.52, auto: false, ammo: 6,
    pellets: 1, spread: 0.25, range: 200, knockback: 2.5,
    recoil: { pitch: 5.5, yaw: 1.2, kick: 2.2 },
    tracer: { color: 0xffe0a0, width: 0.035, life: 0.14 }, throwDamage: 30, throwStun: 0.7,
  },

  // ---------------------------------------------------------- automatics
  // SMG: sprays a lot, runs dry fast.
  chatter: {
    id: 'chatter', name: 'CHATTER', tier: 0, kind: 'hitscan', hands: 1,
    damage: 11, headMult: 1.5, fireInterval: 0.065, auto: true, ammo: 36,
    pellets: 1, spread: 2.1, range: 120, falloff: [18, 45, 0.5], knockback: 0.3,
    recoil: { pitch: 0.55, yaw: 0.7, kick: 0.6 }, throwDamage: 26, throwStun: 0.6,
  },
  // Tiny, furious, inaccurate. Deadly within arm's reach and nowhere else.
  hornet: {
    id: 'hornet', name: 'HORNET', tier: 0, kind: 'hitscan', hands: 1,
    damage: 7, headMult: 1.3, fireInterval: 0.04, auto: true, ammo: 60,
    pellets: 1, spread: 3.4, range: 80, falloff: [9, 28, 0.35], knockback: 0.15,
    recoil: { pitch: 0.3, yaw: 0.9, kick: 0.4 },
    tracer: { color: 0xffd23a, width: 0.018, life: 0.06 }, throwDamage: 20, throwStun: 0.5,
  },
  // Rifle: accurate at any distance, steady rate of fire.
  ledger: {
    id: 'ledger', name: 'LEDGER', tier: 1, kind: 'hitscan',
    damage: 18, headMult: 1.8, fireInterval: 0.115, auto: true, ammo: 24,
    pellets: 1, spread: 0.7, range: 200, knockback: 0.5,
    recoil: { pitch: 0.95, yaw: 0.45, kick: 0.9 }, throwDamage: 32, throwStun: 0.7,
  },

  // ------------------------------------------------------------ shotguns
  // Pump shotgun: deletes people up close.
  slab: {
    id: 'slab', name: 'SLAB', tier: 1, kind: 'hitscan',
    damage: 11, headMult: 1.25, fireInterval: 0.85, auto: false, ammo: 6,
    pellets: 9, spread: 5.5, range: 60, falloff: [7, 22, 0.25], knockback: 2,
    recoil: { pitch: 4.5, yaw: 1.2, kick: 2.2 }, throwDamage: 34, throwStun: 0.8,
  },
  // Double barrel: two enormous shots in quick succession. Kicks so hard it
  // throws YOU backwards — aim at the floor to jump with it.
  twins: {
    id: 'twins', name: 'TWINS', tier: 1, kind: 'hitscan',
    damage: 10, headMult: 1.2, fireInterval: 0.24, auto: false, ammo: 2,
    pellets: 13, spread: 8.5, range: 40, falloff: [5, 15, 0.2], knockback: 5, selfKnockback: 7,
    recoil: { pitch: 7, yaw: 2, kick: 3 }, throwDamage: 36, throwStun: 0.8,
  },

  // ----------------------------------------------------------- precision
  // Sniper rifle: four rounds, perfectly accurate even from the hip. Any hit kills (150, a full life).
  needle: {
    id: 'needle', name: 'NEEDLE', tier: 2, kind: 'hitscan',
    damage: 150, headMult: 2.2, fireInterval: 1.3, auto: false, ammo: 4,
    pellets: 1, spread: 0, range: 400, knockback: 4, scope: 20,
    recoil: { pitch: 8, yaw: 1, kick: 3.2 },
    tracer: { color: 0xffffff, width: 0.06, life: 0.45 }, throwDamage: 40, throwStun: 0.9,
  },
  // Ricochet rifle: the shot bounces off walls three times and hits harder
  // after every bounce. Shoot around corners.
  bouncer: {
    id: 'bouncer', name: 'BOUNCER', tier: 1, kind: 'hitscan',
    damage: 28, headMult: 1.5, fireInterval: 0.32, auto: false, ammo: 10,
    pellets: 1, spread: 0.2, range: 90, knockback: 1, bounces: 3, bounceBonus: 0.35,
    recoil: { pitch: 2.2, yaw: 0.6, kick: 1.4 },
    tracer: { color: 0xff5ae8, width: 0.04, life: 0.3 }, throwDamage: 30, throwStun: 0.7,
  },

  // ---------------------------------------------------------- explosives
  // Rocket launcher: splash, knockback, rocket jumps.
  postman: {
    id: 'postman', name: 'POSTMAN', tier: 2, kind: 'projectile',
    damage: 30, headMult: 1, fireInterval: 1.0, auto: false, ammo: 3,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 3, yaw: 0.6, kick: 2.6 },
    projectile: {
      speed: 34, gravity: 0, splashDamage: 90, splashRadius: 4.5,
      splashKnockback: 14, selfDamageScale: 0.45, contact: true,
    },
    throwDamage: 40, throwStun: 0.9,
  },
  // Grenade launcher: lobs bouncing grenades that go off on a short fuse, or at once on a direct hit.
  lobber: {
    id: 'lobber', name: 'LOBBER', tier: 2, kind: 'projectile',
    damage: 25, headMult: 1, fireInterval: 0.75, auto: false, ammo: 4,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 2.5, yaw: 0.6, kick: 2 },
    projectile: {
      speed: 24, gravity: 17, splashDamage: 82, splashRadius: 4,
      splashKnockback: 11, selfDamageScale: 0.5, contact: true, fuse: 1.5, bounce: 0.45,
    },
    throwDamage: 36, throwStun: 0.8,
  },
  // Hand grenades: two of them. Bounce them round a corner; they do not care who is standing there.
  pineapple: {
    id: 'pineapple', name: 'PINEAPPLE', tier: 1, kind: 'projectile', hands: 1,
    damage: 0, headMult: 1, fireInterval: 0.7, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 19, gravity: 18, inherit: 0.6, splashDamage: 115, splashRadius: 5.5,
      splashKnockback: 13, selfDamageScale: 1, contact: false, fuse: 2.1, bounce: 0.4,
    },
    throwDamage: 20, throwStun: 0.5,
  },
  // (CLINGER is the first of the traps; the rest of that family is at the end of this file.)
  // Proximity mines: stick to anything (floors, walls, ceilings, moving
  // platforms), arm after a second, and wait. They do not recognise their owner.
  clinger: {
    id: 'clinger', name: 'CLINGER', tier: 1, kind: 'projectile', hands: 1, category: 'trap',
    damage: 0, headMult: 1, fireInterval: 0.6, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 16, gravity: 14, inherit: 0.5, splashDamage: 95, splashRadius: 4.2,
      splashKnockback: 12, selfDamageScale: 1, contact: false, fuse: 45, sticky: true, proximity: 2.7, armTime: 1,
    },
    throwDamage: 20, throwStun: 0.5,
  },

  // --------------------------------------------------------------- melee
  // Knife: fast, a kill from behind (4.5x: 180, more than a life), and lethal when thrown.
  shiv: {
    id: 'shiv', name: 'SHIV', tier: 0, kind: 'melee', hands: 1,
    damage: 40, headMult: 1, fireInterval: 0.27, auto: true, ammo: 20,
    pellets: 1, spread: 0, range: 2.0, knockback: 1, backstab: 4.5, meleePad: 0.2,
    bleed: { dps: 6, seconds: 4, maxStacks: 3 }, // every cut keeps hurting: up to 18 per second
    special: { kind: 'lunge', name: 'LUNGE', speed: 38, time: 0.21, damage: 60, cooldown: 2.5 }, // 8 m in a blink
    recoil: { pitch: 0, yaw: 0, kick: 0.5 }, throwDamage: 80, throwStun: 0.4,
  },
  // Bat: slow, long reach, sends people flying. Splendid next to a void.
  slugger: {
    id: 'slugger', name: 'SLUGGER', tier: 0, kind: 'melee',
    damage: 55, headMult: 1.3, fireInterval: 0.6, auto: true, ammo: 12,
    pellets: 1, spread: 0, range: 2.6, knockback: 11, knockUp: 6, meleePad: 0.4,
    wallSplat: { window: 1.4, minSpeed: 5, perMps: 5 }, // bat them into a wall: a 12 m/s splat is another 60
    special: { kind: 'charge', name: 'HOME RUN', time: 1, damage: [55, 110], knockback: [11, 30], launch: [6, 12], cooldown: 1.5 },
    recoil: { pitch: 0, yaw: 0, kick: 0.8 }, throwDamage: 45, throwStun: 1,
  },

  // --------------------------------------------------------------- weird
  // Arc beam: no spread, no falloff, no aim punch — just hold it on them. Short range.
  zapper: {
    id: 'zapper', name: 'ZAPPER', tier: 1, kind: 'hitscan', hands: 1,
    damage: 6, headMult: 1, fireInterval: 0.05, auto: true, ammo: 70,
    pellets: 1, vsSoaked: 2, spread: 0, range: 13, knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.25 },
    tracer: { color: 0x6ae8ff, width: 0.05, life: 0.07 }, throwDamage: 28, throwStun: 1.2,
  },
  // Air cannon: almost no damage, enormous shove. Blow people off ledges, or
  // point it at the ground and ride it.
  gust: {
    id: 'gust', name: 'GUST', tier: 1, kind: 'hitscan',
    damage: 2, headMult: 1, fireInterval: 0.9, auto: false, ammo: 5,
    pellets: 8, spread: 11, range: 11, knockback: 17, knockUp: 4, selfKnockback: 8.5,
    recoil: { pitch: 2, yaw: 0.5, kick: 2.4 },
    tracer: null, throwDamage: 30, throwStun: 0.8,
  },
  // Swap gun: hit someone and you trade places. Jump off a ledge first.
  swapper: {
    id: 'swapper', name: 'SWAPPER', tier: 1, kind: 'hitscan', hands: 1,
    damage: 12, headMult: 1, fireInterval: 0.8, auto: false, ammo: 3,
    pellets: 1, spread: 0.1, range: 120, knockback: 0, swap: true,
    recoil: { pitch: 1.5, yaw: 0.4, kick: 1.2 },
    tracer: { color: 0x7dff5a, width: 0.05, life: 0.35 }, throwDamage: 28, throwStun: 0.7,
  },

  // ------------------------------------------------------- heavy hitters
  // Minigun: takes most of a second to spin up, then nothing survives in front of it.
  kingpin: {
    id: 'kingpin', name: 'KINGPIN', tier: 2, kind: 'hitscan',
    damage: 8, headMult: 1.3, fireInterval: 0.035, auto: true, ammo: 150,
    pellets: 1, spread: 2.6, range: 120, falloff: [20, 50, 0.5], knockback: 0.2, spinUp: 0.7,
    recoil: { pitch: 0.22, yaw: 0.6, kick: 0.45 },
    tracer: { color: 0xffc04a, width: 0.022, life: 0.06 }, throwDamage: 45, throwStun: 1,
  },
  // Railgun: one beam, straight through everybody standing in line, killing each. Three shots.
  verdict: {
    id: 'verdict', name: 'VERDICT', tier: 2, kind: 'hitscan',
    damage: 150, headMult: 1.5, fireInterval: 1.6, auto: false, ammo: 3,
    pellets: 1, spread: 0, range: 300, knockback: 7, pierce: true,
    recoil: { pitch: 9, yaw: 1, kick: 3.4 },
    tracer: { color: 0x4ad8ff, width: 0.09, life: 0.7 }, throwDamage: 40, throwStun: 0.9,
  },
  // One enormous, slow rocket. The blast is eleven metres wide and does not care that you fired it.
  bigone: {
    id: 'bigone', name: 'BIG ONE', tier: 2, kind: 'projectile',
    damage: 0, headMult: 1, fireInterval: 2, auto: false, ammo: 1,
    pellets: 1, spread: 0, range: 0, knockback: 0, selfKnockback: 5,
    recoil: { pitch: 6, yaw: 1, kick: 3.6 },
    projectile: {
      speed: 13, gravity: 0, splashDamage: 260, splashRadius: 11,
      splashKnockback: 24, selfDamageScale: 1, contact: true, fuse: 12,
    },
    throwDamage: 50, throwStun: 1.2,
  },
  // Cluster launcher: the grenade bursts into six bomblets that bounce off in all directions.
  pinata: {
    id: 'pinata', name: 'PINATA', tier: 2, kind: 'projectile',
    damage: 15, headMult: 1, fireInterval: 0.95, auto: false, ammo: 3,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 2.5, yaw: 0.6, kick: 2 },
    projectile: {
      speed: 22, gravity: 17, splashDamage: 55, splashRadius: 3.6,
      splashKnockback: 9, selfDamageScale: 0.5, contact: true, fuse: 1.4, bounce: 0.4, cluster: 6,
    },
    throwDamage: 36, throwStun: 0.8,
  },
  // A hammer the size of a door. Three swings, each one final. Slow enough to see coming.
  banhammer: {
    id: 'banhammer', name: 'BANHAMMER', tier: 2, kind: 'melee',
    damage: 200, headMult: 1, fireInterval: 1.3, auto: false, ammo: 3,
    pellets: 1, spread: 0, range: 2.9, knockback: 16, knockUp: 7, meleePad: 0.45,
    special: { kind: 'slam', name: 'SLAM', leap: 8, forward: 5, radius: 5, damage: 70, launch: 9, push: 9, cooldown: 5 },
    recoil: { pitch: 0, yaw: 0, kick: 1.4 }, throwDamage: 90, throwStun: 1.5,
  },

  // ---------------------------------------------------------- new tricks
  // Flamethrower: a short cone of fire. No aim needed, no range to speak of.
  toaster: {
    id: 'toaster', name: 'TOASTER', tier: 1, kind: 'hitscan', hands: 1,
    damage: 3.4, headMult: 1, fireInterval: 0.05, auto: true, ammo: 90,
    pellets: 3, spread: 8, range: 8.5, falloff: [4, 8.5, 0.4], knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.2 },
    tracer: null, throwDamage: 30, throwStun: 0.8,
  },
  // Freeze ray: light damage, but everyone it touches moves at half speed.
  icebox: {
    id: 'icebox', name: 'ICEBOX', tier: 1, kind: 'hitscan', hands: 1,
    damage: 9, headMult: 1.2, fireInterval: 0.12, auto: true, ammo: 30,
    pellets: 1, spread: 0.8, range: 35, knockback: 0, stun: 1.6,
    recoil: { pitch: 0.3, yaw: 0.3, kick: 0.4 },
    tracer: { color: 0xbfeaff, width: 0.04, life: 0.12 }, throwDamage: 28, throwStun: 1.5,
  },
  // Harpoon: reels whoever it hits all the way in, to land at your feet. Bring a shotgun, or stand behind a ledge.
  reeler: {
    id: 'reeler', name: 'REELER', tier: 1, kind: 'hitscan', hands: 1,
    damage: 15, headMult: 1, fireInterval: 1.0, auto: false, ammo: 5,
    pellets: 1, spread: 0.2, range: 35, knockback: 0,
    reel: { stop: 2.5, lift: 6, max: 45 },
    recoil: { pitch: 1.5, yaw: 0.4, kick: 1.3 },
    tracer: { color: 0xc8a070, width: 0.035, life: 0.4 }, throwDamage: 30, throwStun: 0.7,
  },
  // Crossbow-ish: heavy bolts that fly in an arc. No splash, no sound worth mentioning.
  stapler: {
    id: 'stapler', name: 'STAPLER', tier: 1, kind: 'projectile', hands: 1,
    damage: 65, headMult: 1, fireInterval: 0.7, auto: false, ammo: 6,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 1.2, yaw: 0.3, kick: 1.2 },
    projectile: {
      speed: 55, gravity: 9, splashDamage: 0, splashRadius: 0,
      splashKnockback: 0, selfDamageScale: 0, contact: true, fuse: 5,
    },
    throwDamage: 30, throwStun: 0.7,
  },

  // --------------------------------------------------------------- memes
  // Every shot rolls its damage: anywhere from 1 to 140. Feeling lucky?
  gambler: {
    id: 'gambler', name: 'GAMBLER', tier: 1, kind: 'hitscan', hands: 1,
    damage: 70, headMult: 1, fireInterval: 0.45, auto: false, ammo: 7,
    pellets: 1, spread: 0.6, range: 150, knockback: 1, gamble: [1, 140],
    recoil: { pitch: 3, yaw: 0.8, kick: 1.6 },
    tracer: { color: 0xffe14a, width: 0.03, life: 0.15 }, throwDamage: 26, throwStun: 0.6,
  },
  // A fish. Does three damage. Slaps people across the room and leaves them dazed.
  fish: {
    id: 'fish', name: 'FISH', tier: 0, kind: 'melee', hands: 1,
    damage: 8, headMult: 1, fireInterval: 0.3, auto: true, ammo: 30,
    pellets: 1, spread: 0, range: 2.3, knockback: 9, knockUp: 3.5, stun: 0.7, meleePad: 0.35,
    soak: 4, // drenched: they skid around like on ice, and electricity loves them
    special: { kind: 'splash', name: 'SPLASH', range: 7, cone: 40, push: 12, soak: 5, stun: 0.8, cooldown: 3 },
    recoil: { pitch: 0, yaw: 0, kick: 0.6 }, throwDamage: 5, throwStun: 2.5,
  },
  // Hot potato: sticks to whoever it hits and goes off three seconds later —
  // unless they manage to bump into someone else first, in which case it is theirs now.
  potato: {
    id: 'potato', name: 'POTATO', tier: 1, kind: 'projectile', hands: 1,
    damage: 0, headMult: 1, fireInterval: 0.7, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 21, gravity: 15, inherit: 0.5, splashDamage: 105, splashRadius: 4.5,
      splashKnockback: 12, selfDamageScale: 1, contact: false, fuse: 3.2, bounce: 0.35, stickPlayers: true,
    },
    throwDamage: 15, throwStun: 0.5,
  },

  // --------------------------------------------------------------- traps
  // One-handed, tossed a couple of metres, stuck where they land. All of them
  // arm after about a second and none of them recognise their owner (except the sentry).

  // Bear trap: 30 damage and you are going nowhere for two and a half seconds.
  snapper: {
    id: 'snapper', name: 'SNAPPER', tier: 1, kind: 'projectile', hands: 1, category: 'trap',
    damage: 0, headMult: 1, fireInterval: 0.6, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 7, gravity: 16, inherit: 0.6, splashDamage: 0, splashRadius: 0, splashKnockback: 0,
      selfDamageScale: 1, contact: false, fuse: 90, sticky: true, armTime: 1,
      trap: { type: 'snap', radius: 1.0, damage: 30, root: 2.5 },
    },
    throwDamage: 20, throwStun: 0.5,
  },
  // Spring plate: flings whoever steps on it high into the air. Harmless on
  // solid ground; next to a void it is a death sentence.
  popper: {
    id: 'popper', name: 'POPPER', tier: 1, kind: 'projectile', hands: 1, category: 'trap',
    damage: 0, headMult: 1, fireInterval: 0.6, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 7, gravity: 16, inherit: 0.6, splashDamage: 0, splashRadius: 0, splashKnockback: 0,
      selfDamageScale: 1, contact: false, fuse: 90, sticky: true, armTime: 1,
      trap: { type: 'spring', radius: 1.0, damage: 0, launch: 19 },
    },
    throwDamage: 20, throwStun: 0.5,
  },
  // Sentry gun: sits where you put it and shoots anyone but you who comes into view, for half a minute.
  sentry: {
    id: 'sentry', name: 'SENTRY', tier: 1, kind: 'projectile', hands: 1, category: 'trap',
    damage: 0, headMult: 1, fireInterval: 0.8, auto: false, ammo: 1,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 6, gravity: 16, inherit: 0.4, splashDamage: 0, splashRadius: 0, splashKnockback: 0,
      selfDamageScale: 1, contact: false, fuse: 30, sticky: true, armTime: 1.2,
      trap: { type: 'sentry', radius: 17, damage: 6, interval: 0.22 },
    },
    throwDamage: 30, throwStun: 0.7,
  },
  // Gas canister: goes off when someone walks past and fills the area with a choking cloud for seven seconds.
  stinker: {
    id: 'stinker', name: 'STINKER', tier: 1, kind: 'projectile', hands: 1, category: 'trap',
    damage: 0, headMult: 1, fireInterval: 0.6, auto: false, ammo: 2,
    pellets: 1, spread: 0, range: 0, knockback: 0, consumed: true,
    recoil: NO_RECOIL,
    projectile: {
      speed: 8, gravity: 16, inherit: 0.6, splashDamage: 0, splashRadius: 0, splashKnockback: 0,
      selfDamageScale: 1, contact: false, fuse: 90, sticky: true, armTime: 1,
      trap: { type: 'gas', radius: 2.4, damage: 11, duration: 7, area: 4.2 },
    },
    throwDamage: 20, throwStun: 0.5,
  },

  // ------------------------------------------------------------- legendary
  // A gauntlet that throws a humming beam. Whoever it touches is frozen in
  // mid-air and carried wherever you point: walk them off a ledge, dangle them
  // over the lava, or hurl them with the second fire button. Starts at 100%
  // charge, drains while the beam is on, and never refills.
  monologue: {
    id: 'monologue', name: 'MONOLOGUE', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 0, headMult: 1, fireInterval: 0.25, auto: true, ammo: 100,
    pellets: 1, spread: 0, range: 34, knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.15 },
    beam: { drain: 20, dps: 5, minDist: 3, maxDist: 12, wheelStep: 1, carry: 26, release: 26, throwLift: 3, credit: 3 },
    tracer: null, throwDamage: 40, throwStun: 1.2,
  },
  // A rotary cannon with no off switch. Pull the trigger once and it talks
  // until it has nothing left to say: about 55 rounds a second, 200 of them,
  // nearly four seconds you cannot stop, steer as you might. It shoves you
  // back a little with every round. Then, like any empty gun, it is a brick.
  tirade: {
    id: 'tirade', name: 'TIRADE', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 7, headMult: 1.4, fireInterval: 0.018, auto: true, ammo: 100, runaway: true,
    pellets: 1, spread: 3.4, range: 120, falloff: [16, 45, 0.45], knockback: 0.25, selfKnockback: 0.09,
    recoil: { pitch: 0.16, yaw: 0.55, kick: 0.5 },
    tracer: { color: 0xff9a3a, width: 0.02, life: 0.05 }, throwDamage: 50, throwStun: 1.2,
  },
  // A megaphone whose blast is your own voice. Hold the trigger and shout:
  // everyone on the map hears you, and anyone in front of you is blown back,
  // hurt and rattled in proportion to how LOUD you are. A whisper does
  // nothing. No microphone? It still gives a weak pulse.
  heckler: {
    id: 'heckler', name: 'HECKLER', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 0, headMult: 1, fireInterval: 0.1, auto: true, ammo: 100,
    pellets: 1, spread: 0, range: 16, knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.25 },
    shout: { drain: 12, range: 16, cone: 35, push: 9, lift: 2.5, dps: 30, aimKick: 9, whisper: 0.15, noMic: 0.3, credit: 3 },
    tracer: null, throwDamage: 40, throwStun: 1,
  },
  // A sledgehammer the size of a fridge. It looks like any other hammer, and
  // it does not swing. Hold the trigger: a button in the handle pops open a
  // compartment in the back of the head, the thruster slides out, and it
  // throws you along your aim, dead straight, faster and faster until the air
  // itself cracks. Two seconds of fuel.
  // Whoever you hit dies. Whatever wall you hit, you feel it, and see stars.
  jethammer: {
    id: 'jethammer', name: 'JETHAMMER', tier: 2, kind: 'melee', category: 'legendary',
    damage: 0, headMult: 1, fireInterval: 0.1, auto: true, ammo: 100,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: NO_RECOIL,
    jet: { open: 0.15, start: 14, accel: 70, speed: 58, maxPitch: 0.35, drain: 50, killSpeed: 16, boom: 45, splatSpeed: 12, splatDamage: 35, stun: 1 },
    throwDamage: 60, throwStun: 1.5,
  },
  // A fuel tank on your back and a torch in your hands. Forwards, it fills a
  // corridor with fire, through everyone in it. Point it at your feet and it
  // lifts you off: a rocket you can barely steer, up to about five metres
  // above the ground, raining fire behind you.
  // The tank does not like bullets: one in the back and you are a fireball.
  // An energy wave gathered between cupped hands. Hold to charge (the orb grows,
  // the air hums, you can barely walk), let go to unleash a huge beam that
  // burns and shoves everyone in it, sweeping slowly with your aim. A full
  // charge kills anyone who stays in it. Three blasts.
  kiblast: {
    id: 'kiblast', name: 'KI BLAST', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 0, headMult: 1, fireInterval: 0.2, auto: true, ammo: 3,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.4 },
    ki: { charge: 2, minCharge: 0.4, slow: 0.4, time: 1.2, range: 60, radius: [0.5, 1.4], dps: [90, 220], push: 45, turn: 1.4, recoil: 4 },
    tracer: null, throwDamage: 40, throwStun: 1,
  },
  // A makeup compact, open in the palm: a round mirror in the lid, powder and a puff in the base.
  // Hold the trigger and a shimmering field opens in front of you: whatever
  // is fired at you (bullets, beams, rockets, grenades) hits it, sticks for
  // half a second, and bounces back after whoever fired it, steering round
  // walls to follow them.
  // Harmless otherwise.
  rearview: {
    id: 'rearview', name: 'REARVIEW', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 0, headMult: 1, fireInterval: 0.3, auto: true, ammo: 100,
    pellets: 1, spread: 0, range: 0, knockback: 0,
    recoil: { pitch: 0, yaw: 0, kick: 0.1 },
    mirror: { linger: 0.5, homeSpeed: 18, homeTurn: 4, homeLife: 6, distance: 1.4, radius: 1.25, drain: 22, max: 60 },
    projectile: { // what a caught bullet becomes when it is sent back
      speed: 90, gravity: 0, splashDamage: 0, splashRadius: 0, splashKnockback: 0, selfDamageScale: 0, contact: true, fuse: 3,
    },
    tracer: null, throwDamage: 40, throwStun: 1,
  },
  afterburn: {
    id: 'afterburn', name: 'AFTERBURN', tier: 2, kind: 'hitscan', category: 'legendary',
    damage: 4, headMult: 1, fireInterval: 0.05, auto: true, ammo: 45, // three seconds of flame (it fires every fourth tick)
    pellets: 3, spread: 9, range: 12, falloff: [6, 12, 0.5], knockback: 0.4, pierce: true,
    recoil: { pitch: 0, yaw: 0, kick: 0.25 },
    torch: { maxLift: 5, downPitch: 0.7, thrust: 34, wobble: 10, trailEvery: 0.12, tankDamage: 110, tankRadius: 5.5, tankPush: 16 },
    projectile: { // the burning patches it leaves behind
      speed: 0, gravity: 18, splashDamage: 0, splashRadius: 0, splashKnockback: 0, selfDamageScale: 0,
      contact: false, fuse: 2.5, sticky: true, trap: { type: 'fire', radius: 1.3, damage: 7, interval: 0.25 },
    },
    tracer: null, throwDamage: 40, throwStun: 1,
  },
};

/** One-handed weapons can be dual wielded. */
export const isOneHanded = (id: WeaponId): boolean => WEAPONS[id].hands === 1;

/** The trap class. */
export const TRAPS = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].category === 'trap');

/** Weapons whose ammo is a charge or fuel gauge, shown in percent. */
export const inPercent = (def: WeaponDef): boolean => !!(def.beam || def.shout || def.jet || def.torch || def.mirror);
/** What the HUD shows for a weapon's ammo: a count, or for gauges, the percentage left of a full one. */
export const ammoLabel = (def: WeaponDef, ammo: number): string =>
  inPercent(def) ? `${Math.ceil((ammo / def.ammo) * 100 - 1e-9)}%` : String(ammo);

/** The legendary class: rare weapons outside the tiers. */
export const LEGENDARIES = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => WEAPONS[id].category === 'legendary');

/** Chance that a generated map has a legendary weapon (in place of one of its power weapons). */
export const LEGENDARY_CHANCE = 0.5;

/**
 * How likely each weapon is to be the one rolled for a weapon spot on a map, by
 * its tier: a tier-0 weapon is 3 times as likely as a tier-2 one. Nothing is
 * guaranteed; every spot rolls on its own. (Legendaries: LEGENDARY_CHANCE.)
 */
export const TIER_WEIGHT = [3, 2, 1] as const;

/** Every weapon that can lie on a map, grouped by tier (used for map weapon placement). Legendaries are placed separately. */
export const WEAPON_TIERS: WeaponId[][] = [0, 1, 2].map((t) =>
  (Object.keys(WEAPONS) as WeaponId[]).filter((id) => id !== 'fists' && WEAPONS[id].category !== 'legendary' && WEAPONS[id].tier === t));

/** Thrown weapon physics. */
export const THROW = {
  speed: 21,
  inheritVelocity: 0.5, // fraction of the thrower's velocity added
  gravity: 18,
  bounce: 0.35,
  knockback: 4,
};
