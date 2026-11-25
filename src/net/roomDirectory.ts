// The list of public rooms (JOIN ROOM).
//
// A web page cannot search the network for games by itself, so something has
// to keep the list. Two things can:
//   - the dev server, when the game is served from someone's machine
//     (`npm run dev` / `dev:lan` / `preview`): hosts announce their room to it
//     over HTTP, the join screen asks it for the list;
//   - one of the players' browsers, on static hosting (GitHub Pages), where
//     there is no server: see peerDirectory.ts. The first browser that needs
//     the list claims a well-known PeerJS address and keeps it; everyone else
//     talks to that browser, and if it goes, the next one takes over.
// The HTTP list is tried first; once a page sees there is none, it switches to
// the browser-kept one for good.
//
// This file has the browser side (announce / withdraw / list), and the list
// itself as plain logic: RoomDirectory (the dev-server plugin in
// vite.config.ts wraps it) and DirectoryHub (the browser that keeps the list
// runs it). The tests drive both directly.

export interface RoomListing {
  code: string; // the room code to join with
  host: string; // host's nickname
  players: number;
  max: number;
  phase: 'lobby' | 'playing'; // both can be joined: mid-match, you play from the next round
  mode: 'battle' | 'parkour'; // what the room plays
  course: string; // parkour: a course id, or 'all'
  local: boolean; // a ?local (same-browser) room; only listed to ?local pages
  /**
   * When the host sent this (its own clock, ms). Lets the list tell a late
   * announcement from a fresh one: one sent before the room was withdrawn
   * must not bring it back. 0 = unknown.
   */
  at: number;
}

/**
 * Seconds between a host's announcements, and after which a silent room drops
 * off. A room whose host closes the game normally is withdrawn at once; these
 * only matter when the host vanishes without a word (crash, lost power), and
 * are kept short so such a room is gone within a few seconds.
 */
export const ANNOUNCE_EVERY = 1.25;
export const ROOM_TTL = 4;
/** Seconds a withdrawal is remembered, so a delayed announcement cannot put the room back. */
const GONE_MEMORY = 60;

const ENDPOINT = './__rooms';

/**
 * Set once the server has shown it keeps no list (static hosting answers 404
 * or 405, or with an HTML page): from then on this page stops asking, instead
 * of sending a request every few seconds for nothing.
 */
let unavailable = false;
const noList = (res: Response) => !res.ok || !(res.headers.get('content-type') ?? '').includes('application/json');

// ---------------------------------------------------------------- browser side

/** `?peerlist` in the address: skip the dev server's list and use the browser-kept one (for testing it locally). */
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('peerlist')) unavailable = true;

/**
 * Only a page served from this machine or the local network can have the dev
 * server's list. Anywhere else (GitHub Pages) there is none: go straight to the
 * browser-kept list, without a request that can only fail (a 404 in the console).
 */
export function servedLocally(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
if (typeof location !== 'undefined' && !servedLocally(location.hostname)) unavailable = true;

/** The browser-kept list, loaded on first use (it pulls in PeerJS). */
let peerList: Promise<typeof import('./peerDirectory')> | null = null;
const peers = () => (peerList ??= import('./peerDirectory'));

/** The public rooms, or null when there is no list (offline, or nobody can keep one). */
export async function listRooms(): Promise<RoomListing[] | null> {
  if (unavailable) return (await peers()).peerDirectory().list();
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (noList(res)) { unavailable = true; return listRooms(); }
    const body = await res.json() as { rooms?: unknown };
    return Array.isArray(body.rooms) ? body.rooms.map(cleanListing).filter((r): r is RoomListing => !!r) : null;
  } catch {
    return null;
  }
}

/** Put (or keep) this room on the list. */
export function announceRoom(room: Omit<RoomListing, 'at'>): void {
  const body = { ...room, at: Date.now() };
  if (unavailable) { void peers().then((m) => m.peerDirectory().announce(body)); return; }
  void fetch(ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
  }).then((res) => { if (noList(res)) { unavailable = true; announceRoom(room); } }, () => {});
}

/** Take the room off the list (room closed, match left, gone private, tab closing). */
export function withdrawRoom(code: string): void {
  if (unavailable) { void peers().then((m) => m.peerDirectory().withdraw(code)); return; }
  const body = JSON.stringify({ code, gone: true, at: Date.now() });
  // sendBeacon survives the tab closing; fetch is the fallback.
  if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
    void fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ the list

/** Anything off the network becomes a valid listing, or null. */
export function cleanListing(v: unknown): RoomListing | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const code = typeof o.code === 'string' ? o.code.toUpperCase() : '';
  if (!/^[A-Z]{5}$/.test(code)) return null;
  const int = (n: unknown, lo: number, hi: number, dflt: number) => (Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi ? (n as number) : dflt);
  const host = (typeof o.host === 'string' ? o.host : '').replace(/[<>&"]/g, '').trim().slice(0, 14) || 'PLAYER';
  return {
    code, host,
    players: int(o.players, 0, 6, 1),
    max: int(o.max, 2, 6, 6),
    phase: o.phase === 'playing' ? 'playing' : 'lobby',
    mode: o.mode === 'parkour' ? 'parkour' : 'battle',
    course: typeof o.course === 'string' && /^[a-z0-9]{1,24}$/.test(o.course) ? o.course : 'all',
    local: o.local === true,
    at: typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? o.at : 0,
  };
}

/** The list kept by the server: announcements in, fresh rooms out. `now` in seconds. */
export class RoomDirectory {
  private rooms = new Map<string, { room: RoomListing; seen: number }>();
  /** Rooms recently withdrawn: their code, the host's time of withdrawal, and when we heard. */
  private gone = new Map<string, { at: number; heard: number }>();

  /** A POST body: an announcement, or `{ code, gone: true }`. Returns false if it was rejected. */
  post(body: unknown, now: number): boolean {
    const isGone = !!body && typeof body === 'object' && (body as { gone?: unknown }).gone === true;
    const room = cleanListing(body);
    if (!room) return false;
    if (isGone) {
      this.rooms.delete(room.code);
      this.gone.set(room.code, { at: room.at, heard: now });
      return true;
    }
    this.expire(now);
    // An announcement that left the host before its withdrawal, arriving late: ignore it.
    // (One sent after it, when the host makes the room public again, is welcome.)
    const g = this.gone.get(room.code);
    if (g && (!room.at || !g.at || room.at <= g.at)) return false;
    if (g) this.gone.delete(room.code);
    if (!this.rooms.has(room.code) && this.rooms.size >= 64) return false; // a LAN has a handful, not hundreds
    this.rooms.set(room.code, { room, seen: now });
    return true;
  }

  /** Off the list, with no memory of it (its host may well announce it again: a connection blip). */
  remove(code: string): void {
    this.rooms.delete(code);
  }

  list(now: number): RoomListing[] {
    this.expire(now);
    return [...this.rooms.values()].map((r) => r.room); // in the order they first appeared, so the list does not jump
  }

  private expire(now: number): void {
    for (const [code, r] of this.rooms) if (now - r.seen > ROOM_TTL) this.rooms.delete(code);
    for (const [code, g] of this.gone) if (now - g.heard > GONE_MEMORY) this.gone.delete(code);
  }
}

// ------------------------------------------------------- the browser-kept list
/** What players say to the browser keeping the list, and what it answers. */
export type HubRequest =
  | { t: 'announce'; room: unknown }
  | { t: 'withdraw'; code: unknown; at?: unknown }
  | { t: 'list' };
export type HubReply = { t: 'rooms'; rooms: RoomListing[] };

/**
 * The list as kept by one player's browser for everyone (peerDirectory.ts
 * feeds it). Like the dev server's, plus one thing a server cannot know:
 * which connection announced which room. When a host's connection to the
 * keeper closes, their rooms are taken off at once.
 */
export class DirectoryHub {
  readonly dir = new RoomDirectory();
  private owned = new Map<string, Set<string>>(); // connection -> room codes it announced

  /** A message from connection `conn` (`now` in seconds). Returns the reply to send back, if any. */
  receive(conn: string, msg: unknown, now: number): HubReply | null {
    if (!msg || typeof msg !== 'object') return null;
    const m = msg as HubRequest;
    if (m.t === 'list') return { t: 'rooms', rooms: this.dir.list(now) };
    if (m.t === 'announce') {
      const room = cleanListing(m.room);
      if (room && this.dir.post(m.room, now)) {
        let set = this.owned.get(conn);
        if (!set) this.owned.set(conn, (set = new Set()));
        set.add(room.code);
      }
    } else if (m.t === 'withdraw') {
      if (typeof m.code === 'string') this.dir.post({ code: m.code, gone: true, at: m.at }, now);
    }
    return null;
  }

  /** Connection `conn` closed: whatever it announced is gone. */
  closed(conn: string): void {
    for (const code of this.owned.get(conn) ?? []) this.dir.remove(code);
    this.owned.delete(conn);
  }
}
