import { DT, PLAYER } from '../config/game';
import type { Vec3 } from '../core/vec';
import { courseById, type Course } from '../maps/parkour';
import type { RaceState } from './match';
import type { Player } from './types';
import type { World } from './world';

// PARKOUR races in online rooms. The host runs them (HostSession); everyone
// reads the same RaceState to draw the clock and the standings.

export const RACE = {
  /** Points by finishing place (1st, 2nd, ...); not finishing scores nothing. */
  points: [10, 7, 5, 4, 3, 2],
  /** Once the first runner finishes, the rest have this many seconds to. */
  afterFirst: 60,
  /** No course stays open longer than this (seconds). */
  limit: 600,
  /** Seconds the results of a course stay up before the next one. */
  resultsDelay: 7,
  /** Seconds the final standings stay up before the lobby. */
  finalDelay: 12,
  /** Metres below your checkpoint that count as a fall (no section drops further than this)... */
  fallBelow: 12,
  /** ...unless the deadly ground is within this far below you: then you fall onto it, and die there. */
  groundReach: 60,
};

/** Courses for a room: one by id, or 'all' of them in order. */
export function raceCourses(choice: string, all: string[]): string[] {
  return choice !== 'all' && all.includes(choice) ? [choice] : all;
}

export const raceCourse = (r: RaceState): Course => courseById(r.courses[r.index]) ?? courseById(r.courses[0])!;

/**
 * Fallen off (back to your checkpoint, no death)? Below the course, or more than
 * RACE.fallBelow under the spot you would come back to (`fromY`: your checkpoint's
 * height): courses climb high, and a fall from up there should not take ages to end.
 * But the courses have deadly ground not far under them (sand, the sea, the street):
 * while that is below you, you fall all the way onto it and die there, leaving
 * your remains, and come back from that.
 */
export function fellOff(course: Course, p: { pos: Vec3; grounded: boolean }, fromY: number, world: World): 'back' | 'die' | null {
  const pos = p.pos;
  if (pos.y < course.fallY) return 'back';
  if (pos.y >= fromY - RACE.fallBelow) return null;
  if (p.grounded) return 'die'; // landed somewhere far below the course (a rooftop, a dune): that is where it ends
  const tr = world.traceRay(pos, { x: pos.x, y: pos.y - RACE.groundReach, z: pos.z });
  return tr.fraction < 1 ? null : 'back'; // something to land on below: fall onto it; nothing (the void): back you go
}

/** Is the player's body inside this box? */
export function touching(p: Player, t: { min: Vec3; max: Vec3 }): boolean {
  return p.pos.x + PLAYER.radius > t.min.x && p.pos.x - PLAYER.radius < t.max.x
    && p.pos.z + PLAYER.radius > t.min.z && p.pos.z - PLAYER.radius < t.max.z
    && p.pos.y + PLAYER.height > t.min.y && p.pos.y < t.max.y;
}

/** Finish order: finishers by time, then the rest by checkpoints reached. Ids of `who` only. */
export function finishOrder(r: RaceState, who: number[]): number[] {
  const run = (id: number) => r.runners[id];
  return [...who].sort((a, b) => {
    const fa = run(a)?.finish ?? null, fb = run(b)?.finish ?? null;
    if (fa !== null && fb !== null) return fa - fb;
    if (fa !== null) return -1;
    if (fb !== null) return 1;
    return (run(b)?.cp ?? 0) - (run(a)?.cp ?? 0);
  });
}

/** Points for a course: by place, finishers only. */
export function awardPoints(r: RaceState, who: number[]): number[] {
  const order = finishOrder(r, who);
  order.forEach((id, i) => {
    if (r.runners[id]?.finish === null || r.runners[id] === undefined) return;
    r.points[id] = (r.points[id] ?? 0) + (RACE.points[i] ?? 1);
  });
  r.order = order;
  return order;
}

/** Seconds left before the course closes (from a sim tick). */
export const closesIn = (r: RaceState, tick: number): number => Math.max(0, (r.endTick - tick) * DT);

/** "1ST", "2ND", ... */
export const ordinal = (n: number): string => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'ST' : n % 10 === 2 && n % 100 !== 12 ? 'ND' : n % 10 === 3 && n % 100 !== 13 ? 'RD' : 'TH'}`;
