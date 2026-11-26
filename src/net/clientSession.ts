import { MOVE } from '../config/movement';
import { DT, MATCH, NET } from '../config/game';
import { vcopy, vset, v3 } from '../core/vec';
import { generateMap } from '../maps/generator';
import { CUSTOM_MAPS } from '../maps/custom';
import { raceCourse } from '../sim/race';
import { isAiming, makePlayer } from '../sim/game';
import { WEAPONS } from '../config/weapons';
import { BTN } from '../sim/types';
import { playSolids, type MapDef } from '../sim/map';
import { newMatchState, type GameMode, type MatchState, type RosterPlayer } from '../sim/match';
import { pmove } from '../sim/pmove';
import type { InputCmd, Pickup, Player, Projectile, SimEvent, Zone } from '../sim/types';
import { World } from '../sim/world';
import {
  FLAG_AIMING, FLAG_ALIVE, FLAG_BEAM, FLAG_BEAM_HURT, FLAG_SHOUT, FLAG_BLEEDING, FLAG_CROUCHED, FLAG_GROUNDED, FLAG_HELD, FLAG_JET, FLAG_MIRROR, FLAG_WALLRUN, FLAG_BROOM, FLAG_BIKE, FLAG_WHEELIE, FLAG_TUMBLE, FLAG_SLIDING, FLAG_SOAKED,
  type HostMsg, type SnapPlayer, type Snapshot, type VoiceLink, validVoiceSignal,
} from './protocol';
import type { InputSource, Session, SimView } from './session';
import type { ClientTransport } from './transport';

interface StoredSnap {
  tick: number;
  pl: Map<number, SnapPlayer>;
  snap: Snapshot;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/**
 * A non-host player. It never decides anything about the game; it:
 *  - PREDICTS its own movement by running the same pmove as the host on its
 *    inputs immediately, then corrects itself when the host's answer arrives
 *    (rewind to the acknowledged state, replay the inputs not yet acknowledged);
 *  - INTERPOLATES everything else between the two snapshots around
 *    "now minus 100 ms", so other players move smoothly despite 30 Hz updates;
 *  - tells the host which moment it was looking at (viewTick) so hits can be
 *    judged against what this player actually saw.
 */
export class ClientSession implements Session, SimView {
  readonly kind = 'client' as const;
  readonly events: SimEvent[] = [];
  localId = -1;
  code = '';
  match: MatchState = newMatchState();
  roster: RosterPlayer[] = [];
  maxPlayers: number = MATCH.maxPlayers;
  ping = 0;
  mapVersion = 1;
  roundVersion = 1;
  ended: string | null = null;
  /** Shown again to get our seat back if the connection drops (from the host's welcome). */
  token = '';
  /** The host closed the room on purpose: there is nothing to reconnect to. */
  hostLeft = false;
  /** In the room but not in this round (joined mid-round, or more players than spawns): watching. */
  waiting = false;
  map: MapDef = generateMap(1);
  /** What the host has picked to play (from the lobby). */
  mode: GameMode = 'battle';
  course = 'all';
  /** Which map `map` is: a seed, or a parkour course. */
  private mapKey = 'seed:1';

  readonly voice: VoiceLink = {
    send: (to, d) => this.tr.send({ t: 'vsig', to, d }, true),
    onSignal: () => {},
  };

  // --- SimView (what gets drawn) ---
  players: Player[] = [];
  pickups: Pickup[] = [];
  projectiles: Projectile[] = [];
  zone: Zone | null = null;

  private world = new World(playSolids(this.map), this.map.triggers);
  private me = makePlayer(-1, '', 0); // drawn local player (prediction + error smoothing)
  private pred = makePlayer(-1, '', 0); // raw predicted movement state
  private shown = v3(); // where `me` was drawn last tick
  private err = v3(); // visual offset left over from the last correction, decays to zero
  private pending: InputCmd[] = []; // inputs sent but not yet acknowledged
  /**
   * Host tick at which our newest input will be simulated. Moving platforms
   * depend on the tick, so prediction has to run each input at the tick the
   * host will run it. A snapshot for tick T acknowledging input A tells us
   * exactly that: the inputs after A run at T+1, T+2, ...
   */
  private predTick = 0;
  private recent: InputCmd[] = [];
  private snaps: StoredSnap[] = [];
  private offset = NaN; // server tick minus local tick clock
  private renderTick = 0;
  private remote = new Map<number, Player>();
  private pkViews = new Map<number, Pickup>();
  private prViews = new Map<number, Projectile>();
  private acc = 0;
  private lastPing = 0;
  private heard: number;

  private constructor(private tr: ClientTransport, private clock: () => number) {
    this.heard = clock();
    tr.onMessage = (m) => this.onMessage(m);
    tr.onClose = (reason) => { this.ended ??= reason; };
  }

  /** Say hello and wait for the host to let us in. */
  static join(
    tr: ClientTransport, name: string, clock: () => number = () => performance.now(), look: number[] = [0, 0, 0],
    /** A token from an earlier welcome in this room: asks for that seat back. */
    rejoin = '',
  ): Promise<ClientSession> {
    return new Promise((resolve, reject) => {
      const s = new ClientSession(tr, clock);
      const timer = setTimeout(() => { tr.close(); reject(new Error('The host did not answer.')); }, 8000);
      tr.onMessage = (m) => {
        if (m.t === 'welcome') {
          clearTimeout(timer);
          s.localId = s.me.id = s.pred.id = m.id;
          s.code = m.code;
          s.token = m.token ?? '';
          tr.onMessage = (x) => s.onMessage(x);
          resolve(s);
        } else if (m.t === 'reject') {
          clearTimeout(timer);
          tr.close();
          reject(new Error(m.reason));
        } else s.onMessage(m);
      };
      tr.send({ t: 'hello', name, look, ...(rejoin ? { rejoin } : {}) }, true);
    });
  }

  get view(): SimView { return this; }
  getPlayer(id: number): Player | undefined {
    return id === this.localId ? this.me : this.remote.get(id);
  }

  // ---------------------------------------------------------------- messages
  private onMessage(m: HostMsg): void {
    this.heard = this.clock();
    switch (m.t) {
      case 'lobby':
        this.roster = m.players;
        this.maxPlayers = m.maxPlayers;
        this.mode = m.mode === 'parkour' ? 'parkour' : 'battle';
        this.course = typeof m.course === 'string' ? m.course : 'all';
        break;
      case 'round':
        const r = m.match.race;
        const custom = !r && m.match.mapId ? CUSTOM_MAPS.find((f) => f.id === m.match.mapId) : undefined; // (one we do not have: generated from the seed instead)
        const key = r ? `course:${r.courses[r.index]}` : custom ? `custom:${custom.id}` : `seed:${m.match.mapSeed}:${m.match.mapSize}`;
        if (key !== this.mapKey || this.match.phase === 'lobby') {
          this.mapKey = key;
          // PARKOUR: the course, built here exactly as the host built it. Otherwise
          // the same seed, size and code: a map identical to the host's.
          this.map = r ? raceCourse(r).map : custom ? custom.map : generateMap(m.match.mapSeed, m.match.mapSize ?? 16);
          this.world = new World(playSolids(this.map), this.map.triggers);
          this.mapVersion++;
        }
        this.match = m.match;
        this.roundVersion++;
        this.pending.length = 0;
        this.snaps.length = 0;
        this.err = v3();
        break;
      case 'match':
        this.match = m.match;
        break;
      case 'closing':
        this.hostLeft = true;
        this.ended ??= 'The host closed the room';
        break;
      case 'ev':
        this.events.push(...m.ev);
        break;
      case 'pong':
        this.ping = Math.round(this.clock() - m.c);
        break;
      case 'snap':
        this.onSnapshot(m);
        break;
      case 'vsig':
        if (validVoiceSignal(m.d)) this.voice.onSignal(m.from, m.d);
        break;
    }
  }

  /** Held in someone's beam, we are wherever the host says: nothing to predict. */
  private canMove(): boolean {
    return this.me.alive && this.me.heldBy < 0 && !this.match.paused && this.match.phase !== 'countdown' && this.match.phase !== 'lobby';
  }

  private simulate(cmd: InputCmd, tick: number): void {
    const p = this.pred;
    p.stun = Math.max(0, p.stun - DT); // same order as GameSim.step
    p.soaked = Math.max(0, p.soaked - DT);
    pmove(p, cmd, this.world, DT, tick);
    p.prevButtons = cmd.buttons;
  }

  /** Tick the movers are drawn at: the one our own feet are predicted at. */
  get worldTick(): number {
    return this.canMove() ? this.predTick : Math.round(this.clock() * 0.06 + (Number.isNaN(this.offset) ? 0 : this.offset));
  }

  private onSnapshot(s: Snapshot): void {
    const last = this.snaps[this.snaps.length - 1];
    if (last && s.tick <= last.tick) return; // late or duplicate: newer data already in
    this.snaps.push({ tick: s.tick, pl: new Map(s.pl.map((p) => [p.i, p])), snap: s });
    if (this.snaps.length > 40) this.snaps.shift();

    // Track the host's clock from arrival times. Jitter is smoothed; a real
    // jump (stall, new round) snaps straight to the new value.
    const measured = s.tick - this.clock() * 0.06;
    this.offset = Number.isNaN(this.offset) || Math.abs(measured - this.offset) > 12
      ? measured : this.offset + (measured - this.offset) * 0.1;

    const m = s.me;
    // Not in this round (we joined while it was on): watch, and do not predict a body we do not have.
    this.waiting = !m;
    if (!m) {
      this.me.alive = this.pred.alive = false;
      this.pending.length = 0;
      return;
    }
    const me = this.me, pred = this.pred;
    const wasAlive = me.alive;
    me.alive = pred.alive = m.al;
    me.health = m.hp;
    me.weapons = m.w.map((w) => (w ? { type: w[0], ammo: w[1] } : null));
    me.active = m.ac;
    me.nearPickup = m.np;
    me.heldBy = pred.heldBy = m.hb ?? -1;
    // Prediction needs our weapons too: the JETHAMMER and AFTERBURN move us. It
    // shares the very same objects, so predicted fuel use shows on the HUD.
    pred.weapons = me.weapons;
    pred.active = me.active;
    pred.jetT = m.jt ?? 0;
    if (m.jd) pred.jetDir = v3(m.jd[0], m.jd[1], m.jd[2]);
    pred.jetSpeed = m.js ?? 0;
    pred.broomT = m.bm?.[0] ?? 0; // SKYSWEEPER: flying is predicted like running
    pred.broomGlide = m.bm?.[1] ?? 0;
    pred.bikeT = m.bk ?? 0;
    pred.tumbleT = m.tb ?? 0; // SLABRIDER: riding too (the wheelie follows from our own jump key)
    // KI BLAST: the beam (and its direction) as the host has it; our own charge we track ourselves (tick).
    me.kiFireT = m.ki?.[1] ?? 0;
    me.kiPower = m.ki?.[2] ?? 0;
    if (m.ki) me.kiDir = v3(m.ki[3], m.ki[4], m.ki[5]);
    if (!m.ki) me.kiCharge = 0;
    pred.wallRunT = m.wr?.[0] ?? 0;
    pred.wallRunsLeft = m.wr?.[1] ?? MOVE.wallRunMax;
    pred.wallRunCd = m.wr?.[2] ?? 0;
    pred.wallRunning = m.wr?.[3] === 1;
    pred.specialT = m.sp?.[0] ?? 0;
    pred.specialCd = m.sp?.[1] ?? 0;
    if (m.sp) pred.specialDir = v3(m.sp[2], 0, m.sp[3]);
    me.holding = m.ho ?? -1;

    // --- reconciliation ---
    const before = vcopy(pred.pos);
    pred.pos = v3(m.p[0], m.p[1], m.p[2]);
    pred.vel = v3(m.v[0], m.v[1], m.v[2]);
    pred.crouched = m.cr;
    pred.sliding = m.sl;
    pred.slideBoostTimer = m.sb;
    pred.wallJumpsLeft = m.wl;
    pred.wallJumpTimer = m.wt;
    pred.teleTimer = m.tt;
    pred.groundTime = m.gt;
    pred.launchTimer = m.lt;
    pred.rooted = m.rt;
    pred.stun = m.st;
    pred.soaked = m.sk ?? 0;
    me.soaked = pred.soaked;
    me.bleed = m.bl ?? 0;
    pred.prevButtons = m.pb;
    let i = 0;
    while (i < this.pending.length && this.pending[i].seq <= s.ack) i++;
    this.pending.splice(0, i);
    if (this.canMove()) this.pending.forEach((cmd, n) => this.simulate(cmd, s.tick + 1 + n));
    else this.pending.length = 0;
    this.predTick = s.tick + this.pending.length;

    // Whatever the correction moved us by is hidden in `err` and blended out
    // over a few frames, unless it is a teleport (respawn, new round).
    const dx = before.x - pred.pos.x, dy = before.y - pred.pos.y, dz = before.z - pred.pos.z;
    if (!wasAlive || !m.al || Math.hypot(dx, dy, dz) > 3) {
      this.err = v3();
      vset(this.shown, pred.pos);
    } else {
      this.err.x += dx; this.err.y += dy; this.err.z += dz;
    }
  }

  // -------------------------------------------------------------------- tick
  update(dt: number, input: InputSource): number {
    const now = this.clock();
    if (now - this.heard > NET.timeoutMs) this.ended ??= 'Lost connection to the host';
    if (now - this.lastPing > 1000) {
      this.lastPing = now;
      this.tr.send({ t: 'ping', c: now }, false);
    }

    this.acc += Math.min(dt, 0.25);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.tick(input.sample());
    }
    this.interpolate();
    return this.acc / DT;
  }

  private tick(cmd: InputCmd): void {
    cmd.viewTick = this.renderTick;
    this.recent.push(cmd);
    if (this.recent.length > NET.inputRedundancy) this.recent.shift();
    this.tr.send({ t: 'in', cmds: this.recent }, false);

    const me = this.me, pred = this.pred;
    if (this.canMove()) {
      this.pending.push(cmd);
      if (this.pending.length > 120) this.pending.shift(); // host silent for 2 s: stop hoarding
      this.simulate(cmd, ++this.predTick);
    } else if (me.heldBy >= 0 && me.alive) {
      // Carried: keep drifting the way the beam was swinging us until the next snapshot.
      pred.pos = v3(pred.pos.x + pred.vel.x * DT, pred.pos.y + pred.vel.y * DT, pred.pos.z + pred.vel.z * DT);
    }
    this.err.x *= 0.85; this.err.y *= 0.85; this.err.z *= 0.85;

    vset(me.prevPos, this.shown);
    me.pos = v3(pred.pos.x + this.err.x, pred.pos.y + this.err.y, pred.pos.z + this.err.z);
    vset(this.shown, me.pos);
    me.vel = pred.vel;
    me.yaw = cmd.yaw;
    me.pitch = cmd.pitch;
    me.grounded = pred.grounded;
    me.crouched = pred.crouched;
    me.sliding = pred.sliding;
    me.wallRunning = pred.wallRunning;
    me.jetT = pred.jetT;
    me.broomT = pred.broomT;
    me.broomGlide = pred.broomGlide;
    me.bikeT = pred.bikeT;
    me.tumbleT = pred.tumbleT;
    me.wheelie = pred.wheelie;
    me.specialT = pred.specialT; // guarding, winding up: drawn and shown at once
    me.specialCd = pred.specialCd;
    me.jetDir = pred.jetDir;
    me.jetSpeed = pred.jetSpeed;
    me.stun = pred.stun;
    me.aiming = isAiming(me, cmd.buttons); // our own aim never waits for the host
    // Our own beam is drawn the moment we pull the trigger, too.
    const held = me.weapons[me.active];
    me.beamT = me.alive && me.heldBy < 0 && held && WEAPONS[held.type].beam && held.ammo > 0 && cmd.buttons & BTN.FIRE ? 1 : 0;
    // KI BLAST: the orb grows the moment we hold the trigger, not a round trip later.
    const kiCfg = held && held.ammo > 0 ? WEAPONS[held.type].ki : undefined;
    if (kiCfg && me.alive && me.kiFireT <= 0 && cmd.buttons & BTN.FIRE) me.kiCharge = Math.min(kiCfg.charge, me.kiCharge + DT);
    else if (!(cmd.buttons & BTN.FIRE)) me.kiCharge = 0;
    me.mirrorT = me.alive && me.heldBy < 0 && held && WEAPONS[held.type].mirror && held.ammo > 0 && cmd.buttons & BTN.FIRE ? 1 : 0; // and our field
    me.beamHurt = me.beamT > 0 && (cmd.buttons & BTN.FIRE2) !== 0;
    // ...and our megaphone is on the moment we pull it (our voice goes out at once).
    me.shoutT = me.alive && me.heldBy < 0 && held && WEAPONS[held.type].shout && held.ammo > 0 && cmd.buttons & BTN.FIRE ? 1 : 0;
  }

  // ----------------------------------------------------------- interpolation
  private interpolate(): void {
    const snaps = this.snaps;
    if (!snaps.length) return;
    const newest = snaps[snaps.length - 1];
    const rt = Math.min(newest.tick, this.clock() * 0.06 + this.offset - NET.interpDelayTicks);
    this.renderTick = rt;

    // a = last snapshot at or before rt, b = the one after it
    let a = snaps[0], b = snaps[0];
    for (let i = snaps.length - 1; i >= 0; i--) {
      if (snaps[i].tick <= rt) { a = snaps[i]; b = snaps[i + 1] ?? a; break; }
    }
    const t = b.tick > a.tick ? Math.max(0, Math.min(1, (rt - a.tick) / (b.tick - a.tick))) : 0;

    // --- players ---
    const list: Player[] = [];
    const meEntry = this.roster.find((r) => r.id === this.localId);
    if (meEntry) { this.me.name = meEntry.name; this.me.color = meEntry.color; this.me.look = meEntry.look; }
    list.push(this.me);
    for (const pb of b.pl.values()) {
      if (pb.i === this.localId) continue;
      let p = this.remote.get(pb.i);
      if (!p) this.remote.set(pb.i, (p = makePlayer(pb.i, '', 0x888888)));
      const info = this.roster.find((r) => r.id === pb.i);
      if (info) { p.name = info.name; p.color = info.color; p.look = info.look; }
      const pa = a.pl.get(pb.i) ?? pb;
      const jump = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z) > 6; // teleport: do not slide across the map
      const k = jump ? 1 : t;
      p.pos = v3(lerp(pa.x, pb.x, k), lerp(pa.y, pb.y, k), lerp(pa.z, pb.z, k));
      vset(p.prevPos, p.pos);
      p.yaw = lerpAngle(pa.a, pb.a, k);
      p.pitch = lerp(pa.b, pb.b, k);
      const f = pa.f;
      p.alive = (f & FLAG_ALIVE) !== 0;
      p.crouched = (f & FLAG_CROUCHED) !== 0;
      p.sliding = (f & FLAG_SLIDING) !== 0;
      p.grounded = (f & FLAG_GROUNDED) !== 0;
      p.aiming = (f & FLAG_AIMING) !== 0;
      p.bleed = (f & FLAG_BLEEDING) !== 0 ? 1 : 0; // remote players: only "is it happening" is needed, for the drips
      p.soaked = (f & FLAG_SOAKED) !== 0 ? 1 : 0;
      p.beamT = (f & FLAG_BEAM) !== 0 ? 1 : 0;
      p.beamHurt = (f & FLAG_BEAM_HURT) !== 0;
      p.shoutT = (f & FLAG_SHOUT) !== 0 ? 1 : 0;
      p.jetT = p.jetSpeed = (f & FLAG_JET) !== 0 ? 1 : 0;
      p.mirrorT = (f & FLAG_MIRROR) !== 0 ? 1 : 0;
      // KI BLAST: charging (orb size), or the beam out (and how strong).
      const ki = pb.k ?? 0;
      p.kiFireT = ki > 1 ? 1 : 0;
      p.kiPower = ki > 1 ? ki - 1 : 0;
      p.kiCharge = ki > 0 && ki <= 1 ? ki * WEAPONS.kiblast.ki!.charge : 0;
      p.wallRunning = (f & FLAG_WALLRUN) !== 0;
      p.broomT = (f & FLAG_BROOM) !== 0 ? 1 : 0;
      p.bikeT = (f & FLAG_BIKE) !== 0 ? 1 : 0;
      p.wheelie = (f & FLAG_WHEELIE) !== 0;
      p.tumbleT = (f & FLAG_TUMBLE) !== 0 ? 1 : 0;
      p.holding = pa.g ?? -1;
      p.heldBy = -1; // filled in below, from whoever holds them
      p.vel = v3(pa.s, 0, 0);
      p.health = pb.h ?? p.health;
      p.weapons = [pa.w ? { type: pa.w, ammo: 1 } : null, pa.d ? { type: pa.d, ammo: 1 } : null];
      p.active = 0;
      list.push(p);
    }
    for (const id of this.remote.keys()) if (!b.pl.has(id)) this.remote.delete(id);
    for (const p of list) {
      if (p.holding < 0) continue;
      const v = list.find((q) => q.id === p.holding);
      if (v && v !== this.me) v.heldBy = p.id;
    }
    this.players = list;

    // --- pickups ---
    const pks: Pickup[] = [];
    for (const kb of b.snap.pk) {
      const ka = a.snap.pk.find((k) => k.i === kb.i) ?? kb;
      let v = this.pkViews.get(kb.i);
      if (!v) {
        v = {
          id: kb.i, weapon: { type: kb.w, ammo: kb.n }, pos: v3(), prevPos: v3(), vel: v3(),
          resting: true, lethal: false, owner: -1, ownerTimer: 0, age: 0, spawner: -1,
        };
        this.pkViews.set(kb.i, v);
      }
      v.weapon.ammo = kb.n;
      v.resting = ka.r === 1;
      v.pos = v3(lerp(ka.x, kb.x, t), lerp(ka.y, kb.y, t), lerp(ka.z, kb.z, t));
      vset(v.prevPos, v.pos);
      pks.push(v);
    }
    if (this.pkViews.size > pks.length) {
      const alive = new Set(pks.map((p) => p.id));
      for (const id of this.pkViews.keys()) if (!alive.has(id)) this.pkViews.delete(id);
    }
    this.pickups = pks;

    // --- projectiles ---
    const prs: Projectile[] = [];
    for (const qb of b.snap.pr) {
      const qa = a.snap.pr.find((q) => q.i === qb.i) ?? qb;
      let v = this.prViews.get(qb.i);
      if (!v) {
        v = { id: qb.i, kind: qb.k, owner: -1, pos: v3(), prevPos: v3(), vel: v3(), life: 1, stuck: false, arm: 0, gen: 0, attached: -1, timer: 0 };
        this.prViews.set(qb.i, v);
      }
      v.pos = v3(lerp(qa.x, qb.x, t), lerp(qa.y, qb.y, t), lerp(qa.z, qb.z, t));
      vset(v.prevPos, v.pos);
      v.vel = v3(qb.vx, qb.vy, qb.vz);
      v.stuck = qb.s >= 1;
      v.gen = qb.s === 2 ? 2 : 0;
      prs.push(v);
    }
    if (this.prViews.size > prs.length) {
      const alive = new Set(prs.map((p) => p.id));
      for (const id of this.prViews.keys()) if (!alive.has(id)) this.prViews.delete(id);
    }
    this.projectiles = prs;

    const zr = lerp(a.snap.zr, b.snap.zr, t);
    this.zone = a.snap.zr > 0 && b.snap.zr > 0 ? { x: 0, z: 0, radius: zr } : null;
  }

  dispose(): void {
    this.tr.close();
  }
}
