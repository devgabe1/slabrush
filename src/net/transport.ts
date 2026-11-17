import type { ClientMsg, HostMsg } from './protocol';

// The sessions talk to these interfaces, never to WebRTC directly. Three
// implementations exist:
//   peerTransport.ts - the real one (WebRTC via PeerJS)
//   LocalHost/LocalClient below - BroadcastChannel between tabs of one browser,
//       for development without internet (open the game with ?local, add
//       &lag=80 to simulate 80 ms of one-way latency)
//   memoryPair below - synchronous in-process link for the headless tests

export interface HostTransport {
  code: string;
  onConnect: (peer: string) => void;
  onMessage: (peer: string, msg: ClientMsg) => void;
  onDisconnect: (peer: string) => void;
  send(peer: string, msg: HostMsg, reliable: boolean): void;
  close(): void;
}

export interface ClientTransport {
  onMessage: (msg: HostMsg) => void;
  onClose: (reason: string) => void;
  send(msg: ClientMsg, reliable: boolean): void;
  close(): void;
}

const noop = () => {};

// ---------------------------------------------------------------- local tabs
interface Packet {
  to: string;
  from: string;
  kind: 'connect' | 'accept' | 'data' | 'bye';
  msg?: unknown;
}

const urlLag = (): number =>
  typeof location === 'undefined' ? 0 : Number(new URLSearchParams(location.search).get('lag') ?? 0);

function later(lag: number, fn: () => void): void {
  if (lag > 0) setTimeout(fn, lag);
  else fn();
}

export function localHost(code: string): Promise<HostTransport> {
  const ch = new BroadcastChannel('slabrush-room-' + code);
  const lag = urlLag();
  const peers = new Set<string>();
  const t: HostTransport = {
    code, onConnect: noop, onMessage: noop, onDisconnect: noop,
    send: (peer, msg) => later(lag, () => ch.postMessage({ to: peer, from: 'host', kind: 'data', msg } satisfies Packet)),
    close: () => {
      for (const p of peers) ch.postMessage({ to: p, from: 'host', kind: 'bye' } satisfies Packet);
      ch.close();
    },
  };
  ch.onmessage = (e) => {
    const p = e.data as Packet;
    if (p.to !== 'host') return;
    if (p.kind === 'connect') {
      peers.add(p.from);
      ch.postMessage({ to: p.from, from: 'host', kind: 'accept' } satisfies Packet);
      t.onConnect(p.from);
    } else if (p.kind === 'data') t.onMessage(p.from, p.msg as ClientMsg);
    else if (p.kind === 'bye' && peers.delete(p.from)) t.onDisconnect(p.from);
  };
  return Promise.resolve(t);
}

export function localJoin(code: string): Promise<ClientTransport> {
  const ch = new BroadcastChannel('slabrush-room-' + code);
  const lag = urlLag();
  const me = 'c' + Math.random().toString(36).slice(2, 10);
  return new Promise((resolve, reject) => {
    let open = false;
    const t: ClientTransport = {
      onMessage: noop, onClose: noop,
      send: (msg) => later(lag, () => open && ch.postMessage({ to: 'host', from: me, kind: 'data', msg } satisfies Packet)),
      close: () => {
        if (open) ch.postMessage({ to: 'host', from: me, kind: 'bye' } satisfies Packet);
        open = false;
        ch.close();
      },
    };
    const timer = setTimeout(() => { ch.close(); reject(new Error('Room not found')); }, 1500);
    ch.onmessage = (e) => {
      const p = e.data as Packet;
      if (p.to !== me) return;
      if (p.kind === 'accept') { clearTimeout(timer); open = true; resolve(t); }
      else if (p.kind === 'data') t.onMessage(p.msg as HostMsg);
      else if (p.kind === 'bye') { open = false; t.onClose('The host left the match'); }
    };
    ch.postMessage({ to: 'host', from: me, kind: 'connect' } satisfies Packet);
  });
}

// ------------------------------------------------------------------- memory
/**
 * In-process link for tests. Messages are JSON round-tripped (so nothing
 * relies on shared object identity) and queued; call `pump()` to deliver.
 */
export function memoryPair(): { host: HostTransport; connect(): ClientTransport; pump(): void } {
  const queue: (() => void)[] = [];
  const clone = <T>(m: T): T => JSON.parse(JSON.stringify(m));
  let n = 0;
  const clients = new Map<string, ClientTransport>();
  const host: HostTransport = {
    code: 'TESTS', onConnect: noop, onMessage: noop, onDisconnect: noop,
    send: (peer, msg) => { const m = clone(msg); queue.push(() => clients.get(peer)?.onMessage(m)); },
    close: () => { for (const c of clients.values()) c.onClose('The host left the match'); clients.clear(); },
  };
  return {
    host,
    connect() {
      const id = 'm' + n++;
      const c: ClientTransport = {
        onMessage: noop, onClose: noop,
        send: (msg) => { const m = clone(msg); queue.push(() => clients.has(id) && host.onMessage(id, m)); },
        close: () => { if (clients.delete(id)) host.onDisconnect(id); },
      };
      clients.set(id, c);
      queue.push(() => host.onConnect(id));
      return c;
    },
    pump() {
      for (let i = 0; i < queue.length; i++) queue[i](); // handlers may enqueue more; deliver those too
      queue.length = 0;
    },
  };
}
