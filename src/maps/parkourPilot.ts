import { BTN, type InputCmd, type Player } from '../sim/types';
import type { Course } from './parkour';

// An autopilot for the parkour courses: follows a course's route, waypoint by
// waypoint. Used by scripts/parkourtest.ts to prove each course can be
// finished (and handy for watching one being run). Not part of the game.

export interface PilotState {
  i: number; // the waypoint we are heading for
  setOff: number; // the waypoint whose wait is over
}

export const newPilot = (): PilotState => ({ i: 0, setOff: -1 });

/**
 * `solidBelow(x, y, z)`: is there floor within a step under this point? Lets
 * the pilot jump at the edge of a platform rather than wherever a hop lands it.
 */
export function pilot(c: Course, p: Player, tick: number, st: PilotState, solidBelow: (x: number, y: number, z: number) => boolean): Partial<InputCmd> {
  // Past every waypoint we are close enough to.
  for (;;) {
    const wp = c.route[st.i];
    if (!wp) return { moveF: 0, moveR: 0, buttons: 0 };
    const d = Math.hypot(wp.x - p.pos.x, wp.z - p.pos.z);
    if (d < (wp.reach ?? 1) && p.pos.y > wp.y - 0.6 && p.pos.y < wp.y + 2.5) { st.i++; continue; }
    break;
  }
  const wp = c.route[st.i];
  const yaw = Math.atan2(-(wp.x - p.pos.x), -(wp.z - p.pos.z));
  if (wp.wait && st.setOff !== st.i) {
    if (!wp.wait(tick)) return { yaw, moveF: 0, moveR: 0, buttons: 0 };
    st.setOff = st.i;
  }
  let buttons = 0;
  switch (wp.move) {
    case 'hop': // bunny hops: jump on every landing
      if (p.grounded) buttons = BTN.JUMP;
      break;
    case 'run': {
      // Run, and jump off at the edge: when the floor a stride ahead is gone.
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const ahead = Math.max(0.45, sp * 0.06);
      const fx = sp > 0.5 ? p.vel.x / sp : -Math.sin(yaw), fz = sp > 0.5 ? p.vel.z / sp : -Math.cos(yaw);
      if (p.grounded && !solidBelow(p.pos.x + fx * ahead, p.pos.y, p.pos.z + fz * ahead)) buttons = BTN.JUMP;
      break;
    }
    case 'crouch': buttons = BTN.CROUCH; break;
    case 'climb':
      // Jump off the floor, then press jump again (a fresh press each time) whenever falling back.
      if (p.grounded || (p.vel.y < 2 && tick % 2 === 0)) buttons = BTN.JUMP;
      break;
  }
  return { yaw, moveF: 1, moveR: 0, buttons };
}
