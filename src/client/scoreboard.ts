import type { MatchState, RosterPlayer } from '../sim/match';
import type { Player, SimEvent } from '../sim/types';

// The data behind the hold-Tab scoreboard: one row per player, with their
// match totals plus whatever has happened in the round being played.
// No DOM here, so the tests can drive it.

export interface ScoreRow {
  id: number;
  name: string;
  color: number;
  look: number[];
  host: boolean;
  me: boolean;
  away: boolean; // dropped out, seat held for them to reconnect
  alive: boolean; // in the round being played (true between rounds)
  maps: number; // maps taken
  mapRounds: number; // rounds won on the current map
  rounds: number; // rounds won in the whole match
  kills: number;
  deaths: number;
  /** TEAM matches: their side (0 RED, 1 BLUE). */
  team?: number;
}

/**
 * Kills and deaths in the round being played. The host only adds a round to
 * the match totals when it ends, so without this the numbers would sit still
 * for a whole round. Fed every simulation event; counts only while a round is
 * being played, and is cleared whenever one is not (by then the host has
 * folded it into the totals).
 */
export class RoundTally {
  private k = new Map<number, number>();
  private d = new Map<number, number>();

  add(e: SimEvent, phase: MatchState['phase'] | undefined): void {
    if (e.t !== 'kill' || phase !== 'playing') return;
    // Same rule as the simulation: falling, the zone, leaving... count as a death, not as anyone's kill.
    if (e.killer >= 0 && e.killer !== e.victim) this.k.set(e.killer, (this.k.get(e.killer) ?? 0) + 1);
    this.d.set(e.victim, (this.d.get(e.victim) ?? 0) + 1);
  }

  /** Call every frame with the match phase; empties itself outside a round. */
  sync(phase: MatchState['phase'] | undefined): void {
    if (phase !== 'playing' && (this.k.size || this.d.size)) { this.k.clear(); this.d.clear(); }
  }

  kills(id: number): number { return this.k.get(id) ?? 0; }
  deaths(id: number): number { return this.d.get(id) ?? 0; }
}

/** The host is always player 1 (see HostSession). */
const HOST_ID = 1;

/**
 * Rows for a match, best first: maps taken, then rounds on this map, then
 * rounds in the match, then kills, then fewest deaths. TEAM matches: RED then
 * BLUE, each side by kills. There the host keeps the totals up to date as they
 * happen, so the round tally is not added, and nobody is ever "out" (they respawn).
 */
export function matchRows(
  m: MatchState, roster: RosterPlayer[], localId: number, alive: (id: number) => boolean | undefined, tally: RoundTally,
): ScoreRow[] {
  const inRound = m.phase === 'playing' || m.phase === 'countdown';
  const team = m.mode === 'team';
  const rows = roster.map((p): ScoreRow => {
    const st = m.stats[p.id] ?? { kills: 0, deaths: 0, rounds: 0 };
    return {
      id: p.id, name: p.name, color: p.color, look: p.look, host: p.id === HOST_ID, me: p.id === localId, away: !!p.away,
      alive: inRound && !team ? alive(p.id) ?? false : true,
      maps: m.mapWins[p.id] ?? 0, mapRounds: m.roundWins[p.id] ?? 0, rounds: st.rounds,
      kills: st.kills + (team ? 0 : tally.kills(p.id)), deaths: st.deaths + (team ? 0 : tally.deaths(p.id)),
      ...(team ? { team: p.team ?? 0 } : {}),
    };
  });
  if (team) return rows.sort((a, b) => (a.team ?? 0) - (b.team ?? 0) || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
  return rows.sort((a, b) => b.maps - a.maps || b.mapRounds - a.mapRounds || b.rounds - a.rounds
    || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
}

/** Rows for the practice range: just you and the dummies, kills and deaths. */
export function practiceRows(players: Player[], localId: number): ScoreRow[] {
  return players.map((p): ScoreRow => ({
    id: p.id, name: p.name, color: p.color, look: p.look, host: false, me: p.id === localId, away: false, alive: p.alive,
    maps: 0, mapRounds: 0, rounds: 0, kills: p.kills, deaths: p.deaths,
  })).sort((a, b) => Number(b.me) - Number(a.me) || b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
}
