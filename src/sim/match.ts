import type { BotLevel } from '../config/bots';

// Match structure shared by host and clients. The host owns and mutates it;
// clients receive a copy whenever the phase changes.
//
//   lobby -> [ countdown -> playing -> roundEnd ]* -> mapEnd -> ... -> matchEnd -> lobby
//
// A map is played until someone wins MATCH.roundsPerMap rounds on it ("takes
// the map"); the first player to take MATCH.mapsToWin maps wins the match.
//
// PARKOUR rooms race instead: each course is a round (countdown -> playing ->
// roundEnd with the results), then the next course; after the last one,
// matchEnd, won on points.
export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'roundEnd' | 'mapEnd' | 'matchEnd';

export interface MatchState {
  phase: MatchPhase;
  timer: number; // seconds left in the current timed phase
  mapNumber: number; // 1-based
  round: number; // 1-based, within the current map
  mapSeed: number;
  /** A map made in the map lab and in the rotation (maps/custom): its id. Absent: the map is generated from mapSeed. */
  mapId?: string;
  /** The host has paused the match: nothing moves, no timer runs, until they resume it. */
  paused?: boolean;
  mapSize: number; // cells per side of the current map (see MAP_SIZES): chosen by the host from the player count
  roundWins: Record<number, number>; // on the current map
  mapWins: Record<number, number>;
  winner: number; // player id that won the last round / map / match, -1 = nobody (draw)
  /** Running totals for the end-of-match scoreboard. */
  stats: Record<number, PlayerStats>;
  /** 'battle' (absent): last one standing. 'parkour': a race over obstacle courses (see race.ts). */
  mode?: GameMode;
  /** PARKOUR: the race being run. Each course is one round. */
  race?: RaceState;
}

export type GameMode = 'battle' | 'parkour';

/** PARKOUR: one runner's progress on the course being raced. */
export interface RaceRunner {
  cp: number; // checkpoints reached
  finish: number | null; // ticks from the start to the finish, null = still running (or did not finish)
  splits: number[]; // ticks at each checkpoint
}

/** PARKOUR: a race over one or more courses, run one after the other. */
export interface RaceState {
  courses: string[]; // course ids, in the order they are raced
  index: number; // the one being raced
  startTick: number; // the sim tick the clock started at (end of the countdown)
  endTick: number; // the sim tick the course closes at: once someone finishes, the rest have a while longer
  runners: Record<number, RaceRunner>;
  points: Record<number, number>; // over the whole race
  /** Finish order on the course just raced (set when it closes): ids, finishers first. */
  order?: number[];
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  rounds: number; // rounds won across the whole match
}

export interface RosterPlayer {
  id: number;
  name: string;
  color: number;
  look: number[]; // [face, torso, legs]
  /** Dropped out of a match in progress: the seat is held for them for a while (MATCH.rejoinGrace). */
  away?: boolean;
  /** A battle bot the host added, and how well it plays (config/bots.ts). Absent = a person. */
  bot?: BotLevel;
}

export const newMatchState = (): MatchState => ({
  phase: 'lobby', timer: 0, mapNumber: 0, round: 0, mapSeed: 0, mapSize: 16, roundWins: {}, mapWins: {}, winner: -1, stats: {},
});
