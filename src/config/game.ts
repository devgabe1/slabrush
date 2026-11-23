// Global game constants. Units: meters, seconds.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER = {
  radius: 0.35, // collision hull half-width (AABB)
  height: 1.8,
  crouchHeight: 1.1,
  eyeHeight: 1.62,
  crouchEyeHeight: 0.95,
  maxHealth: 150,
  /** Standing still this long (seconds) starts health regenerating... */
  regenDelay: 3,
  /** ...at this many HP a second, up to maxHealth. Moving or getting hurt stops it (and restarts the wait). */
  regenRate: 5,
  // hit boxes (slightly more generous than the collision hull)
  hitRadius: 0.38,
  headRadius: 0.25,
  headSize: 0.45, // top part of the hull that counts as head
  maxWeapons: 2,
};

/**
 * SKYSWEEPER, the flying broom: a rare map pickup (not a weapon; your hands
 * stay free to shoot). Press use beside it to mount; you fly where you look.
 */
export const BROOM = {
  chance: 0.3, // share of generated maps with one broom
  charge: 25, // seconds of flight in a fresh broom (it drains only while ridden)
  speed: 14, // m/s, flying flat out
  accel: 5, // how quickly you reach the speed you want (per second); the rest is drift
  ceiling: 20, // m above the map's origin: no higher
  knockoff: 35, // one hit this big knocks you off (the broom falls, still charged)
  glide: 2.5, // seconds of slow fall after the charge runs out, you get off or are knocked off
  glideFall: 3, // m/s: the fastest you fall while gliding
  minDrop: 2, // a broom with less than this many seconds left vanishes instead of dropping
};

/**
 * SLABRIDER, the sport bike: a rare map pickup like the broom (not a weapon; your
 * hands stay free to shoot). Press use beside it to climb on; W rides where you look.
 * Hold jump for a WHEELIE: everything you deal does double damage, and everything
 * you take does too.
 */
export const BIKE = {
  chance: 0.3, // share of generated maps with one bike
  fuel: 30, // seconds of riding in a fresh bike (it burns only while ridden)
  speed: 16, // m/s flat out (twice a run)
  wheelieSpeed: 1.2, // faster on the back wheel
  reverse: 4, // m/s backing up with S
  accel: 10, // m/s per second, opening the throttle
  brake: 24, // m/s per second, braking against the way you are rolling
  coast: 3, // m/s per second, rolling with nothing held
  strafe: 3, // m/s sideways with A/D (a lean, not a sidestep)
  turn: 5, // rad/s: how quickly the way you are rolling swings round to where you look (speed carried through)
  grip: 10, // how quickly the tyres kill sideways slide (per second): it goes where it points
  dealt: 2, // WHEELIE: damage you deal is multiplied by this...
  taken: 2, // ...and damage you take by this
  knockoff: 40, // one hit this big knocks you off (the bike falls, still fuelled)
  ramMin: 5, // m/s: riding into someone at least this fast runs them over...
  ramPerMps: 3.5, // ...for this much damage per m/s (flat out: 56; on a wheelie, double)
  ramReach: 1.1, // m between centres that counts as hitting them
  ramPush: 0.7, // they are thrown along at this share of your speed (and up)
  tumble: 1.6, // s: hit at all on a wheelie and you are thrown off, tumbling head over heels, no control
  tumbleThrow: 5, // m/s: thrown away from the hit (on top of the way you were going)...
  tumbleUp: 6.5, // ...and up
  crashMin: 6, // m/s: speed lost against a wall in one tick that counts as a crash...
  crashPerMps: 2.5, // ...for this much damage to you per m/s lost (head-on flat out: 40, enough to throw you off)
  minDrop: 2, // a bike with less than this many seconds of fuel left is wrecked instead of dropping
};

export const PICKUP = {
  radius: 1.1, // horizontal reach
  height: 1.7, // vertical reach
  despawn: 25, // dropped weapons vanish after this many seconds on the ground
  emptyDespawn: 10,
};

export interface ZoneRules {
  start: number; // seconds into the round before the zone appears
  shrinkTime: number;
  startRadius: number;
  minRadius: number;
  damage: number; // per half second outside the zone (ramps up over time)
}

export interface Rules {
  respawnPlayers: boolean;
  respawnDelay: number;
  botRespawnDelay: number;
  respawnPickups: boolean;
  pickupRespawn: number;
  lagCompensation: boolean;
  zone: ZoneRules | null;
}

/** Offline practice range rules. */
export const RULES_PRACTICE: Rules = {
  respawnPlayers: true,
  respawnDelay: 2.5,
  botRespawnDelay: 3,
  respawnPickups: true,
  pickupRespawn: 6,
  lagCompensation: false,
  zone: null,
};

/** Round rules: one life, no respawning weapons, and a shrinking zone that forces an ending. */
export const RULES_MATCH: Rules = {
  respawnPlayers: false,
  respawnDelay: 0,
  botRespawnDelay: 0,
  respawnPickups: false,
  pickupRespawn: 0,
  lagCompensation: true,
  zone: { start: 50, shrinkTime: 35, startRadius: 34, minRadius: 4, damage: 6 },
};

/** PARKOUR races: no weapons, no zone; you come back on your last checkpoint (set by the host) soon after any death. */
export const RULES_PARKOUR: Rules = {
  respawnPlayers: true,
  respawnDelay: 1.5,
  botRespawnDelay: 0,
  respawnPickups: false,
  pickupRespawn: 0,
  lagCompensation: true,
  zone: null,
};

/** Match structure and pacing. */
/**
 * Aiming (hold the second fire button with one weapon in your hands, one- or
 * two-handed; while dual wielding that button fires the right-hand gun instead).
 */
export const AIM = {
  spread: 0.35, // spread multiplier while aiming (decided by the host, so it is fair)
  fov: 0.78, // field of view multiplier while aiming down the sights
  blend: 12, // how fast the view and gun move into / out of aim (per second)
};

export const MATCH = {
  maxPlayers: 6, // default room size (2-6, the host can change it in the lobby)
  roundsPerMap: 2, // round wins needed to take a map
  mapsToWin: 6, // maps needed to win the match
  countdown: 3, // seconds frozen before each round
  roundEndDelay: 3,
  mapEndDelay: 4.5,
  matchEndDelay: 10,
  /** Seconds a dropped player's seat (name, colour, score) is held for them to reconnect mid-match. */
  rejoinGrace: 60,
};

/** Networking. */
export const NET = {
  snapshotEvery: 2, // host sends a snapshot every N ticks (60 / 2 = 30 Hz)
  interpDelayTicks: 6, // clients render other players this far in the past (100 ms)
  maxRewindTicks: 20, // lag compensation limit (~330 ms)
  inputRedundancy: 3, // each input packet repeats the last N commands
  timeoutMs: 8000,
};

export const PLAYER_COLORS = [0xe8503a, 0x3aa6e8, 0x6fd44a, 0xe8c63a, 0xb45ae8, 0x3ae8c0, 0xe87fb4, 0xf08a2c];
