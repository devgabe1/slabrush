import { DT, PLAYER, PLAYER_COLORS, RULES_PRACTICE } from '../config/game';
import { MAP_SIZES, generateMap, pickMapSize } from '../maps/generator';
import { buildTestMap } from '../maps/testMap';
import { GameSim, aimDir } from '../sim/game';
import { MapEditor, REACH, SPOT_WEAPONS, TOOL_NAMES, type Aim, type Target } from '../maps/editor';
import type { MapFile } from '../maps/mapFile';
import { WEAPONS } from '../config/weapons';
import type { MapDef } from '../sim/map';
import type { MatchState, RosterPlayer } from '../sim/match';
import { BTN, type InputCmd, type Pickup, type Player, type Projectile, type SimEvent, type Zone } from '../sim/types';
import type { VoiceLink } from './protocol';

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
  /** Online sessions: the handshake channel for proximity voice. */
  readonly voice?: VoiceLink;
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
/** The map editor's bar at the bottom of the screen (see LabSession.buildBar). */
export interface BuildBar {
  tools: { name: string; on: boolean }[];
  item: string; detail: string; swatch: string | null; keys: string;
  place: string; remove: string | null; problem: string;
  placeBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  target: Target | null;
}

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
  /** How many players to pretend are in the room: the map size is picked as a real match would pick it. */
  players = 4;
  flying = true;
  map!: MapDef;
  private sim!: GameSim;
  private acc = 0;

  /** Building a map by hand (null: looking at generated maps by seed). */
  readonly editor: MapEditor | null = null;

  constructor(seed: number, players = 4, edit?: MapFile) {
    this.players = Math.max(2, Math.min(6, players));
    if (edit) {
      this.editor = new MapEditor(edit);
      this.rebuild();
    } else this.setSeed(seed);
  }

  /** Editing: the map has changed. A fresh simulation of it, the camera where it was. */
  rebuild(): void {
    const old = this.sim?.getPlayer(this.localId);
    this.map = this.editor!.map;
    this.sim = new GameSim(this.map, 1, RULES_PRACTICE);
    const p = this.sim.addPlayer(this.localId, 'LAB', PLAYER_COLORS[0], null, { pos: this.map.spawns[0]?.pos ?? { x: 0, y: 0.02, z: 0 }, yaw: this.map.spawns[0]?.yaw ?? 0 });
    this.sim.events.length = 0;
    p.noclip = this.flying;
    if (old) { p.pos = { ...old.pos }; p.yaw = old.yaw; p.pitch = old.pitch; }
    else if (this.flying) p.pos = { x: 0, y: 6, z: 14 };
    this.mapVersion++;
  }

  /** Editing: what the crosshair is on (or the point REACH m ahead, out in the open). */
  aim(): Aim | null {
    const p = this.sim.getPlayer(this.localId);
    if (!p) return null;
    const eye = { x: p.pos.x, y: p.pos.y + (p.crouched ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight), z: p.pos.z };
    const d = aimDir(p.yaw, p.pitch), far = 60;
    const tr = this.sim.world.traceRay(eye, { x: eye.x + d.x * far, y: eye.y + d.y * far, z: eye.z + d.z * far });
    if (tr.fraction < 1 && tr.brush) return { point: tr.end, normal: tr.normal, solid: this.sim.world.brushes.indexOf(tr.brush), yaw: p.yaw };
    return { point: { x: eye.x + d.x * REACH, y: eye.y + d.y * REACH, z: eye.z + d.z * REACH }, normal: { x: 0, y: 1, z: 0 }, solid: -1, yaw: p.yaw };
  }

  /**
   * Editing: everything the build bar shows (the tools, what you are holding,
   * what each mouse button would do right where you aim), and the outlines.
   */
  buildBar(): BuildBar | null {
    const ed = this.editor;
    if (!ed) return null;
    const a = this.flying ? this.aim() : null;
    const place = a ? ed.preview(a) : null, target = a ? ed.target(a) : null;
    const [w, h, d] = ed.size, block = ed.tool === 'block' || ed.tool === 'ramp' || ed.tool === 'deadly';
    const mat = ed.mats()[ed.mat] ?? 'concrete';
    return {
      tools: ed.tools().map((t) => ({ name: TOOL_NAMES[t], on: t === ed.tool })),
      item: block ? `${ed.tool === 'ramp' ? 'RAMP' : ed.tool === 'deadly' ? 'LAVA' : ed.shapeName.toUpperCase()} ${w}×${h}×${d}` : TOOL_NAMES[ed.tool],
      detail: ed.tool === 'weapon' ? WEAPONS[SPOT_WEAPONS[ed.weapon]].name : block && ed.tool !== 'deadly' ? mat : '',
      swatch: block ? (ed.tool === 'deadly' ? this.map.palette.mats.lava : this.map.palette.mats[mat]) ?? '#888888' : null,
      keys: block ? 'WHEEL shape · SHIFT+WHEEL height · R turn' + (ed.tool === 'deadly' ? '' : ' · Q material') : ed.tool === 'weapon' ? 'Q weapon' : '',
      place: !this.flying ? 'V to fly and build' : place ? `place ${ed.tool === 'checkpoint' ? `checkpoint ${ed.map.triggers.filter((t) => t.type === 'checkpoint').length + 1}` : TOOL_NAMES[ed.tool].toLowerCase()}` : 'aim at a floor',
      remove: target?.label.toLowerCase() ?? null,
      problem: ed.problem(),
      placeBox: place, target,
    };
  }

  /** Editing: place (or remove) what the current tool makes, where the crosshair is. */
  edit(remove: boolean): void {
    const a = this.aim(), ed = this.editor;
    if (a && ed && (remove ? ed.remove(a) : ed.place(a))) this.rebuild();
  }

  /** Same seed, a different number of players (2-6): possibly a different size, so a different map. */
  setPlayers(n: number): void {
    this.players = Math.max(2, Math.min(6, n));
    this.setSeed(this.seed);
  }

  setSeed(seed: number): void {
    if (this.editor) return;
    const old = this.sim?.getPlayer(this.localId);
    this.seed = seed >>> 0;
    this.map = generateMap(this.seed, pickMapSize(this.seed, this.players));
    this.sim = new GameSim(this.map, this.seed, RULES_PRACTICE);
    const p = this.sim.addPlayer(this.localId, 'LAB', PLAYER_COLORS[0]);
    this.sim.events.length = 0;
    p.noclip = this.flying;
    // Keep the camera where it was when flipping through seeds; first time, hover
    // above the map, far enough back to see all of it whatever its size.
    const e = this.map.extent ?? 24;
    if (old && this.flying) p.pos = { ...old.pos };
    else if (this.flying) p.pos = { x: 0, y: e * 1.1 + 4, z: e * 1.4 + 2 };
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
    const ed = this.editor;
    if (ed) {
      const m = this.map, cps = m.triggers.filter((t) => t.type === 'checkpoint').length;
      return `BUILDING ${ed.file.name} · ${m.solids.length} blocks · ${ed.file.kind === 'battle' ? `${m.spawns.length} spawns · ${m.pickups.length} weapon spots` : `${cps} checkpoints`}`;
    }
    const m = this.map;
    const count = (t: string) => m.triggers.filter((x) => x.type === t).length;
    const size = MAP_SIZES.find((z) => z.cells === m.info?.cells);
    const across = size ? `${size.name} ${size.cells * 3} m` : '?';
    return `SEED ${this.seed} · ${this.players} PLAYERS → ${across}, ${m.spawns.length} spawns · ${m.info?.archetype ?? '?'} · try ${(m.info?.attempt ?? 0) + 1} · ${m.solids.length} brushes · `
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
      const cmd = input.sample();
      if (this.editor) cmd.buttons &= ~(BTN.FIRE | BTN.FIRE2 | BTN.THROW | BTN.USE | BTN.SWAP); // (clicks place and remove: no punching)
      this.sim.setInput(this.localId, cmd);
      this.sim.step();
    }
    return this.acc / DT;
  }

  dispose(): void {}
}
