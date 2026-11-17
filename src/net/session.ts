import { DT, PLAYER_COLORS, RULES_PRACTICE } from '../config/game';
import { generateMap } from '../maps/generator';
import { buildTestMap } from '../maps/testMap';
import { GameSim } from '../sim/game';
import type { MapDef } from '../sim/map';
import type { MatchState, RosterPlayer } from '../sim/match';
import type { InputCmd, Pickup, Player, Projectile, SimEvent, Zone } from '../sim/types';

/** What the renderer and HUD need to draw a frame. GameSim satisfies it; so does the client's interpolated world. */
export interface SimView {
  players: Player[];
  pickups: Pickup[];
  projectiles: Projectile[];
  zone: Zone | null;
  /** tick the moving brushes are at */
  worldTick: number;
  getPlayer(id: number): Player | undefined;
}

export interface InputSource {
  sample(): InputCmd;
}

/**
 * A running game from the app's point of view. Three kinds:
 *   offline - practice range, local GameSim
 *   host    - runs the authoritative GameSim and serves the other peers
 *   client  - predicts its own movement, interpolates everything else
 * The app, renderer, audio and HUD only ever see this interface.
 */
export interface Session {
  readonly kind: 'offline' | 'host' | 'client';
  readonly view: SimView;
  readonly map: MapDef;
  readonly localId: number;
  /** Simulation events since the last drain; the app empties this array. */
  readonly events: SimEvent[];
  /** null offline. */
  readonly match: MatchState | null;
  readonly roster: RosterPlayer[];
  readonly code: string;
  readonly maxPlayers: number;
  readonly ping: number; // ms, clients only
  /** Bumped when `map` is replaced / when a round (re)starts, so the app can rebuild visuals. */
  readonly mapVersion: number;
  readonly roundVersion: number;
  /** Set when the session is over (e.g. "The host left the match"). */
  readonly ended: string | null;
  /** Text for the top-left corner of the HUD (offline sessions). */
  readonly label?: string;
  /** Advance by dt seconds of real time. Returns the render interpolation alpha (0..1). */
  update(dt: number, input: InputSource, active: boolean): number;
  dispose(): void;
}

export class OfflineSession implements Session {
  readonly kind = 'offline' as const;
  readonly localId = 1;
  readonly match = null;
  readonly roster: RosterPlayer[] = [];
  readonly code = '';
  readonly maxPlayers = 1;
  readonly ping = 0;
  readonly mapVersion = 1;
  readonly roundVersion = 1;
  readonly ended = null;
  readonly map = buildTestMap();
  private sim: GameSim;
  private acc = 0;

  constructor(name: string, color: number, look: number[] = [0, 0, 0]) {
    this.sim = new GameSim(this.map, this.map.seed, RULES_PRACTICE);
    this.sim.addPlayer(this.localId, name, color).look = look;
  }

  get view(): SimView { return this.sim; }
  get events(): SimEvent[] { return this.sim.events; }

  /** Offline the game pauses while the menu is open (active = false). */
  update(dt: number, input: InputSource, active: boolean): number {
    if (!active) return 1;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.sim.setInput(this.localId, input.sample());
      this.sim.step();
    }
    return this.acc / DT;
  }

  dispose(): void {}
}

/**
 * Map lab: type a seed, look at what the generator made. Starts in free-fly
 * (no collision); switch to walking to try the map with real physics.
 * Spawn points are marked, weapons respawn, nothing can end the session.
 */
export class LabSession implements Session {
  readonly kind = 'offline' as const;
  readonly localId = 1;
  readonly match = null;
  readonly roster: RosterPlayer[] = [];
  readonly code = '';
  readonly maxPlayers = 1;
  readonly ping = 0;
  readonly roundVersion = 1;
  readonly ended = null;
  mapVersion = 0;
  seed = 0;
  flying = true;
  map!: MapDef;
  private sim!: GameSim;
  private acc = 0;

  constructor(seed: number) {
    this.setSeed(seed);
  }

  setSeed(seed: number): void {
    const old = this.sim?.getPlayer(this.localId);
    this.seed = seed >>> 0;
    this.map = generateMap(this.seed);
    this.sim = new GameSim(this.map, this.seed, RULES_PRACTICE);
    const p = this.sim.addPlayer(this.localId, 'LAB', PLAYER_COLORS[0]);
    this.sim.events.length = 0;
    p.noclip = this.flying;
    // Keep the camera where it was when flipping through seeds; first time, hover above the map.
    if (old && this.flying) p.pos = { ...old.pos };
    else if (this.flying) p.pos = { x: 0, y: 30, z: 36 };
    this.mapVersion++;
  }

  toggleFly(): void {
    this.flying = !this.flying;
    const p = this.sim.getPlayer(this.localId);
    if (p) { p.noclip = this.flying; p.vel = { x: 0, y: 0, z: 0 }; }
  }

  get view(): SimView { return this.sim; }
  get events(): SimEvent[] { return this.sim.events; }
  get label(): string {
    const m = this.map;
    const count = (t: string) => m.triggers.filter((x) => x.type === t).length;
    return `SEED ${this.seed} · ${m.info?.archetype ?? '?'} · try ${(m.info?.attempt ?? 0) + 1} · ${m.solids.length} brushes · `
      + `${m.pickups.length} guns · ${count('jumppad')} pads · ${count('teleporter') / 2} portals · ${m.solids.filter((x) => x.mover).length} movers`
      + ` · ${m.info?.structures.join(', ').toLowerCase() || 'no landmarks'} — ${this.flying ? 'FLYING' : 'WALKING'}`;
  }

  update(dt: number, input: InputSource, active: boolean): number {
    if (!active) return 1;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= DT) {
      this.acc -= DT;
      const p = this.sim.getPlayer(this.localId);
      if (p) p.noclip = this.flying && p.alive; // survives respawns
      this.sim.setInput(this.localId, input.sample());
      this.sim.step();
    }
    return this.acc / DT;
  }

  dispose(): void {}
}
