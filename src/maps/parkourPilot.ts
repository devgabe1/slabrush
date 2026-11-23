import { BTN, type InputCmd, type Player } from '../sim/types';
import type { Course } from './parkour';

// An autopilot for the parkour courses: follows a course's route, waypoint by
// waypoint. Used by scripts/parkourtest.ts to prove each course can be
// finished (and handy for watching one being run). Not part of the game.

export interface PilotState {
  i: number; // the waypoint we are heading for
  setOff: number; // the waypoint whose wait is over
  last: { x: number; y: number; z: number } | null; // where we were last tick (a portal moves us far in one)
}

export const newPilot = (): PilotState => ({ i: 0, setOff: -1, last: null });

/** What the pilot can feel of the world around its feet. */
export interface PilotProbe {
  /** Is there floor within a step under this point? */
  floor(x: number, y: number, z: number): boolean;
  /** Is there something solid here (a hurdle at knee height, say)? */
  solid(x: number, y: number, z: number): boolean;
}

export function pilot(c: Course, p: Player, tick: number, st: PilotState, probe: PilotProbe): Partial<InputCmd> {
  // Carried off by a portal: the waypoint in it is done.
  if (st.last && Math.hypot(p.pos.x - st.last.x, p.pos.y - st.last.y, p.pos.z - st.last.z) > 4) st.i++;
  st.last = { ...p.pos };
  // Past every waypoint we are close enough to.
  for (;;) {
    const wp = c.route[st.i];
    if (!wp) return { moveF: 0, moveR: 0, buttons: 0 };
    const d = Math.hypot(wp.x - p.pos.x, wp.z - p.pos.z);
    if (d < (wp.reach ?? 1) && p.pos.y > wp.y - 0.6 && p.pos.y < wp.y + 2.5 && (!wp.land || p.grounded)) { st.i++; continue; }
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
    case 'run':
    case 'wallrun': {
      // Run, and jump off at the edge: when the floor a stride ahead is gone.
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const ahead = Math.max(0.45, sp * 0.06);
      const fx = sp > 0.5 ? p.vel.x / sp : -Math.sin(yaw), fz = sp > 0.5 ? p.vel.z / sp : -Math.cos(yaw);
      const ax = p.pos.x + fx * ahead, az = p.pos.z + fz * ahead;
      if (p.grounded && !probe.floor(ax, p.pos.y, az)) buttons = BTN.JUMP;
      // A hurdle just ahead (something at knee height, clear above it): over it.
      for (const k of [0.5, 0.8, 1.1, 1.4]) {
        const hx = p.pos.x + fx * k * Math.max(1, sp * 0.12), hz = p.pos.z + fz * k * Math.max(1, sp * 0.12);
        if (p.grounded && probe.solid(hx, p.pos.y + 0.5, hz) && !probe.solid(hx, p.pos.y + 1.6, hz)) buttons = BTN.JUMP;
      }
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
