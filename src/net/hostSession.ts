import { BOTS, BOT_LEVELS, BOT_NAMES, type BotLevel } from '../config/bots';
import { MOVE } from '../config/movement';
import { DT, MATCH, NET, PLAYER_COLORS, RULES_MATCH, RULES_PARKOUR } from '../config/game';
import { cleanLook } from '../config/looks';
import { WEAPONS } from '../config/weapons';
import { generateMap, pickMapSize } from '../maps/generator';
import { COURSES } from '../maps/parkour';
import { CUSTOM_MAPS } from '../maps/custom';
import { RACE, awardPoints, fellOff, raceCourse, raceCourses, touching } from '../sim/race';
import { GameSim, isDual } from '../sim/game';
import type { MapDef } from '../sim/map';
import { newMatchState, type GameMode, type MatchState, type RosterPlayer } from '../sim/match';
import { emptyCmd, type InputCmd, type Player, type SimEvent } from '../sim/types';
import {
  FLAG_AIMING, FLAG_ALIVE, FLAG_BEAM, FLAG_BEAM_HURT, FLAG_SHOUT, FLAG_BLEEDING, FLAG_CROUCHED, FLAG_GROUNDED, FLAG_HELD, FLAG_JET, FLAG_MIRROR, FLAG_WALLRUN, FLAG_BROOM, FLAG_BIKE, FLAG_WHEELIE, FLAG_TUMBLE, FLAG_SLIDING, FLAG_SOAKED,
  type ClientMsg, type HostMsg, type SnapMe, type Snapshot, type VoiceLink, validVoiceSignal,
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

/** A secret for each seat: whoever shows it again gets the seat back. */
function newToken(): string {
  const b = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
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
  /** Public rooms are listed under JOIN ROOM; private ones are only reached with the code. */
  isPublic = true;
  /** What the room plays, picked by the host in the lobby: a battle, or a PARKOUR race over one course or 'all'. */
  mode: GameMode = 'battle';
  course = 'all';
  /** BATTLE: how well the room's bots play (all of them alike). How many there are is the roster's bot seats. */
  botLevel: BotLevel = BOTS.defaultLevel;
  mapVersion = 1;
  roundVersion = 1;
  ended: string | null = null;
  map: MapDef;
  sim: GameSim;

  /** The host's own voice handshakes: sent straight to the peer; signals addressed to the host land in onSignal. */
  readonly voice: VoiceLink = {
    send: (to, d) => {
      for (const [peerId, peer] of this.peers) if (peer.id === to) this.tr.send(peerId, { t: 'vsig', from: this.localId, d }, true);
    },
    onSignal: () => {},
  };

  private peers = new Map<string, Peer>();
  /** Every remote player's seat: their rejoin token, and since when they have been away (0 = connected). */
  private seats = new Map<number, { token: string; awaySince: number }>();
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
  /** The host picks what the room plays (lobby only). */
  setMode(mode: GameMode, course: string): void {
    if (this.match.phase !== 'lobby') return;
    this.mode = mode === 'parkour' ? 'parkour' : 'battle';
    this.course = course === 'all' || COURSES.some((c) => c.id === course) ? course : 'all';
    if (this.mode === 'parkour') this.roster = this.roster.filter((p) => !p.bot); // bots fight; they do not race
    this.broadcastLobby();
  }

  /** People in the room (not bots). */
  get humans(): number { return this.roster.filter((p) => !p.bot).length; }
  get bots(): number { return this.roster.length - this.humans; }

  /** A smaller room: bots make way first; it never shrinks below the people already in it. */
  setMaxPlayers(n: number): void {
    this.maxPlayers = Math.max(2, Math.min(PLAYER_COLORS.length, Math.max(n, this.humans)));
    while (this.roster.length > this.maxPlayers && this.removeBot());
    this.broadcastLobby();
  }

  /**
   * BATTLE, in the lobby: how many bots fill seats, and how well they all play.
   * Bots count towards the room's size, so there are never more than the free seats.
   */
  setBots(count: number, level: BotLevel): void {
    if (this.match.phase !== 'lobby' || this.mode !== 'battle') return;
    if (BOT_LEVELS.includes(level)) this.botLevel = level;
    const want = Math.max(0, Math.min(Math.floor(count) || 0, this.maxPlayers - this.humans));
    while (this.bots > want && this.removeBot());
    while (this.bots < want) this.addBot();
    for (const p of this.roster) if (p.bot) p.bot = this.botLevel;
    this.broadcastLobby();
  }

  private addBot(): void {
    const used = new Set(this.roster.map((p) => p.color));
    const names = new Set(this.roster.map((p) => p.name));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const name = BOT_NAMES.map((n) => `BOT ${n}`).find((n) => !names.has(n)) ?? `BOT ${this.nextId}`;
    const look = [this.nextId % 12, (this.nextId * 7 + 3) % 12, (this.nextId * 5 + 1) % 12];
    this.roster.push({ id: this.nextId++, name, color, look: cleanLook(look), bot: this.botLevel });
  }

  /** Take the newest bot out of the room. False if there is none. */
  private removeBot(): boolean {
    const i = this.roster.map((p) => !!p.bot).lastIndexOf(true);
    if (i < 0) return false;
    this.roster.splice(i, 1);
    return true;
  }

  private onMessage(peerId: string, msg: ClientMsg): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.heard = this.clock();
    switch (msg.t) {
      case 'hello': {
        if (peer.id) return;
        // Coming back with a token: the same seat, the same player.
        const token = typeof msg.rejoin === 'string' ? msg.rejoin : '';
        const seat = token ? [...this.seats].find(([, s]) => s.token === token) : undefined;
        if (seat && this.roster.some((p) => p.id === seat[0])) {
          this.reseat(peerId, peer, seat[0]);
          break;
        }
        // Anyone else is welcome while there is room, match in progress or not.
        // A full room in the lobby: a bot gives up its seat to a person.
        if (this.roster.length >= this.maxPlayers && this.match.phase === 'lobby') this.removeBot();
        if (this.roster.length >= this.maxPlayers) { this.tr.send(peerId, { t: 'reject', reason: 'That room is full.' }, true); return; }
        peer.id = this.nextId++;
        const used = new Set(this.roster.map((p) => p.color));
        const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
        const name = String(msg.name).replace(/[<>&"]/g, '').trim().slice(0, 14) || 'PLAYER';
        this.roster.push({ id: peer.id, name, color, look: cleanLook(msg.look) }); // never trust what arrives
        const seatToken = newToken();
        this.seats.set(peer.id, { token: seatToken, awaySince: 0 });
        this.tr.send(peerId, { t: 'welcome', id: peer.id, code: this.code, token: seatToken }, true);
        this.broadcastLobby();
        this.catchUp(peerId); // joining a match in progress: watch, and play from the next round...
        this.joinRace(peer.id); // ...unless it is a parkour race: then you run now, from the start
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
      case 'vsig': {
        // Relay a voice handshake. The sender is stamped here, never taken from the message.
        if (!peer.id || !validVoiceSignal(msg.d) || msg.to === peer.id) return;
        if (msg.to === this.localId) { this.voice.onSignal(peer.id, msg.d); return; }
        for (const [otherId, other] of this.peers) {
          if (other.id === msg.to) this.tr.send(otherId, { t: 'vsig', from: peer.id, d: msg.d }, true);
        }
        break;
      }
    }
  }

  private drop(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    if (!peer.id) return;
    if (this.match.phase === 'lobby') {
      this.unseat(peer.id);
    } else {
      // Mid-match: they are out of this round, but their seat (name, colour,
      // score) waits for them to reconnect.
      const p = this.roster.find((r) => r.id === peer.id);
      if (p) p.away = true;
      const seat = this.seats.get(peer.id);
      if (seat) seat.awaySince = this.clock();
      // A race: off the course (no body left behind to respawn); their progress waits for them.
      if (this.match.race) this.sim.removePlayer(peer.id);
      else this.sim.forfeit(peer.id);
    }
    this.broadcastLobby();
  }

  /** Free a seat for good. */
  private unseat(id: number): void {
    this.roster = this.roster.filter((p) => p.id !== id);
    this.seats.delete(id);
  }

  /** A player is back (a rejoin token): this connection takes over their seat. */
  private reseat(peerId: string, peer: Peer, id: number): void {
    // If the host still had the old connection, it is simply forgotten.
    for (const [otherId, other] of this.peers) if (other.id === id && otherId !== peerId) this.peers.delete(otherId);
    peer.id = id;
    const seat = this.seats.get(id)!;
    seat.awaySince = 0;
    const p = this.roster.find((r) => r.id === id)!;
    p.away = false;
    this.tr.send(peerId, { t: 'welcome', id, code: this.code, token: seat.token }, true);
    this.broadcastLobby();
    this.catchUp(peerId);
    this.joinRace(id); // a parkour race: straight back onto the course, on your last checkpoint
  }

  /**
   * PARKOUR: someone joined (or came back) while a course is being raced: they
   * run it now instead of watching until the next one. A newcomer starts on the
   * start, against the race's clock (they are behind, as late as they came);
   * someone back from a dropped connection goes on from the last checkpoint
   * they reached, their checkpoints and splits as they left them.
   */
  private joinRace(id: number): void {
    const m = this.match, r = m.race;
    if (!r || (m.phase !== 'countdown' && m.phase !== 'playing')) return;
    const who = this.roster.find((p) => p.id === id);
    if (!who || who.away) return;
    const run = (r.runners[id] ??= { cp: 0, finish: null, splits: [] });
    const course = raceCourse(r);
    const cp = run.cp > 0 ? course.map.triggers.find((t) => t.type === 'checkpoint' && t.index === run.cp) : undefined;
    const spawns = this.map.spawns;
    const start = spawns[Math.max(0, this.roster.indexOf(who)) % spawns.length];
    const spawn = cp?.type === 'checkpoint' ? { pos: cp.spawn, yaw: cp.yaw } : start;
    this.sim.removePlayer(id); // (whatever was left of them)
    this.sim.addPlayer(id, who.name, who.color, null, spawn).look = who.look;
    this.broadcastMatch();
  }

  /**
   * Someone arriving mid-match gets the match as it stands (the client builds
   * the map from it). Whether they are in this round or watching it, the
   * snapshots tell them.
   */
  private catchUp(peerId: string): void {
    if (this.match.phase === 'lobby') return;
    this.tr.send(peerId, { t: 'round', match: this.match }, true);
  }

  private broadcast(msg: HostMsg, reliable = true): void {
    for (const [peerId, peer] of this.peers) if (peer.id) this.tr.send(peerId, msg, reliable);
  }

  private broadcastLobby(): void {
    this.broadcast({ t: 'lobby', players: this.roster, maxPlayers: this.maxPlayers, mode: this.mode, course: this.course });
  }

  private broadcastMatch(): void {
    this.broadcast({ t: 'match', match: this.match });
  }

  // ------------------------------------------------------------- match flow
  /**
   * Pause or resume the match (host only, while one is under way). Paused,
   * the simulation is frozen as in a countdown (everyone can still look
   * around), no phase timer runs, and inputs that arrive are dropped so
   * nobody lurches forward when it resumes.
   */
  setPaused(on: boolean): void {
    const m = this.match;
    if (m.phase === 'lobby' || !!m.paused === on) return;
    m.paused = on;
    this.sim.frozen = on || m.phase === 'countdown';
    for (const peer of this.peers.values()) peer.queue.length = 0;
    this.broadcastMatch();
  }

  /** Called by the host player from the lobby. */
  start(): void {
    if (this.match.phase !== 'lobby') return;
    this.match = newMatchState();
    if (this.mode === 'parkour') {
      this.match.mode = 'parkour';
      this.match.race = {
        courses: raceCourses(this.course, COURSES.map((c) => c.id)), index: 0,
        startTick: 0, endTick: 0, runners: {}, points: {},
      };
    }
    this.nextMap();
  }

  private nextMap(): void {
    const m = this.match;
    m.mapNumber++;
    m.round = 0;
    m.roundWins = {};
    m.mapSeed = this.pickSeed() >>> 0;
    if (m.race) {
      // PARKOUR: the next course (clients build it from the race state).
      m.mapNumber = m.race.index + 1;
      this.map = raceCourse(m.race).map;
      this.mapVersion++;
      this.startRound();
      return;
    }
    // Now and then a map made in the map lab (each about as likely as a generated one, at most half the time).
    const custom = CUSTOM_MAPS.filter((f) => f.kind === 'battle');
    const pick = custom.length && (m.mapSeed % 1000) / 1000 < Math.min(0.5, custom.length / (custom.length + 4)) ? custom[m.mapSeed % custom.length] : undefined;
    m.mapId = pick?.id;
    if (pick) {
      this.map = pick.map;
      this.mapVersion++;
      this.startRound();
      return;
    }
    // The fewer players, the smaller (on the whole) the map.
    m.mapSize = pickMapSize(m.mapSeed, this.roster.length);
    this.map = generateMap(m.mapSeed, m.mapSize);
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
    this.sim = new GameSim(this.map, this.pickSeed() >>> 0, m.race ? RULES_PARKOUR : RULES_MATCH, this.sim.tick);
    this.sim.frozen = true;
    if (m.race) {
      // PARKOUR: everyone lines up on the start, side by side.
      const r = m.race;
      r.runners = {};
      r.order = undefined;
      r.startTick = r.endTick = 0;
      this.roster.filter((p) => !p.away && !p.bot).slice(0, this.map.spawns.length).forEach((p, i) => {
        this.sim.addPlayer(p.id, p.name, p.color, null, this.map.spawns[i]).look = p.look;
        r.runners[p.id] = { cp: 0, finish: null, splits: [] };
      });
      for (const peer of this.peers.values()) peer.queue.length = 0;
      this.roundVersion++;
      this.broadcast({ t: 'round', match: m });
      return;
    }
    // Rotate spawn points every round so nobody keeps the same corner. Players
    // who are away sit it out; if someone joined mid-map and there are more
    // players than this map has spawns, the latest arrivals watch until the
    // next map (which is sized for everyone).
    // People get the spawns before bots do.
    const spawns = this.map.spawns;
    const playing = [...this.roster.filter((p) => !p.away && !p.bot), ...this.roster.filter((p) => p.bot)];
    playing.slice(0, spawns.length).forEach((p, i) => {
      this.sim.addPlayer(p.id, p.name, p.color, null, spawns[(i + m.round + m.mapNumber) % spawns.length]).look = p.look;
      if (p.bot) this.sim.makeBot(p.id, p.bot);
    });
    for (const peer of this.peers.values()) peer.queue.length = 0;
    this.roundVersion++;
    this.broadcast({ t: 'round', match: m });
  }

  /**
   * PARKOUR, every tick of a course: falls put runners back on their last
   * checkpoint, checkpoints and the finish are counted, and the course closes
   * when everyone is through or time is up.
   */
  private raceStep(): void {
    const m = this.match, r = m.race!, sim = this.sim;
    const course = raceCourse(r);
    let changed = false;
    for (const p of sim.players) {
      const run = r.runners[p.id];
      if (!run || !p.alive) continue;
      const off = fellOff(course, p, (p.spawn ?? this.map.spawns[0]).pos.y, sim.world);
      if (off === 'die') { sim.killByFall(p); continue; } // (back on their checkpoint shortly, by the rules)
      if (off === 'back') { sim.respawn(p); continue; } // p.spawn is their last checkpoint
      for (const t of course.map.triggers) {
        if (t.type === 'checkpoint' && t.index > run.cp && run.finish === null && touching(p, t)) {
          run.cp = t.index;
          run.splits[t.index - 1] = sim.tick - r.startTick;
          p.spawn = { pos: t.spawn, yaw: t.yaw };
          changed = true;
        } else if (t.type === 'finish' && run.finish === null && touching(p, t)) {
          run.finish = sim.tick - r.startTick;
          // The first one home: the others have RACE.afterFirst seconds more.
          if (!Object.values(r.runners).some((x) => x !== run && x.finish !== null)) {
            r.endTick = Math.min(r.endTick, sim.tick + Math.round(RACE.afterFirst / DT));
          }
          changed = true;
        }
      }
    }
    if (changed) this.broadcastMatch();
    const racing = sim.players.filter((p) => r.runners[p.id] && !this.roster.find((x) => x.id === p.id)?.away);
    if (racing.every((p) => r.runners[p.id].finish !== null) || sim.tick >= r.endTick) this.endRace();
  }

  /** PARKOUR: the course is over. Points by place; the results stay up a while. */
  private endRace(): void {
    const m = this.match, r = m.race!;
    const order = awardPoints(r, this.sim.players.map((p) => p.id));
    m.winner = order.length && r.runners[order[0]]?.finish !== null ? order[0] : -1;
    for (const p of this.sim.players) {
      const st = (m.stats[p.id] ??= { kills: 0, deaths: 0, rounds: 0 });
      st.kills += p.kills;
      st.deaths += p.deaths;
      if (p.id === m.winner) st.rounds++;
    }
    m.phase = 'roundEnd';
    m.timer = RACE.resultsDelay;
    this.broadcastMatch();
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
    if (m.race) {
      // PARKOUR: the next course, or the race is over: most points wins.
      const r = m.race;
      if (r.index + 1 < r.courses.length) {
        r.index++;
        this.nextMap();
        return;
      }
      const best = [...this.roster].sort((a, b) => (r.points[b.id] ?? 0) - (r.points[a.id] ?? 0))[0];
      m.winner = best && (r.points[best.id] ?? 0) > 0 ? best.id : -1;
      m.phase = 'matchEnd';
      m.timer = RACE.finalDelay;
      this.broadcastMatch();
      return;
    }
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
    // Seats held too long are given up.
    let freed = false;
    for (const [id, seat] of this.seats) {
      if (seat.awaySince && now - seat.awaySince > MATCH.rejoinGrace * 1000) { this.unseat(id); freed = true; }
    }
    if (freed) this.broadcastLobby();
    return this.acc / DT;
  }

  private tick(localCmd: InputCmd): void {
    const m = this.match;
    if (m.phase === 'lobby') return;
    if (m.paused) {
      // Frozen: time stands still for the match. Looking around still works (sim.frozen).
      for (const peer of this.peers.values()) peer.queue.length = 0;
      this.sim.setInput(this.localId, localCmd);
      this.sim.step();
      if (this.sim.tick % NET.snapshotEvery === 0) this.sendSnapshots();
      return;
    }

    if (m.phase !== 'playing' && (m.timer -= DT) <= 0) {
      switch (m.phase) {
        case 'countdown':
          m.phase = 'playing';
          this.sim.frozen = false;
          if (m.race) { // the clock starts now
            m.race.startTick = this.sim.tick;
            m.race.endTick = this.sim.tick + Math.round(RACE.limit / DT);
          }
          this.broadcastMatch();
          break;
        case 'roundEnd': this.afterRound(); break;
        case 'mapEnd': this.nextMap(); break;
        case 'matchEnd':
          this.match = newMatchState();
          for (const p of this.roster.filter((r) => r.away)) this.unseat(p.id); // the match they were holding a seat in is over
          this.broadcastLobby();
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

    if (this.match.phase === 'playing' && this.match.race) this.raceStep();
    else if (this.match.phase === 'playing') {
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
        f: (p.alive ? FLAG_ALIVE : 0) | (p.crouched ? FLAG_CROUCHED : 0) | (p.sliding ? FLAG_SLIDING : 0) | (p.grounded ? FLAG_GROUNDED : 0) | (p.aiming ? FLAG_AIMING : 0)
          | (p.bleed > 0 ? FLAG_BLEEDING : 0) | (p.soaked > 0 ? FLAG_SOAKED : 0) | (p.heldBy >= 0 ? FLAG_HELD : 0) | (p.beamT > 0 ? FLAG_BEAM : 0)
          | (p.beamHurt ? FLAG_BEAM_HURT : 0) | (p.shoutT > 0 ? FLAG_SHOUT : 0) | (p.jetT > 0 && p.jetSpeed > 0 ? FLAG_JET : 0) | (p.mirrorT > 0 ? FLAG_MIRROR : 0) | (p.wallRunning ? FLAG_WALLRUN : 0) | (p.broomT > 0 ? FLAG_BROOM : 0)
          | (p.bikeT > 0 ? FLAG_BIKE : 0) | (p.wheelie ? FLAG_WHEELIE : 0) | (p.tumbleT > 0 ? FLAG_TUMBLE : 0),
        w: (isDual(p) ? p.weapons[0] : p.weapons[p.active])?.type ?? null,
        d: isDual(p) ? p.weapons[1]!.type : null,
        s: r3(Math.hypot(p.vel.x, p.vel.z)),
        h: Math.max(0, Math.round(p.health)),
        ...(p.holding >= 0 ? { g: p.holding } : {}),
        ...(p.kiFireT > 0 ? { k: r3(1 + p.kiPower) } : p.kiCharge > 0 ? { k: r3(p.kiCharge / (WEAPONS.kiblast.ki!.charge)) } : {}),
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
    // Say so first, so nobody sits there trying to reconnect to a room that is gone.
    this.broadcast({ t: 'closing' });
    this.tr.close();
  }
}

/** Full-precision own state: prediction replays from exactly these numbers. */
function meBlock(p: Player): SnapMe {
  return {
    p: [p.pos.x, p.pos.y, p.pos.z], v: [p.vel.x, p.vel.y, p.vel.z],
    cr: p.crouched, sl: p.sliding, sb: p.slideBoostTimer, wl: p.wallJumpsLeft, wt: p.wallJumpTimer, tt: p.teleTimer, gt: p.groundTime, lt: p.launchTimer,
    st: p.stun, sk: p.soaked, bl: p.bleed, rt: p.rooted, pb: p.prevButtons, hp: p.health, al: p.alive,
    w: p.weapons.map((w) => (w ? [w.type, w.ammo] : null)), ac: p.active, np: p.nearPickup,
    ...(p.heldBy >= 0 ? { hb: p.heldBy } : {}), ...(p.holding >= 0 ? { ho: p.holding } : {}),
    ...(p.kiCharge > 0 || p.kiFireT > 0 ? { ki: [p.kiCharge, p.kiFireT, p.kiPower, p.kiDir.x, p.kiDir.y, p.kiDir.z] as [number, number, number, number, number, number] } : {}),
    ...(p.wallRunning || p.wallRunCd > 0 || p.wallRunsLeft !== MOVE.wallRunMax
      ? { wr: [p.wallRunT, p.wallRunsLeft, p.wallRunCd, p.wallRunning ? 1 : 0] as [number, number, number, number] } : {}),
    ...(p.specialT > 0 || p.specialCd > 0 ? { sp: [p.specialT, p.specialCd, p.specialDir.x, p.specialDir.z] as [number, number, number, number] } : {}),
    ...(p.broomT > 0 || p.broomGlide > 0 ? { bm: [p.broomT, p.broomGlide] as [number, number] } : {}),
    ...(p.bikeT > 0 ? { bk: p.bikeT } : {}),
    ...(p.tumbleT > 0 ? { tb: p.tumbleT } : {}),
    ...(p.jetT > 0 ? { jt: p.jetT, jd: [p.jetDir.x, p.jetDir.y, p.jetDir.z] as [number, number, number], js: p.jetSpeed } : {}),
  };
}
