import { Peer, type DataConnection } from 'peerjs';
import { DirectoryHub, cleanListing, type HubReply, type RoomListing } from './roomDirectory';

// The public room list on static hosting, kept by one of the players' own
// browsers. There is no server, but every player already talks to PeerJS's
// free public broker (it is how rooms are reached), and the broker hands out
// addresses first come, first served. So:
//
//   - The first browser that needs the list (someone opening JOIN ROOM, or
//     hosting a public room) claims the well-known address below and keeps
//     the list in memory: it becomes the KEEPER.
//   - Everyone else finds the address taken, and connects to the keeper:
//     hosts announce their rooms to it, join screens ask it for the list.
//   - If the keeper goes (closes the game), its connections close. Each of
//     them waits a moment (a random one, so they do not all rush at once) and
//     tries to claim the address; one wins and becomes the new keeper, the
//     rest connect to it. Hosts announce every 1.25 s anyway, so the list is
//     whole again within a couple of seconds.
//
// Started on first use, then kept for as long as the page is open.

const KEEPER_ID = 'slabrush-v1-room-list';
/** How long a list request waits for the keeper's answer before using the last list it had. */
const ANSWER_WAIT = 1200;
/** Retry delays after losing the keeper, or failing to reach it (ms). Randomised within the range. */
const RETRY = [400, 1600] as const;
/**
 * A keeper whose page has been hidden this long hands the list over (ms). Browsers
 * throttle, freeze or suspend hidden tabs (phones above all): such a tab could hold
 * the address yet never answer, and nobody would see any rooms. A hidden page never
 * becomes the keeper in the first place, either.
 */
const HIDDEN_HANDOFF = 15000;
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

type Role = 'starting' | 'keeper' | 'member' | 'offline';

class PeerDirectory {
  private role: Role = 'offline';
  private peer: Peer | null = null;
  // as the keeper
  private hub: DirectoryHub | null = null;
  private members = new Set<DataConnection>();
  // as a member
  private link: DataConnection | null = null;
  private latest: RoomListing[] | null = null;
  private waiting: ((rooms: RoomListing[] | null) => void)[] = [];
  private retryTimer = 0;

  private hiddenTimer = 0;

  constructor(private ice: RTCIceServer[]) {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.hiddenTimer);
      if (hidden()) this.hiddenTimer = window.setTimeout(() => this.stepDown(), HIDDEN_HANDOFF);
    });
    addEventListener('freeze', () => this.stepDown()); // about to be frozen: hand over now
  }

  /** Stop keeping the list (the page is hidden): the members' links close, and one of them takes over. */
  private stepDown(): void {
    if (this.role !== 'keeper') return;
    this.peer?.destroy();
    this.peer = null;
    this.hub = null;
    this.members.clear();
    this.role = 'offline'; // the next list or announcement finds the new keeper
  }

  /** The current list (null while it cannot be reached at all). */
  async list(): Promise<RoomListing[] | null> {
    this.start();
    if (this.role === 'keeper') return this.hub!.dir.list(now());
    if (this.role !== 'member' || !this.link?.open) return this.latest;
    this.link.send({ t: 'list' });
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      setTimeout(() => {
        const i = this.waiting.indexOf(resolve);
        if (i >= 0) { this.waiting.splice(i, 1); resolve(this.latest); }
      }, ANSWER_WAIT);
    });
  }

  announce(room: RoomListing): void {
    this.start();
    if (this.role === 'keeper') this.hub!.receive('self', { t: 'announce', room }, now());
    else if (this.link?.open) this.link.send({ t: 'announce', room });
    // Not connected yet: the next announcement (1.25 s on) gets through.
  }

  withdraw(code: string): void {
    const msg = { t: 'withdraw', code, at: Date.now() };
    if (this.role === 'keeper') this.hub!.receive('self', msg, now());
    else if (this.link?.open) this.link.send(msg);
  }

  // ---------------------------------------------------------------- roles
  private start(): void {
    if (this.role !== 'offline') return;
    this.role = 'starting';
    clearTimeout(this.retryTimer);
    if (hidden()) { this.becomeMember(); return; } // a hidden page only ever talks to a keeper
    // Try to become the keeper.
    const peer = new Peer(KEEPER_ID, { config: { iceServers: this.ice } });
    this.peer = peer;
    peer.on('open', () => this.becomeKeeper(peer));
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type;
      if (this.role !== 'starting' || this.peer !== peer) return;
      peer.destroy();
      if (type === 'unavailable-id') this.becomeMember(); // someone keeps it already: talk to them
      else this.retry(); // no broker (offline?): try again later
    });
  }

  private becomeKeeper(peer: Peer): void {
    this.role = 'keeper';
    const hub = (this.hub = new DirectoryHub());
    let n = 0;
    peer.on('connection', (conn) => {
      const id = 'c' + n++;
      conn.on('open', () => this.members.add(conn));
      conn.on('data', (d) => {
        const reply = hub.receive(id, d, now());
        if (reply && conn.open) conn.send(reply);
      });
      conn.on('close', () => { this.members.delete(conn); hub.closed(id); });
      conn.on('error', () => { this.members.delete(conn); hub.closed(id); });
    });
    // Lost the broker but not the members: get back so new players can still reach us.
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    // Leaving: close the members' links, so one of them takes over at once.
    addEventListener('pagehide', () => peer.destroy());
  }

  private becomeMember(): void {
    const peer = new Peer({ config: { iceServers: this.ice } });
    this.peer = peer;
    const give = () => { peer.destroy(); this.link = null; this.retry(); };
    peer.on('error', () => { if (this.peer === peer && this.role === 'starting') give(); });
    peer.on('open', () => {
      const link = peer.connect(KEEPER_ID, { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => { if (!link.open) give(); }, 8000);
      link.on('open', () => {
        clearTimeout(timer);
        this.role = 'member';
        this.link = link;
        link.send({ t: 'list' });
      });
      link.on('data', (d) => this.answer(d));
      link.on('close', () => { if (this.link === link) give(); }); // the keeper left: someone takes over
      link.on('error', () => { if (this.link === link) give(); });
    });
  }

  private answer(d: unknown): void {
    const m = d as HubReply;
    if (!m || m.t !== 'rooms' || !Array.isArray(m.rooms)) return;
    this.latest = m.rooms.map(cleanListing).filter((r): r is RoomListing => !!r);
    for (const w of this.waiting.splice(0)) w(this.latest);
  }

  private retry(): void {
    this.role = 'offline';
    this.peer = null;
    for (const w of this.waiting.splice(0)) w(this.latest);
    this.retryTimer = window.setTimeout(() => this.start(), RETRY[0] + Math.random() * (RETRY[1] - RETRY[0]));
  }
}

const now = () => performance.now() / 1000;

let instance: PeerDirectory | null = null;
let iceServers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** The ICE servers to use (the app passes the same ones as for rooms, TURN included). Before first use. */
export function setDirectoryIce(ice: RTCIceServer[]): void {
  iceServers = ice;
}

/** This page's way to the browser-kept list (started on first use). */
export function peerDirectory(): PeerDirectory {
  return (instance ??= new PeerDirectory(iceServers));
}
