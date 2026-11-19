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
  f: number; // flags: 1 alive, 2 crouched, 4 sliding, 8 grounded, 16 aiming, 32 bleeding, 64 soaked, 128 held in a beam, 256 beam on
  w: WeaponId | null; // held weapon (dual wielding: the left one)
  d: WeaponId | null; // dual wielding: the right-hand weapon, else null
  s: number; // horizontal speed (drives the run animation)
  h: number; // health, rounded (proximity voice gets thinner as it drops)
  g?: number; // MONOLOGUE: id of the player held in their beam (absent = nobody)
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
  sk: number; // soaked (FISH): icy footing, so prediction must know
  bl: number; // seconds of bleeding left (for the HUD)
  pb: number; // prevButtons
  hp: number;
  al: boolean;
  w: ([WeaponId, number] | null)[];
  ac: number;
  np: number; // nearPickup
  hb?: number; // held in the beam of this player (absent = free)
  ho?: number; // holding this player in our beam (absent = nobody)
  jt?: number; // JETHAMMER: seconds the rocket has burned (absent = off)
  jd?: [number, number, number]; // its line
  js?: number; // its speed
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

/**
 * Proximity voice handshake (WebRTC offer/answer/ICE). Voice audio itself
 * flows directly between players; only these small messages go through the
 * host, which relays them and stamps the sender so nobody can pose as another.
 */
export type VoiceSignal =
  | { k: 'offer' | 'answer'; sdp: string }
  | { k: 'ice'; c: RTCIceCandidateInit };

/** What the voice chat needs from a session: a way to reach another player for the handshake. */
export interface VoiceLink {
  send(to: number, d: VoiceSignal): void;
  onSignal: (from: number, d: VoiceSignal) => void;
}

/** Rejects anything that is not a well-formed voice signal of sane size (it came from the network). */
export function validVoiceSignal(d: unknown): d is VoiceSignal {
  if (!d || typeof d !== 'object') return false;
  const v = d as { k?: unknown; sdp?: unknown; c?: unknown };
  if (v.k === 'offer' || v.k === 'answer') return typeof v.sdp === 'string' && v.sdp.length < 20000;
  if (v.k === 'ice') {
    const c = v.c as { candidate?: unknown } | null;
    return !!c && typeof c === 'object' && typeof c.candidate === 'string' && c.candidate.length < 2000;
  }
  return false;
}

export type HostMsg =
  | { t: 'welcome'; id: number; code: string }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: RosterPlayer[]; maxPlayers: number }
  | { t: 'round'; match: MatchState } // a round is starting: rebuild the map if the seed changed, reset state
  | { t: 'match'; match: MatchState } // phase change
  | { t: 'ev'; ev: SimEvent[] }
  | { t: 'pong'; c: number }
  | { t: 'vsig'; from: number; d: VoiceSignal }
  | Snapshot;

export type ClientMsg =
  | { t: 'hello'; name: string; look: number[] }
  | { t: 'in'; cmds: InputCmd[] }
  | { t: 'ping'; c: number }
  | { t: 'vsig'; to: number; d: VoiceSignal };

export const FLAG_ALIVE = 1, FLAG_CROUCHED = 2, FLAG_SLIDING = 4, FLAG_GROUNDED = 8, FLAG_AIMING = 16, FLAG_BLEEDING = 32, FLAG_SOAKED = 64,
  FLAG_HELD = 128, FLAG_BEAM = 256, FLAG_BEAM_HURT = 512, FLAG_SHOUT = 1024,
  FLAG_JET = 2048, // JETHAMMER flying (the rocket is lit)
  FLAG_MIRROR = 4096; // REARVIEW field up

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
