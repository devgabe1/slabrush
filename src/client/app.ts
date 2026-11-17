import * as THREE from 'three';
import { Sfx } from '../audio/sfx';
import { VoiceChat } from '../audio/voice';
import { PLAYER_COLORS } from '../config/game';
import { WEAPONS } from '../config/weapons';
import { generateMap } from '../maps/generator';
import { ClientSession } from '../net/clientSession';
import { HostSession } from '../net/hostSession';
import { peerHost, peerJoin } from '../net/peerTransport';
import { iceServers, randomRoomCode } from '../net/protocol';
import { hashSeed } from '../core/rng';
import { LabSession, OfflineSession, type Session } from '../net/session';
import { localHost, localJoin, type HostTransport } from '../net/transport';
import { GameRenderer, type CamMode } from '../render/gameRenderer';
import { Hud } from './hud';
import { Input } from './input';
import { Menus } from './menus';
import { keyLabel, loadSettings } from './settings';

const D2R = Math.PI / 180;
const STEP_DISTANCE = 2.3; // meters between footstep sounds
/** ?local in the URL: rooms connect between tabs of this browser instead of over WebRTC (development). */
const LOCAL_MODE = new URLSearchParams(location.search).has('local');

/**
 * Glue: owns the main loop and wires input -> session -> renderer/audio/HUD.
 * It does not care whether the session is offline, hosting or a client.
 */
export class App {
  settings = loadSettings();
  sfx = new Sfx();
  renderer: GameRenderer;
  input: Input;
  hud: Hud;
  menus: Menus;
  session: Session | null = null;
  voice: VoiceChat | null = null;
  state: 'menu' | 'lobby' | 'game' = 'menu';

  private alpha = 1;
  private lastUpdate = performance.now();
  private lastFrame = performance.now();
  private mapVersion = -1;
  private roundVersion = -1;
  private lobbySig = '';
  private phase = '';
  private lastCount = -1;
  private connecting = 0; // bumped to cancel an in-flight create/join
  private stepDist = new Map<number, number>();
  private spectateId = -1;
  private dustT = 0;
  private talkHeld = false;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new GameRenderer(canvas);
    this.input = new Input(canvas, this.settings);
    this.hud = new Hud(document.getElementById('hud')!, this.settings);
    this.menus = new Menus(document.getElementById('menu')!, this.settings, {
      onPractice: () => this.startPractice(),
      onLab: (seed) => this.startLab(seed),
      onCreate: () => void this.createRoom(),
      onJoin: (code) => void this.joinRoom(code),
      onStart: () => { if (this.session instanceof HostSession) this.session.start(); },
      onMaxPlayers: (n) => { if (this.session instanceof HostSession) this.session.setMaxPlayers(n); },
      onLeave: () => this.leave(),
      onResume: () => this.input.lock(),
      onQuit: () => this.leave(),
      onSettingsChanged: () => this.applySettings(),
      onClick: () => { this.sfx.unlock(); this.sfx.play('ui'); },
    });
    this.input.onLockChange = (locked) => {
      if (this.state === 'game') this.menus.show(locked ? null : 'pause');
    };
    // Map lab hotkeys.
    document.addEventListener('keydown', (e) => {
      const lab = this.session;
      if (!(lab instanceof LabSession) || !this.input.locked || e.repeat) return;
      if (e.code === 'KeyN') lab.setSeed(lab.seed + 1);
      else if (e.code === 'KeyB') lab.setSeed(lab.seed - 1);
      else if (e.code === 'KeyR') lab.setSeed((Math.random() * 0x100000000) >>> 0);
      else if (e.code === 'KeyV') lab.toggleFly();
    });
    this.listenPushToTalk();
    // Tell the other side right away when the tab closes.
    window.addEventListener('pagehide', () => this.session?.dispose());
    this.applySettings();
    this.showBackdrop();
    this.menus.show('main');
    this.startBackgroundTicker();
    requestAnimationFrame(this.frame);
  }

  /** Behind the menus: a freshly generated map, slowly orbited. A different one every visit. */
  private showBackdrop(): void {
    this.renderer.setMap(generateMap((Math.random() * 0x100000000) >>> 0));
  }

  private applySettings(): void {
    this.renderer.setRetro(this.settings.retro);
    this.renderer.shakeScale = this.settings.shake;
    this.hud.setCrosshair(this.settings.crosshair);
    this.renderer.setRenderScale(this.settings.renderScale);
    this.renderer.setFov(this.settings.fov);
    this.sfx.setVolume(this.settings.volume);
    this.voice?.setMode(this.settings.voice);
    this.voice?.setVolume(this.settings.voiceVolume);
  }

  /**
   * Push to talk works in the lobby too, where the mouse is not captured, so
   * it is tracked here rather than by Input. Typing in a text box never talks.
   */
  private listenPushToTalk(): void {
    const typing = (e: Event) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    };
    const set = (code: string, down: boolean, e: Event) => {
      if (code !== this.settings.keys.talk || (down && typing(e))) return;
      this.talkHeld = down;
    };
    document.addEventListener('keydown', (e) => { if (!e.repeat) set(e.code, true, e); });
    document.addEventListener('keyup', (e) => set(e.code, false, e));
    document.addEventListener('mousedown', (e) => set('Mouse' + e.button, true, e));
    document.addEventListener('mouseup', (e) => set('Mouse' + e.button, false, e));
    window.addEventListener('blur', () => { this.talkHeld = false; });
  }

  /** Each frame: open or close the microphone, place every voice, light up the talk indicators. */
  private updateVoice(s: Session): void {
    const v = this.voice;
    if (!v) return;
    v.setTransmit(v.mode === 'open' || (v.mode === 'ptt' && this.talkHeld));
    const phase = s.match?.phase ?? 'lobby';
    v.update(s.roster.map((p) => p.id), phase, (id) => s.view.getPlayer(id), this.renderer.camera.position);

    const note = v.mode === 'off' ? '' : v.micState === 'asking' ? 'allow the microphone to talk'
      : v.micState === 'blocked' ? 'microphone blocked: listening only' : v.micState === 'unsupported' ? 'no microphone available' : '';
    if (this.state === 'game') {
      const talking = s.roster.filter((p) => p.id !== s.localId && v.isTalking(p.id));
      // Push to talk: lit while held. Open mic: lit only while it actually hears you.
      this.hud.setVoice(talking, v.transmitting && (v.mode === 'ptt' || v.isTalking(s.localId)), note);
    } else if (this.state === 'lobby') {
      for (const li of document.querySelectorAll<HTMLElement>('#menu .roster li[data-pid]')) {
        li.classList.toggle('talking', v.isTalking(Number(li.dataset.pid)));
      }
      const stat = document.querySelector<HTMLElement>('#menu [data-voice]');
      if (stat) {
        const key = keyLabel(this.settings.keys.talk);
        const text = v.mode === 'off' ? 'Voice chat is off (Settings).'
          : note ? `Voice: ${note}.`
          : v.mode === 'ptt' ? `Voice: hold ${key} to talk. In a round only players near you hear you, and the more hurt you are the thinner you sound.`
          : 'Voice: open mic. In a round only players near you hear you, and the more hurt you are the thinner you sound.';
        if (stat.textContent !== text) stat.textContent = text;
      }
    }
  }

  /**
   * Browsers stop requestAnimationFrame in hidden tabs. A host that alt-tabs
   * must keep simulating or everyone freezes, so while hidden a Web Worker
   * timer (which is not throttled the same way) drives the updates instead.
   */
  private startBackgroundTicker(): void {
    try {
      const src = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 16)'], { type: 'text/javascript' }));
      // "No frame for a while" rather than document.hidden: some embedded
      // browsers pause rendering without ever reporting the tab as hidden.
      new Worker(src).onmessage = () => { if (performance.now() - this.lastFrame > 100) this.update(); };
    } catch {
      /* no workers: the game simply pauses in the background */
    }
  }

  // ------------------------------------------------------------ session flow
  private setSession(s: Session): void {
    this.session = s;
    this.voice?.dispose();
    this.voice = null;
    if (s.voice) {
      // ?local tabs reach each other directly; real rooms use the same STUN/TURN servers as the game.
      const ice = LOCAL_MODE ? [] : iceServers(this.settings.turn);
      this.voice = new VoiceChat(s.voice, () => s.localId, () => this.sfx.context, () => this.sfx.output, ice, this.settings.voice);
      this.voice.setVolume(this.settings.voiceVolume);
    }
    this.mapVersion = this.roundVersion = -1;
    this.lobbySig = this.phase = '';
    this.stepDist.clear();
    this.hud.reset();
    this.menus.online = s.kind !== 'offline';
    this.menus.isHost = s.kind === 'host';
    this.menus.lab = s instanceof LabSession;
  }

  startPractice(): void {
    this.setSession(new OfflineSession(this.settings.nickname, PLAYER_COLORS[0], this.settings.look));
    this.enterGame();
  }

  /** Map lab. The seed can be a number, any text (hashed), or empty for a random one. */
  startLab(text: string): void {
    const t = text.trim();
    const seed = !t ? (Math.random() * 0x100000000) >>> 0 : /^\d+$/.test(t) ? Number(t) >>> 0 : hashSeed(t);
    const lab = new LabSession(seed);
    this.setSession(lab);
    this.input.setView(0, -0.6); // looking down at the map from above
    this.enterGame();
  }

  async createRoom(): Promise<void> {
    const token = ++this.connecting;
    this.menus.showBusy('CREATING ROOM…');
    try {
      let tr: HostTransport | null = null;
      for (let attempt = 0; !tr; attempt++) {
        const code = randomRoomCode();
        try {
          tr = await (LOCAL_MODE ? localHost(code) : peerHost(code, iceServers(this.settings.turn)));
        } catch (e) {
          // Code already in use by another room: roll a new one.
          if ((e as { type?: string }).type !== 'unavailable-id' || attempt >= 4) throw e;
        }
      }
      if (token !== this.connecting) { tr.close(); return; }
      this.setSession(new HostSession(tr, this.settings.nickname, undefined, undefined, this.settings.look));
      this.state = 'lobby';
      this.menus.show('lobby');
    } catch (e) {
      if (token === this.connecting) this.menus.showMessage((e as Error).message || 'Could not create the room.');
    }
  }

  async joinRoom(code: string): Promise<void> {
    const token = ++this.connecting;
    this.menus.showBusy(`JOINING ${code}…`);
    try {
      const tr = await (LOCAL_MODE ? localJoin(code) : peerJoin(code, iceServers(this.settings.turn)));
      if (token !== this.connecting) { tr.close(); return; }
      const session = await ClientSession.join(tr, this.settings.nickname, undefined, this.settings.look);
      if (token !== this.connecting) { session.dispose(); return; }
      this.setSession(session);
      this.state = 'lobby';
      this.menus.show('lobby');
    } catch (e) {
      if (token === this.connecting) this.menus.showMessage((e as Error).message || 'Could not join the room.');
    }
  }

  private enterGame(): void {
    this.state = 'game';
    this.hud.show(true);
    // Capturing the mouse needs a click. The host just clicked START; for
    // everyone else the menu stays up with a PLAY button during the countdown.
    this.menus.show('pause');
    this.input.lock();
  }

  /** Leave whatever we are in and go back to the main menu, optionally explaining why. */
  leave(message?: string): void {
    this.connecting++;
    this.session?.dispose();
    this.session = null;
    this.voice?.dispose();
    this.voice = null;
    this.state = 'menu';
    this.input.unlock();
    this.hud.show(false);
    this.showBackdrop();
    if (message) this.menus.showMessage(message);
    else this.menus.show('main');
  }

  // ------------------------------------------------------------------- loop
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    this.update();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const s = this.session;
    if (s) this.updateVoice(s);
    if (!s || this.state !== 'game') {
      this.renderer.setPreview(this.menus.screen === 'character' ? this.settings.look : null, PLAYER_COLORS[0]);
      this.renderer.renderMenu(dt);
      return;
    }
    const me = s.view.getPlayer(s.localId);
    const cam = this.chooseCamera(s);
    this.renderer.render(s.view, s.localId, this.alpha, dt, {
      yaw: this.input.yaw, pitch: this.input.pitch, mouseDX: this.input.swayX, mouseDY: this.input.swayY,
    }, cam);
    this.input.swayX = this.input.swayY = 0;
    this.input.firePressed = false;
    this.hud.setSpectating(cam.mode === 'spectate' ? s.view.getPlayer(cam.target)?.name ?? null : null);
    this.hud.setCinematic(cam.mode === 'orbit');
    this.sfx.setListener(this.renderer.camera.position, this.input.yaw, this.input.pitch);
    if (me) this.hud.update(dt, me, s.view, s.kind !== 'offline');
    const count = this.hud.updateMatch(dt, s, me);
    if (count !== this.lastCount) {
      if (count > 0) this.sfx.play('ui', null, 1.5);
      this.lastCount = count;
    }
  };

  /**
   * Normally your own eyes. Out of the round: watch through another player
   * (fire cycles). Match over: everyone circles the winner.
   */
  private chooseCamera(s: Session): CamMode {
    const m = s.match;
    const me = s.view.getPlayer(s.localId);
    if (m && m.phase === 'matchEnd' && s.view.getPlayer(m.winner)?.alive) return { mode: 'orbit', target: m.winner };
    if (m && me && !me.alive && m.phase !== 'lobby') {
      const alive = s.view.players.filter((p) => p.alive && p.id !== s.localId);
      if (alive.length) {
        let i = alive.findIndex((p) => p.id === this.spectateId);
        if (i < 0) i = 0;
        else if (this.input.firePressed) i = (i + 1) % alive.length;
        this.spectateId = alive[i].id;
        return { mode: 'spectate', target: this.spectateId };
      }
    }
    return { mode: 'first', target: s.localId };
  }

  /** Advance the session. Called every frame, and from the background ticker while the tab is hidden. */
  private update(): void {
    const now = performance.now();
    const dt = (now - this.lastUpdate) / 1000;
    this.lastUpdate = now;
    const s = this.session;
    if (!s) return;
    if (s.ended) {
      this.leave(s.ended);
      return;
    }

    // Offline, the world stops while the menu is open. Online it never stops.
    this.alpha = s.update(dt, this.input, s.kind !== 'offline' || this.input.locked);

    if (s.mapVersion !== this.mapVersion) {
      this.mapVersion = s.mapVersion;
      if (this.state === 'game' || s.kind === 'offline') this.renderer.setMap(s.map);
      if (s instanceof LabSession) this.renderer.setMarkers(s.map.spawns.map((sp) => sp.pos));
    }
    if (s.roundVersion !== this.roundVersion) {
      this.roundVersion = s.roundVersion;
      this.renderer.clearEntities();
    }

    const m = s.match;
    if (m) {
      if (this.state === 'lobby') {
        const sig = JSON.stringify([s.roster, s.maxPlayers]);
        if (sig !== this.lobbySig) {
          this.lobbySig = sig;
          this.menus.setLobby({ code: s.code, players: s.roster, localId: s.localId, isHost: s.kind === 'host', maxPlayers: s.maxPlayers });
        }
        if (m.phase !== 'lobby') {
          this.renderer.setMap(s.map);
          this.enterGame();
        }
      } else if (this.state === 'game' && m.phase === 'lobby') {
        // Match over: everyone is back in the lobby.
        this.state = 'lobby';
        this.lobbySig = '';
        this.input.unlock();
        this.hud.show(false);
        this.hud.reset();
        this.menus.show('lobby');
      }
      if (m.phase !== this.phase) {
        if (m.phase === 'playing') this.sfx.play('respawn', null, 1.4);
        else if (m.phase === 'roundEnd' || m.phase === 'mapEnd' || m.phase === 'matchEnd') this.sfx.play('kill', null, 1.2);
        this.phase = m.phase;
      }
    }

    if (this.state === 'game') {
      this.footsteps(s, dt);
      this.handleEvents(s);
    } else {
      s.events.length = 0;
    }
  }

  private footsteps(s: Session, dt: number): void {
    this.dustT -= dt;
    const dust = this.dustT <= 0;
    if (dust) this.dustT = 0.05;
    for (const p of s.view.players) {
      const speed = Math.hypot(p.vel.x, p.vel.z);
      if (dust && p.alive && p.sliding && p.grounded) this.renderer.fx.puff({ x: p.pos.x, y: p.pos.y + 0.1, z: p.pos.z }, 0xcfc8b8, 0.13);
      if (!p.alive || !p.grounded || p.sliding || speed < 4.5) continue;
      const d = (this.stepDist.get(p.id) ?? 0) + speed * Math.min(dt, 0.1);
      if (d >= STEP_DISTANCE) {
        this.stepDist.set(p.id, 0);
        this.sfx.play('step', p.id === s.localId ? null : p.pos, p.id === s.localId ? 0.7 : 1);
      } else this.stepDist.set(p.id, d);
    }
  }

  /** Turn simulation events into sound, particles and HUD feedback. */
  private handleEvents(s: Session): void {
    const sim = s.view;
    const me = s.localId;
    const { fx } = this.renderer;
    for (const e of s.events) {
      switch (e.t) {
        case 'fire': {
          const local = e.player === me;
          // Other players' gunfire is positional and a little louder than your own, so fights are easy to locate.
          this.sfx.play(e.weapon, local ? null : e.origin, local ? 1 : 1.5);
          if (local) {
            const r = WEAPONS[e.weapon].recoil;
            this.renderer.vm.onFire(e.weapon, e.hand);
            this.input.addRecoil(r.pitch * D2R, (Math.random() - 0.5) * 2 * r.yaw * D2R);
          }
          if (e.weapon === 'toaster') {
            // a tongue of flame: orange puffs along the aim, yellow near the nozzle
            for (let k = 1; k <= 5; k++) {
              fx.puff({ x: e.origin.x + e.dir.x * k * 1.5, y: e.origin.y - 0.25 + e.dir.y * k * 1.5, z: e.origin.z + e.dir.z * k * 1.5 }, k < 3 ? 0xffd23a : 0xff7a1a, 0.14 + k * 0.06);
            }
          }
          if (e.weapon === 'gust') {
            // a visible blast of air
            for (let k = 1; k <= 7; k++) {
              fx.puff({ x: e.origin.x + e.dir.x * k * 1.3, y: e.origin.y - 0.2 + e.dir.y * k * 1.3, z: e.origin.z + e.dir.z * k * 1.3 }, 0xe8eef4, 0.18 + k * 0.07);
            }
          }
          break;
        }
        case 'tracer': {
          const style = WEAPONS[e.weapon].tracer;
          if (style === null) break;
          // Own shots start at the gun, other players' a bit below their eyes, ricochets exactly at the wall.
          const from = e.player === me ? this.renderer.muzzleWorld(e.hand)
            : new THREE.Vector3(e.from.x, e.from.y - (e.player < 0 ? 0 : 0.25), e.from.z);
          fx.tracer(from, e.to, style?.color, style?.width, style?.life);
          break;
        }
        case 'impact':
          fx.burst(e.pos, 0xd8d0c0, 4, 4, 0.35, 0.05);
          break;
        case 'hit': {
          const victim = sim.getPlayer(e.victim);
          fx.burst(e.pos, victim?.color ?? 0xffffff, e.head ? 12 : 7, 6, 0.5, 0.08);
          if (e.victim === me) {
            this.hud.damage(e.damage);
            this.sfx.play('hurt');
            const from = e.attacker !== me ? sim.getPlayer(e.attacker) : undefined;
            if (from && victim) {
              // yaw that would face the attacker, minus the yaw we are looking along
              this.hud.damageFrom(Math.atan2(-(from.pos.x - victim.pos.x), -(from.pos.z - victim.pos.z)) - this.input.yaw);
            }
            this.renderer.shake += Math.min(1.5, e.damage / 25);
          } else if (e.attacker === me) {
            this.hud.hitmarker(e.head, e.killed);
            this.sfx.play(e.killed ? 'kill' : e.head ? 'headshot' : 'hit');
          }
          break;
        }
        case 'kill': {
          const victim = sim.getPlayer(e.victim);
          const label = e.cause === 'void' ? 'fell into the void' : e.cause === 'zone' ? 'was taken by the zone'
            : e.cause === 'left' ? 'left the match' : e.cause === 'lava' ? 'touched the floor' : e.cause === 'crush' ? 'was crushed'
            : e.cause === 'throw' ? 'THROW' : WEAPONS[e.cause].name;
          this.hud.killfeed(sim.getPlayer(e.killer), victim, label);
          if (e.killer === me && e.victim !== me && victim) this.hud.toast('ELIMINATED', victim);
          if (victim) this.renderer.spawnCorpse(victim, e.cause === 'void' ? -Infinity : e.pos.y);
          this.sfx.play('death', e.victim === me ? null : e.pos);
          break;
        }
        case 'explosion': {
          fx.explosion(e.pos, e.radius);
          this.sfx.play('explosion', e.pos, 1.6);
          const d = this.renderer.camera.position.distanceTo(new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z));
          this.renderer.shake += Math.max(0, 2 - d / (e.radius * 1.8)) * Math.min(2.5, e.radius / 4.5); // bigger blast, bigger shake, felt from further
          break;
        }
        case 'jump':
        case 'walljump':
        case 'slide':
          this.sfx.play(e.t, e.player === me ? null : e.pos, e.player === me ? 0.8 : 1);
          if (e.t === 'walljump') fx.burst(e.pos, 0xd8d0c0, 6, 3, 0.3, 0.06);
          break;
        case 'pad':
        case 'tele':
          this.sfx.play(e.t, e.player === me ? null : e.pos);
          fx.burst({ x: e.pos.x, y: e.pos.y + 0.8, z: e.pos.z }, e.t === 'pad' ? 0xffd23a : 0x9ae8ff, 10, 5, 0.4, 0.07, 4);
          break;
        case 'land':
          if (e.speed > 4) this.sfx.play('land', e.player === me ? null : e.pos, Math.min(1.2, e.speed / 12));
          if (e.speed > 7) fx.burst({ x: e.pos.x, y: e.pos.y + 0.1, z: e.pos.z }, 0xcfc8b8, 7, 3, 0.45, 0.1, 3);
          break;
        case 'pickup':
          this.sfx.play('pickup', e.player === me ? null : sim.getPlayer(e.player)?.pos ?? null);
          break;
        case 'throw':
          this.sfx.play('throw', e.player === me ? null : sim.getPlayer(e.player)?.pos ?? null);
          if (e.player === me) this.renderer.vm.onFire('fists');
          break;
        case 'empty':
          if (e.player === me) this.sfx.play('empty');
          break;
        case 'trap': {
          const mine = e.victim === me;
          this.sfx.play(e.weapon === 'snapper' ? 'snap' : e.weapon === 'popper' ? 'pad' : 'hiss', mine ? null : e.pos, 1.3);
          fx.burst({ x: e.pos.x, y: e.pos.y + 0.3, z: e.pos.z }, e.weapon === 'stinker' ? 0x9ad23a : 0xffd23a, 12, 5, 0.5, 0.09, 6);
          if (mine) {
            this.hud.toast(e.weapon === 'snapper' ? 'CAUGHT IN A SNAPPER' : e.weapon === 'popper' ? 'POPPED!' : 'GAS! GET OUT');
            this.renderer.shake += 1;
          }
          break;
        }
        case 'swap': {
          // Being swapped looks exactly like teleporting for no reason, so say who did it.
          const other = sim.getPlayer(e.a === me ? e.b : e.a);
          if ((e.a === me || e.b === me) && other) this.hud.toast(e.a === me ? 'SWAPPED PLACES WITH' : 'SWAPPED BY', other);
          break;
        }
        case 'thud':
          this.sfx.play('thud', e.pos);
          break;
        case 'respawn':
          if (e.player === me && !(s instanceof LabSession && s.flying)) {
            this.input.setView(e.yaw, 0);
            if (s.kind === 'offline') this.sfx.play('respawn');
          }
          break;
      }
    }
    s.events.length = 0;
  }
}
