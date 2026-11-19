// Rooms on the local network.
//
// A web page cannot search the network for games by itself (no broadcast or
// mDNS from a browser). But when someone hosts from their own machine
// (`npm run dev` / `dev:lan` / `preview`), everyone on the network opens the
// game from that machine's server, so that server keeps the list: hosts
// announce their room every few seconds, the join screen asks for the list.
// On static hosting (GitHub Pages) there is no list: the request fails and the
// join screen simply shows the code field, as before.
//
// This file has both halves: the browser side (announce / withdraw / list),
// and the list itself as plain logic that the dev-server plugin in
// vite.config.ts wraps (and the tests drive directly).

export interface RoomListing {
  code: string; // the room code to join with
  host: string; // host's nickname
  players: number;
  max: number;
  phase: 'lobby' | 'playing'; // both can be joined: mid-match, you play from the next round
  local: boolean; // a ?local (same-browser) room; only listed to ?local pages
}

/** Seconds between a host's announcements, and after which a silent room drops off. */
export const ANNOUNCE_EVERY = 2.5;
export const ROOM_TTL = 8;

const ENDPOINT = './__rooms';

/**
 * Set once the server has shown it keeps no list (static hosting answers 404
 * or 405, or with an HTML page): from then on this page stops asking, instead
 * of sending a request every few seconds for nothing.
 */
let unavailable = false;
const noList = (res: Response) => !res.ok || !(res.headers.get('content-type') ?? '').includes('application/json');

// ---------------------------------------------------------------- browser side

/** The rooms on this network, or null when there is no list (static hosting, offline). */
export async function listRooms(): Promise<RoomListing[] | null> {
  if (unavailable) return null;
  try {
    const res = await fetch(ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (noList(res)) { unavailable = true; return null; }
    const body = await res.json() as { rooms?: unknown };
    return Array.isArray(body.rooms) ? body.rooms.map(cleanListing).filter((r): r is RoomListing => !!r) : null;
  } catch {
    return null;
  }
}

/** Put (or keep) this room on the list. Silent if there is no list. */
export function announceRoom(room: RoomListing): void {
  if (unavailable) return;
  void fetch(ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(room), keepalive: true,
  }).then((res) => { if (noList(res)) unavailable = true; }, () => {});
}

/** Take the room off the list (room closed, match left, tab closing). */
export function withdrawRoom(code: string): void {
  if (unavailable) return;
  const body = JSON.stringify({ code, gone: true });
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
    local: o.local === true,
  };
}

/** The list kept by the server: announcements in, fresh rooms out. `now` in seconds. */
export class RoomDirectory {
  private rooms = new Map<string, { room: RoomListing; seen: number }>();

  /** A POST body: an announcement, or `{ code, gone: true }`. Returns false if it was rejected. */
  post(body: unknown, now: number): boolean {
    const gone = !!body && typeof body === 'object' && (body as { gone?: unknown }).gone === true;
    const room = cleanListing(body);
    if (!room) return false;
    if (gone) { this.rooms.delete(room.code); return true; }
    this.expire(now);
    if (!this.rooms.has(room.code) && this.rooms.size >= 64) return false; // a LAN has a handful, not hundreds
    this.rooms.set(room.code, { room, seen: now });
    return true;
  }

  list(now: number): RoomListing[] {
    this.expire(now);
    return [...this.rooms.values()].map((r) => r.room); // in the order they first appeared, so the list does not jump
  }

  private expire(now: number): void {
    for (const [code, r] of this.rooms) if (now - r.seen > ROOM_TTL) this.rooms.delete(code);
  }
}
