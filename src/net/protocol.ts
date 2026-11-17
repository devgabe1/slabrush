import type { WeaponId } from '../config/weapons';
import type { MatchState, RosterPlayer } from '../sim/match';
import type { InputCmd, SimEvent } from '../sim/types';

// Wire format. Everything is plain JSON: at 30 snapshots/s for up to 6
// players this is a few kB/s per peer, far below what WebRTC handles.
//
// Two channels per peer:
//   reliable   - lobby, match/round state, simulation events (must all arrive, in order)
//   unreliable - inputs, snapshots, pings (newest wins; unordered so a lost
//                packet never stalls the ones behind it)

/** Snapshot entry for one player (what everyone needs to draw them). */
export interface SnapPlayer {
  i: number; // id
  x: number; y: number; z: number;
  a: number; // yaw
  b: number; // pitch
  f: number; // flags: 1 alive, 2 crouched, 4 sliding, 8 grounded
  w: WeaponId | null; // held weapon (dual wielding: the left one)
  d: WeaponId | null; // dual wielding: the right-hand weapon, else null
  s: number; // horizontal speed (drives the run animation)
}

export interface SnapPickup {
  i: number;
  w: WeaponId;
  n: number; // ammo
  x: number; y: number; z: number;
  r: 0 | 1; // resting
}

export interface SnapProjectile {
  i: number;
  k: WeaponId; // which weapon fired it (decides how it looks)
  s: number; // 0 flying, 1 stuck / resting, 2 an active trap (gas cloud)
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

/** The receiving player's own authoritative state, used to reconcile prediction. */
export interface SnapMe {
  p: [number, number, number];
  v: [number, number, number];
  cr: boolean; // crouched
  sl: boolean; // sliding
  sb: number; // slideBoostTimer
  wl: number; // wallJumpsLeft
  wt: number; // wallJumpTimer
  tt: number; // teleTimer
  gt: number; // groundTime
  lt: number; // launchTimer
  rt: number; // rooted
  st: number; // stun
  pb: number; // prevButtons
  hp: number;
  al: boolean;
  w: ([WeaponId, number] | null)[];
  ac: number;
  np: number; // nearPickup
}

export interface Snapshot {
  t: 'snap';
  tick: number;
  ack: number; // last input seq the host has simulated for the receiver
  me: SnapMe | null;
  pl: SnapPlayer[];
  pk: SnapPickup[];
  pr: SnapProjectile[];
  zr: number; // zone radius, 0 = no zone
}

export type HostMsg =
  | { t: 'welcome'; id: number; code: string }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: RosterPlayer[]; maxPlayers: number }
  | { t: 'round'; match: MatchState } // a round is starting: rebuild the map if the seed changed, reset state
  | { t: 'match'; match: MatchState } // phase change
  | { t: 'ev'; ev: SimEvent[] }
  | { t: 'pong'; c: number }
  | Snapshot;

export type ClientMsg =
  | { t: 'hello'; name: string; look: number[] }
  | { t: 'in'; cmds: InputCmd[] }
  | { t: 'ping'; c: number };

export const FLAG_ALIVE = 1, FLAG_CROUCHED = 2, FLAG_SLIDING = 4, FLAG_GROUNDED = 8;

/** Public STUN servers, plus the user's optional TURN server (Settings) for restrictive NATs. */
export function iceServers(turn: { url: string; username: string; credential: string }): RTCIceServer[] {
  const list: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  if (turn.url.trim()) list.push({ urls: turn.url.trim(), username: turn.username, credential: turn.credential });
  return list;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read out loud
export function randomRoomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
