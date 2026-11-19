// Match structure shared by host and clients. The host owns and mutates it;
// clients receive a copy whenever the phase changes.
//
//   lobby -> [ countdown -> playing -> roundEnd ]* -> mapEnd -> ... -> matchEnd -> lobby
//
// A map is played until someone wins MATCH.roundsPerMap rounds on it ("takes
// the map"); the first player to take MATCH.mapsToWin maps wins the match.
export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'roundEnd' | 'mapEnd' | 'matchEnd';

export interface MatchState {
  phase: MatchPhase;
  timer: number; // seconds left in the current timed phase
  mapNumber: number; // 1-based
  round: number; // 1-based, within the current map
  mapSeed: number;
  mapSize: number; // cells per side of the current map (see MAP_SIZES): chosen by the host from the player count
  roundWins: Record<number, number>; // on the current map
  mapWins: Record<number, number>;
  winner: number; // player id that won the last round / map / match, -1 = nobody (draw)
  /** Running totals for the end-of-match scoreboard. */
  stats: Record<number, PlayerStats>;
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
}

export const newMatchState = (): MatchState => ({
  phase: 'lobby', timer: 0, mapNumber: 0, round: 0, mapSeed: 0, mapSize: 16, roundWins: {}, mapWins: {}, winner: -1, stats: {},
});
