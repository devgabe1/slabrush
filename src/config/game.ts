// Global game constants. Units: meters, seconds.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PLAYER = {
  radius: 0.35, // collision hull half-width (AABB)
  height: 1.8,
  crouchHeight: 1.1,
  eyeHeight: 1.62,
  crouchEyeHeight: 0.95,
  maxHealth: 100,
  // hit boxes (slightly more generous than the collision hull)
  hitRadius: 0.38,
  headRadius: 0.25,
  headSize: 0.45, // top part of the hull that counts as head
  maxWeapons: 2,
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

/** Match structure and pacing. */
export const MATCH = {
  maxPlayers: 6, // default room size (2-6, the host can change it in the lobby)
  roundsPerMap: 2, // round wins needed to take a map
  mapsToWin: 6, // maps needed to win the match
  countdown: 3, // seconds frozen before each round
  roundEndDelay: 3,
  mapEndDelay: 4.5,
  matchEndDelay: 10,
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
