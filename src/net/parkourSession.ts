import { t } from '../core/i18n';
import { DT, PLAYER, PLAYER_COLORS, RULES_PRACTICE } from '../config/game';
import type { Vec3 } from '../core/vec';
import type { Course } from '../maps/parkour';
import { GameSim } from '../sim/game';
import type { MatchState, RosterPlayer } from '../sim/match';
import { fellOff, finishOrder, raceCourse } from '../sim/race';
import type { Player, SimEvent } from '../sim/types';
import type { InputSource, Session, SimView } from './session';

// PARKOUR: one player, one obstacle course, a clock. The clock starts when you leave
// the start platform and stops on the finish. Fall below the course and you are
// put back on the last checkpoint you reached (the clock keeps running); before
// the first one, back on the start with the clock reset. Best times and the
// splits of the best run are kept in this browser.

const STORE = 'slabrush-parkour';

export interface CourseRecord {
  best: number; // ticks
  splits: number[]; // ticks at each checkpoint on that run
}

export function loadRecords(): Record<string, CourseRecord> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, CourseRecord>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveRecord(id: string, r: CourseRecord): void {
  try {
    const all = loadRecords();
    all[id] = r;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* private mode: the best time lasts this visit only */ }
}

/** "1:02.37" from ticks. */
export function formatTime(ticks: number): string {
  const t = Math.max(0, ticks) * DT;
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** "+0.84" / "-1.20" from a difference in ticks. */
export const formatDelta = (ticks: number): string => (ticks < 0 ? '-' : '+') + (Math.abs(ticks) * DT).toFixed(2);

export interface RunState {
  course: Course;
  phase: 'ready' | 'running' | 'finished';
  ticks: number;
  /** checkpoints reached this run */
  cp: number;
  /** the last checkpoint reached: its time, and the difference to the best run's (null: no best yet) */
  split: { cp: number; ticks: number; delta: number | null } | null;
  best: CourseRecord | null;
  /** set on the finish */
  result: { ticks: number; newBest: boolean; delta: number | null; place?: number } | null;
  /** counts falls (the app plays a sound / flash on change) */
  falls: number;
}

/**
 * The clock of an online PARKOUR race, from the local player's side: built
 * every frame from the race the host runs, so the HUD draws it just like a
 * solo run. `tick` is the host's tick now (as near as this peer knows it);
 * `best` is this browser's best run of the course, or null.
 */
export function onlineRun(m: MatchState, localId: number, tick: number, best: CourseRecord | null): RunState | null {
  const r = m.race;
  const run = r?.runners[localId];
  if (!r || !run) return null;
  const course = raceCourse(r);
  const started = m.phase !== 'countdown' && r.startTick > 0;
  const phase: RunState['phase'] = run.finish !== null ? 'finished' : started ? 'running' : 'ready';
  const ticks = run.finish ?? (started ? Math.max(0, (m.phase === 'playing' ? tick : r.endTick) - r.startTick) : 0);
  const last = run.cp > 0 ? run.splits[run.cp - 1] : undefined;
  const before = best?.splits[run.cp - 1];
  const place = run.finish !== null ? finishOrder(r, Object.keys(r.runners).map(Number)).indexOf(localId) + 1 : 0;
  return {
    course, phase, ticks, cp: run.cp,
    split: last !== undefined ? { cp: run.cp, ticks: last, delta: before !== undefined ? last - before : null } : null,
    best,
    result: run.finish !== null ? { ticks: run.finish, newBest: !best || run.finish < best.best, delta: best ? run.finish - best.best : null, place } : null,
    falls: 0,
  };
}

export class ParkourSession implements Session {
  readonly kind = 'offline' as const;
  readonly localId = 1;
  readonly match: MatchState | null = null;
  readonly roster: RosterPlayer[] = [];
  readonly code = '';
  readonly maxPlayers = 1;
  readonly ping = 0;
  readonly mapVersion = 1;
  readonly roundVersion = 1;
  readonly ended = null;
  readonly map;
  readonly run: RunState;
  private sim: GameSim;
  private acc = 0;
  private splits: number[] = [];

  constructor(readonly course: Course, name: string, color = PLAYER_COLORS[0], look: number[] = [0, 0, 0]) {
    this.map = course.map;
    this.sim = new GameSim(this.map, 1, { ...RULES_PRACTICE, respawnPickups: false });
    this.sim.pickups.length = 0;
    const p = this.sim.addPlayer(this.localId, name, color);
    p.look = look;
    p.spawn = this.map.spawns[0];
    this.sim.respawn(p);
    this.run = { course, phase: 'ready', ticks: 0, cp: 0, split: null, best: loadRecords()[course.id] ?? null, result: null, falls: 0 };
  }

  get view(): SimView { return this.sim; }
  get events(): SimEvent[] { return this.sim.events; }
  get label(): string { return `${t('PARKOUR')} · ${t(this.course.name)} · ${t(this.course.difficulty)}`; }
  /** For tests. */
  get player(): Player { return this.sim.getPlayer(this.localId)!; }

  /** Back to the start, clock reset. */
  restart(): void {
    const p = this.player;
    p.spawn = this.map.spawns[0];
    this.sim.respawn(p);
    this.reset();
  }

  private reset(): void {
    const r = this.run;
    r.phase = 'ready';
    r.ticks = 0;
    r.cp = 0;
    r.split = null;
    r.result = null;
    this.splits = [];
  }

  update(dt: number, input: InputSource, active: boolean): number {
    if (!active) return 1;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.sim.setInput(this.localId, input.sample());
      this.step();
    }
    return this.acc / DT;
  }

  /** One tick: the sim, then the course. */
  step(): void {
    this.sim.step();
    const p = this.player;
    const r = this.run;
    if (r.phase === 'running') r.ticks++;
    const back = r.phase === 'running' && r.cp > 0 ? this.map.triggers.find((t) => t.type === 'checkpoint' && t.index === r.cp) : undefined;
    const fromY = back?.type === 'checkpoint' ? back.spawn.y : this.map.spawns[0].pos.y;
    const off = p.alive ? fellOff(this.course, p, fromY, this.sim.world) : null;
    if (off === 'die') this.sim.killByFall(p);
    if (!p.alive || off) { this.fall(p); return; }
    const inside = (t: { min: Vec3; max: Vec3 }) => p.pos.x + PLAYER.radius > t.min.x && p.pos.x - PLAYER.radius < t.max.x
      && p.pos.z + PLAYER.radius > t.min.z && p.pos.z - PLAYER.radius < t.max.z
      && p.pos.y + PLAYER.height > t.min.y && p.pos.y < t.max.y;
    for (const t of this.map.triggers) {
      if (t.type === 'start') {
        // Standing on the start: ready. Leaving it: go.
        if (inside(t)) { if (r.phase !== 'ready') this.reset(); }
        else if (r.phase === 'ready') r.phase = 'running';
      } else if (t.type === 'checkpoint' && r.phase === 'running' && t.index > r.cp && inside(t)) {
        r.cp = t.index;
        this.splits[t.index - 1] = r.ticks;
        const before = r.best?.splits[t.index - 1];
        r.split = { cp: t.index, ticks: r.ticks, delta: before !== undefined ? r.ticks - before : null };
      } else if (t.type === 'finish' && r.phase === 'running' && inside(t)) {
        r.phase = 'finished';
        const prev = r.best?.best ?? null;
        const newBest = prev === null || r.ticks < prev;
        r.result = { ticks: r.ticks, newBest, delta: prev === null ? null : r.ticks - prev };
        if (newBest) {
          r.best = { best: r.ticks, splits: [...this.splits] };
          saveRecord(this.course.id, r.best);
        }
      }
    }
  }

  /** Fell off: back on the last checkpoint (or the start, and the run starts over). */
  private fall(p: Player): void {
    const r = this.run;
    r.falls++;
    const cp = r.phase === 'running' && r.cp > 0
      ? this.map.triggers.find((t) => t.type === 'checkpoint' && t.index === r.cp) : undefined;
    if (cp && cp.type === 'checkpoint') {
      p.spawn = { pos: cp.spawn, yaw: cp.yaw };
      this.sim.respawn(p);
    } else {
      this.restart();
    }
  }

  dispose(): void {}
}
