import { DT, MATCH, NET, PLAYER_COLORS, RULES_MATCH } from '../config/game';
import { cleanLook } from '../config/looks';
import { generateMap } from '../maps/generator';
import { GameSim, isDual } from '../sim/game';
import type { MapDef } from '../sim/map';
import { newMatchState, type MatchState, type RosterPlayer } from '../sim/match';
import { emptyCmd, type InputCmd, type Player, type SimEvent } from '../sim/types';
import {
  FLAG_ALIVE, FLAG_CROUCHED, FLAG_GROUNDED, FLAG_SLIDING,
  type ClientMsg, type HostMsg, type SnapMe, type Snapshot,
} from './protocol';
import type { InputSource, Session, SimView } from './session';
import type { HostTransport } from './transport';

interface Peer {
  id: number; // player id, 0 until they said hello
  queue: InputCmd[]; // inputs received but not simulated yet
  last: InputCmd; // repeated if the queue runs dry
  lastQueued: number; // highest seq queued (drops duplicates from input redundancy)
  ack: number; // last seq simulated
  heard: number; // clock time of the last packet
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const randomSeed = () => (Math.random() * 0x100000000) >>> 0; // the host's choice; peers receive the result

/**
 * The room host: runs the one authoritative GameSim, feeds it everybody's
 * inputs, drives the round/map/match state machine, and streams snapshots
 * and events to the other peers. The host player's own input is applied
 * directly, with no latency.
 */
export class HostSession implements Session {
  readonly kind = 'host' as const;
  readonly localId = 1;
  readonly events: SimEvent[] = [];
  readonly ping = 0;
  match: MatchState = newMatchState();
  roster: RosterPlayer[];
  maxPlayers: number = MATCH.maxPlayers;
  mapVersion = 1;
  roundVersion = 1;
  ended: string | null = null;
  map: MapDef;
  sim: GameSim;

  private peers = new Map<string, Peer>();
  private nextId = 2;
  private acc = 0;

  /** `pickSeed` chooses map and round seeds; tests pass a fixed sequence so runs are repeatable. */
  constructor(
    private tr: HostTransport, name: string,
    private clock: () => number = () => performance.now(),
    private pickSeed: () => number = randomSeed,
    look: number[] = [0, 0, 0],
  ) {
    this.roster = [{ id: this.localId, name, color: PLAYER_COLORS[0], look: cleanLook(look) }];
    this.map = generateMap(1);
    this.sim = new GameSim(this.map, 1, RULES_MATCH); // placeholder until the match starts
    tr.onConnect = (peer) => this.peers.set(peer, { id: 0, queue: [], last: emptyCmd(), lastQueued: -1, ack: -1, heard: this.clock() });
    tr.onMessage = (peer, msg) => this.onMessage(peer, msg);
    tr.onDisconnect = (peer) => this.drop(peer);
  }

  get view(): SimView { return this.sim; }
  get code(): string { return this.tr.code; }

  // ------------------------------------------------------------- lobby
  setMaxPlayers(n: number): void {
    this.maxPlayers = Math.max(2, Math.min(PLAYER_COLORS.length, Math.max(n, this.roster.length)));
    this.broadcastLobby();
  }

  private onMessage(peerId: string, msg: ClientMsg): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.heard = this.clock();
    switch (msg.t) {
      case 'hello': {
        if (peer.id) return;
        const reason = this.match.phase !== 'lobby' ? 'That match is already in progress.'
          : this.roster.length >= this.maxPlayers ? 'That room is full.' : null;
        if (reason) { this.tr.send(peerId, { t: 'reject', reason }, true); return; }
        peer.id = this.nextId++;
        const used = new Set(this.roster.map((p) => p.color));
        const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
        const name = String(msg.name).replace(/[<>&"]/g, '').trim().slice(0, 14) || 'PLAYER';
        this.roster.push({ id: peer.id, name, color, look: cleanLook(msg.look) }); // never trust what arrives
        this.tr.send(peerId, { t: 'welcome', id: peer.id, code: this.code }, true);
        this.broadcastLobby();
        break;
      }
      case 'in':
        for (const c of msg.cmds) {
          if (c.seq > peer.lastQueued) { peer.queue.push(c); peer.lastQueued = c.seq; }
        }
        // Only a truly absurd backlog (over a second and a half) is trimmed; an
        // ordinary burst after a hiccup is caught up on below, never thrown away.
        if (peer.queue.length > 100) peer.queue.splice(0, peer.queue.length - 30);
        break;
      case 'ping':
        this.tr.send(peerId, { t: 'pong', c: msg.c }, false);
        break;
    }
  }

  private drop(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (!peer.id) return;
    this.roster = this.roster.filter((p) => p.id !== peer.id);
    if (this.match.phase !== 'lobby') this.sim.forfeit(peer.id);
    this.broadcastLobby();
  }

  private broadcast(msg: HostMsg, reliable = true): void {
    for (const [peerId, peer] of this.peers) if (peer.id) this.tr.send(peerId, msg, reliable);
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', players: this.roster, maxPlayers: this.maxPlayers });
  }

  private broadcastMatch(): void {
    this.broadcast({ t: 'match', match: this.match });
  }

  // ------------------------------------------------------------- match flow
  /** Called by the host player from the lobby. */
  start(): void {
    if (this.match.phase !== 'lobby') return;
    this.match = newMatchState();
    this.nextMap();
  }

  private nextMap(): void {
    const m = this.match;
    m.mapNumber++;
    m.round = 0;
    m.roundWins = {};
    m.mapSeed = this.pickSeed() >>> 0;
    this.map = generateMap(m.mapSeed);
    this.mapVersion++;
    this.startRound();
  }

  private startRound(): void {
    const m = this.match;
    m.round++;
    m.phase = 'countdown';
    m.timer = MATCH.countdown;
    m.winner = -1;
    // Fresh simulation each round; the tick counter carries on so snapshot
    // timestamps (and the clients' clocks) stay continuous.
    this.sim = new GameSim(this.map, this.pickSeed() >>> 0, RULES_MATCH, this.sim.tick);
    this.sim.frozen = true;
    // Rotate spawn points every round so nobody keeps the same corner.
    const spawns = this.map.spawns;
    this.roster.forEach((p, i) => {
      this.sim.addPlayer(p.id, p.name, p.color, null, spawns[(i + m.round + m.mapNumber) % spawns.length]).look = p.look;
    });
    for (const peer of this.peers.values()) peer.queue.length = 0;
    this.roundVersion++;
    this.broadcast({ t: 'round', match: m });
  }

  private endRound(): void {
    const m = this.match;
    const alive = this.sim.players.filter((p) => p.alive);
    m.winner = alive.length === 1 ? alive[0].id : -1; // nobody left = draw, the round is replayed
    if (m.winner >= 0) m.roundWins[m.winner] = (m.roundWins[m.winner] ?? 0) + 1;
    for (const p of this.sim.players) {
      const st = (m.stats[p.id] ??= { kills: 0, deaths: 0, rounds: 0 });
      st.kills += p.kills;
      st.deaths += p.deaths;
      if (p.id === m.winner) st.rounds++;
    }
    m.phase = 'roundEnd';
    m.timer = MATCH.roundEndDelay;
    this.broadcastMatch();
  }

  /** The round-end pause is over: next round, next map, or the match is decided. */
  private afterRound(): void {
    const m = this.match;
    const w = m.winner;
    if (this.roster.length === 0) return;
    if (w >= 0 && m.roundWins[w] >= MATCH.roundsPerMap) {
      m.mapWins[w] = (m.mapWins[w] ?? 0) + 1;
      const won = m.mapWins[w] >= MATCH.mapsToWin;
      m.phase = won ? 'matchEnd' : 'mapEnd';
      m.timer = won ? MATCH.matchEndDelay : MATCH.mapEndDelay;
      this.broadcastMatch();
    } else {
      this.startRound();
    }
  }

  // ------------------------------------------------------------------ tick
  update(dt: number, input: InputSource): number {
    this.acc += Math.min(dt, 0.5);
    let n = 0;
    while (this.acc >= DT && n++ < 30) {
      this.acc -= DT;
      this.tick(input.sample());
    }
    if (this.acc >= DT) this.acc = 0;

    const now = this.clock();
    for (const [peerId, peer] of this.peers) {
      if (now - peer.heard > NET.timeoutMs) this.drop(peerId); // vanished without saying goodbye
    }
    return this.acc / DT;
  }

  private tick(localCmd: InputCmd): void {
    const m = this.match;
    if (m.phase === 'lobby') return;

    if (m.phase !== 'playing' && (m.timer -= DT) <= 0) {
      switch (m.phase) {
        case 'countdown':
          m.phase = 'playing';
          this.sim.frozen = false;
          this.broadcastMatch();
          break;
        case 'roundEnd': this.afterRound(); break;
        case 'mapEnd': this.nextMap(); break;
        case 'matchEnd':
          this.match = newMatchState();
          this.broadcastMatch();
          return;
      }
    }

    const sim = this.sim;
    sim.setInput(this.localId, localCmd);
    for (const peer of this.peers.values()) {
      if (!peer.id) continue;
      // Each remote player advances by exactly the inputs they sent. Dropping
      // inputs, or moving someone along their last input while none have
      // arrived, both make the host disagree with what that player predicted,
      // which they see as being teleported.
      //   nothing queued -> they wait this tick
      //   small backlog  -> run two per tick until it is gone
      //   big backlog    -> run four per tick (their machine or the network stalled)
      const n = peer.queue.length;
      const cmds = peer.queue.splice(0, n > 12 ? 4 : n >= 3 ? 2 : 1);
      if (cmds.length) { peer.last = cmds[cmds.length - 1]; peer.ack = peer.last.seq; }
      const p = sim.getPlayer(peer.id);
      if (p) { p.cmd = peer.last; p.batch = cmds; }
    }
    sim.step();

    if (this.match.phase === 'playing') {
      const alive = sim.players.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
      // Normal rule: last one standing. Solo (testing alone): until you die.
      if (sim.players.length > 1 ? alive <= 1 : alive === 0) this.endRound();
    }

    if (sim.events.length) {
      this.broadcast({ t: 'ev', ev: sim.events.slice() });
      this.events.push(...sim.events);
      sim.events.length = 0;
    }
    if (sim.tick % NET.snapshotEvery === 0) this.sendSnapshots();
  }

  private sendSnapshots(): void {
    const sim = this.sim;
    const base: Snapshot = {
      t: 'snap', tick: sim.tick, ack: -1, me: null,
      pl: sim.players.map((p) => ({
        i: p.id, x: r3(p.pos.x), y: r3(p.pos.y), z: r3(p.pos.z), a: r3(p.yaw), b: r3(p.pitch),
        f: (p.alive ? FLAG_ALIVE : 0) | (p.crouched ? FLAG_CROUCHED : 0) | (p.sliding ? FLAG_SLIDING : 0) | (p.grounded ? FLAG_GROUNDED : 0),
        w: (isDual(p) ? p.weapons[0] : p.weapons[p.active])?.type ?? null,
        d: isDual(p) ? p.weapons[1]!.type : null,
        s: r3(Math.hypot(p.vel.x, p.vel.z)),
      })),
      pk: sim.pickups.map((k) => ({
        i: k.id, w: k.weapon.type, n: k.weapon.ammo, x: r3(k.pos.x), y: r3(k.pos.y), z: r3(k.pos.z), r: k.resting ? 1 : 0,
      })),
      pr: sim.projectiles.map((q) => ({
        i: q.id, k: q.kind, s: q.gen === 2 ? 2 : q.stuck ? 1 : 0, x: r3(q.pos.x), y: r3(q.pos.y), z: r3(q.pos.z), vx: r3(q.vel.x), vy: r3(q.vel.y), vz: r3(q.vel.z),
      })),
      zr: sim.zone ? r3(sim.zone.radius) : 0,
    };
    for (const [peerId, peer] of this.peers) {
      if (!peer.id) continue;
      const p = sim.getPlayer(peer.id);
      this.tr.send(peerId, { ...base, ack: peer.ack, me: p ? meBlock(p) : null }, false);
    }
  }

  dispose(): void {
    this.tr.close();
  }
}

/** Full-precision own state: prediction replays from exactly these numbers. */
function meBlock(p: Player): SnapMe {
  return {
    p: [p.pos.x, p.pos.y, p.pos.z], v: [p.vel.x, p.vel.y, p.vel.z],
    cr: p.crouched, sl: p.sliding, sb: p.slideBoostTimer, wl: p.wallJumpsLeft, wt: p.wallJumpTimer, tt: p.teleTimer, gt: p.groundTime, lt: p.launchTimer,
    st: p.stun, rt: p.rooted, pb: p.prevButtons, hp: p.health, al: p.alive,
    w: p.weapons.map((w) => (w ? [w.type, w.ammo] : null)), ac: p.active, np: p.nearPickup,
  };
}
