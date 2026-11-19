import { Peer, type DataConnection } from 'peerjs';
import type { ClientMsg, HostMsg } from './protocol';
import type { ClientTransport, HostTransport } from './transport';

// WebRTC transport through PeerJS. Signaling (the handshake that lets two
// browsers find each other) goes through PeerJS's free public broker; after
// that all game traffic is direct peer-to-peer. The room code IS the host's
// peer id (with a prefix), so there is nothing to store on any server.
//
// Each client opens two data channels to the host: "r" (reliable, ordered)
// and "u" (unordered, so one late packet never blocks newer ones).

const PREFIX = 'slabrush-v1-';
const noop = () => {};
const CONNECT_TIMEOUT = 15000;

function describe(err: unknown): string {
  const type = (err as { type?: string })?.type;
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return 'Could not reach the signaling server. Check your connection and try again.';
  }
  if (type === 'browser-incompatible') return 'This browser does not support WebRTC.';
  return (err as Error)?.message ?? String(err);
}

/** Resolves once the room is registered. Rejects with error.type 'unavailable-id' if the code is taken. */
export function peerHost(code: string, ice: RTCIceServer[]): Promise<HostTransport> {
  return new Promise((resolve, reject) => {
    const peer = new Peer(PREFIX + code, { config: { iceServers: ice } });
    const conns = new Map<string, { r?: DataConnection; u?: DataConnection }>();
    let ready = false;

    const t: HostTransport = {
      code, onConnect: noop, onMessage: noop, onDisconnect: noop,
      send(id, msg: HostMsg, reliable) {
        const c = conns.get(id);
        if (!c) return;
        const ch = !reliable && c.u?.open ? c.u : c.r;
        if (ch?.open) ch.send(msg);
      },
      // A moment's grace so the last messages (the 'closing' notice) get out first.
      close: () => { setTimeout(() => peer.destroy(), 250); },
    };

    peer.on('open', () => { ready = true; resolve(t); });
    peer.on('error', (err) => {
      if (!ready) { peer.destroy(); reject(Object.assign(new Error(describe(err)), { type: (err as { type?: string }).type })); }
      // After the room is up, errors are per-connection (a client failing to
      // connect); the room itself keeps running.
    });
    // Lost the broker but not the players: existing peers stay connected. Try
    // to get back so new players can still join.
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });

    peer.on('connection', (conn) => {
      const id = conn.peer;
      let entry = conns.get(id);
      if (!entry) conns.set(id, (entry = {}));
      const reliable = conn.label === 'r';
      if (reliable) entry.r = conn;
      else entry.u = conn;
      conn.on('open', () => { if (reliable) t.onConnect(id); });
      conn.on('data', (d) => t.onMessage(id, d as ClientMsg));
      conn.on('close', () => {
        if (reliable && conns.get(id)?.r === conn) {
          conns.get(id)?.u?.close();
          conns.delete(id);
          t.onDisconnect(id);
        }
      });
    });
  });
}

export function peerJoin(code: string, ice: RTCIceServer[]): Promise<ClientTransport> {
  return new Promise((resolve, reject) => {
    const peer = new Peer({ config: { iceServers: ice } });
    let r: DataConnection | undefined;
    let u: DataConnection | undefined;
    let joined = false;
    let closed = false;

    const fail = (reason: string) => {
      if (joined) { if (!closed) { closed = true; t.onClose(reason); } }
      else reject(new Error(reason));
      clearTimeout(timer);
      peer.destroy();
    };
    const timer = setTimeout(() => fail('Timed out connecting to the room. A firewall may be blocking peer-to-peer traffic (see TURN in Settings).'), CONNECT_TIMEOUT);

    const t: ClientTransport = {
      onMessage: noop, onClose: noop,
      send(msg: ClientMsg, reliable) {
        const ch = !reliable && u?.open ? u : r;
        if (ch?.open) ch.send(msg);
      },
      close: () => { closed = true; clearTimeout(timer); peer.destroy(); },
    };

    peer.on('error', (err) => {
      const type = (err as { type?: string }).type;
      if (type === 'peer-unavailable') fail('Room not found. Check the code — the host must keep the game open.');
      else if (!joined) fail(describe(err));
    });

    peer.on('open', () => {
      const host = PREFIX + code;
      r = peer.connect(host, { label: 'r', reliable: true, serialization: 'json' });
      u = peer.connect(host, { label: 'u', reliable: false, serialization: 'json' });
      r.on('open', () => { joined = true; clearTimeout(timer); resolve(t); });
      r.on('data', (d) => t.onMessage(d as HostMsg));
      r.on('close', () => fail('The host left the match'));
      u.on('data', (d) => t.onMessage(d as HostMsg));
    });
  });
}
