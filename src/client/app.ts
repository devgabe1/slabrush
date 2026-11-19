import * as THREE from 'three';
import { Sfx } from '../audio/sfx';
import { VoiceChat, micProblem } from '../audio/voice';
import { MATCH, PLAYER_COLORS } from '../config/game';
import { WEAPONS } from '../config/weapons';
import { generateMap } from '../maps/generator';
import { ClientSession } from '../net/clientSession';
import { HostSession } from '../net/hostSession';
import { peerHost, peerJoin } from '../net/peerTransport';
import { iceServers, randomRoomCode } from '../net/protocol';
import { hashSeed } from '../core/rng';
import { LabSession, OfflineSession, type Session } from '../net/session';
import { localHost, localJoin, type HostTransport } from '../net/transport';
import { mouthOpenFor } from '../audio/voice';
import { HeadPortraits } from '../render/headPortraits';
import { RoundTally, matchRows, practiceRows } from './scoreboard';
import { GameRenderer, type CamMode } from '../render/gameRenderer';
import { LookThumbs } from '../render/lookThumbs';
import { ANNOUNCE_EVERY, announceRoom, withdrawRoom } from '../net/roomDirectory';
import { Hud } from './hud';
import { Input } from './input';
import { Menus } from './menus';
import { enterFullscreen, watchFullscreen } from './fullscreen';
import { keyLabel, loadSettings } from './settings';
import { MicMeter } from './micTest';

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
  private thumbs = new LookThumbs();
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
  /** The player whose eyes we are looking through while dead, else -1. */
  private watching = -1;
  private dustT = 0;
  private talkHeld = false;
  /** HECKLER without voice chat (practice range, map lab): a microphone opened only while it is in hand. */
  private heckMic: MicMeter | null = null;
  /** Hold-Tab scoreboard: this round's kills so far, and the live heads. */
  private tally = new RoundTally();
  private portraits = new HeadPortraits();
  /** Room code currently announced on the local network list, and when it was last announced. */
  private listed = '';
  private listedAt = -Infinity;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new GameRenderer(canvas);
    this.input = new Input(canvas, this.settings);
    this.hud = new Hud(document.getElementById('hud')!, this.settings);
    this.menus = new Menus(document.getElementById('menu')!, this.settings, LOCAL_MODE, {
      onPractice: () => this.startPractice(),
      onLab: (seed) => this.startLab(seed),
      onCreate: () => void this.createRoom(),
      onJoin: (code) => void this.joinRoom(code),
      onStart: () => { if (this.session instanceof HostSession) this.session.start(); },
      onMaxPlayers: (n) => { if (this.session instanceof HostSession) this.session.setMaxPlayers(n); },
      onLeave: () => this.leave(),
      onResume: () => this.capture(),
      onQuit: () => this.leave(),
      onSettingsChanged: () => this.applySettings(),
      onClick: () => { this.sfx.unlock(); this.sfx.play('ui'); },
      lookPictures: (part, look) => this.thumbs.pictures(part, look, PLAYER_COLORS[0]),
    });
    // Every time the flying head hits something: a thud, harder for a harder hit.
    this.renderer.onHeadBonk = (speed) => this.sfx.play('thud', null, Math.min(1.6, 0.4 + speed / 8));
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
    window.addEventListener('pagehide', () => { this.unlist(); this.session?.dispose(); });
    // Safety net for shortcuts we cannot capture (Ctrl+W outside fullscreen, other
    // browsers): while you are in an online room, or playing at all with crouch
    // on Ctrl (where Ctrl+W is one slip away), closing the tab asks first.
    window.addEventListener('beforeunload', (e) => {
      const online = !!this.session && this.session.kind !== 'offline' && !this.session.ended;
      const k = this.settings.keys;
      const ctrlCrouch = this.state === 'game' && (k.crouch.startsWith('Control') || k.duck.startsWith('Control'));
      if (online || ctrlCrouch) {
        e.preventDefault();
        e.returnValue = ''; // older browsers need this to show the dialog
      }
    });
    watchFullscreen(() => { if (this.menus.screen === 'settings') this.menus.show('settings'); });
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
    this.voice?.setDevice(this.settings.micDevice);
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

  /**
   * Hosting: keep the room on the local network list (when there is one) so
   * others can join from the list instead of typing the code.
   */
  private listRoom(s: Session): void {
    if (!(s instanceof HostSession)) return;
    const now = performance.now() / 1000;
    if (this.listed === s.code && now - this.listedAt < ANNOUNCE_EVERY) return;
    this.listed = s.code;
    this.listedAt = now;
    announceRoom({
      code: s.code, host: s.roster[0]?.name ?? this.settings.nickname, players: s.roster.length, max: s.maxPlayers,
      phase: s.match.phase === 'lobby' ? 'lobby' : 'playing', local: LOCAL_MODE,
    });
  }

  private unlist(): void {
    if (this.listed) withdrawRoom(this.listed);
    this.listed = '';
    this.listedAt = -Infinity;
  }

  /**
   * How loud we are (0..1, or -1 = no microphone), sent with every input: it
   * powers the HECKLER. From the voice chat's microphone when there is one;
   * offline, from a microphone opened only while a HECKLER is in hand.
   */
  private updateLoudness(s: Session): void {
    const me = s.view.getPlayer(s.localId);
    const w = me?.weapons[me.active];
    const heckler = !!w && !!WEAPONS[w.type].shout;
    let rms = -1;
    if (this.voice && this.voice.mode !== 'off' && this.voice.micState === 'on') rms = this.voice.micRms;
    else if (heckler) {
      if (!this.heckMic) { this.heckMic = new MicMeter(); void this.heckMic.start(this.settings.micDevice); }
      if (!this.heckMic.error) rms = this.heckMic.rms();
    }
    if (!heckler && this.heckMic) { this.heckMic.stop(); this.heckMic = null; }
    // Offline there is no voice chat to hear ourselves through: the mic meter does it.
    this.heckMic?.setMegaphone((me?.shoutT ?? 0) > 0 && !!me?.alive, this.settings.volume * this.settings.voiceVolume);
    // Speech RMS: about 0.03 talking, 0.1-0.3 shouting (with the browser's auto gain on).
    this.input.loud = rms < 0 ? -1 : Math.max(0, Math.min(1, (rms - 0.02) / 0.22));
  }

  /** Each frame: open or close the microphone, place every voice, light up the talk indicators. */
  private updateVoice(s: Session): void {
    const v = this.voice;
    if (!v) return;
    // A HECKLER that is on keys the microphone too, push to talk or not.
    const shouting = (s.view.getPlayer(s.localId)?.shoutT ?? 0) > 0;
    v.setTransmit(v.mode === 'open' || (v.mode === 'ptt' && this.talkHeld) || shouting);
    const phase = s.match?.phase ?? 'lobby';
    v.update(s.roster.map((p) => p.id), phase, (id) => s.view.getPlayer(id), this.renderer.camera.position);

    const problem = v.mode === 'off' ? '' : micProblem(v.micState)
      || (v.usingFallback ? 'chosen microphone not found: using the default' : '');
    const note = problem && v.micState !== 'asking' && v.micState !== 'on' ? `${problem} (listening only)` : problem;
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
          : v.mode === 'ptt' ? `Voice: hold ${key} to talk. In a round only players near you hear you, and the more hurt you are the higher your voice.`
          : 'Voice: open mic. In a round only players near you hear you, and the more hurt you are the higher your voice.';
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
    this.renderer.stopHeadCam();
    this.voice?.dispose();
    this.voice = null;
    if (s.voice) {
      // ?local tabs reach each other directly; real rooms use the same STUN/TURN servers as the game.
      const ice = LOCAL_MODE ? [] : iceServers(this.settings.turn);
      this.voice = new VoiceChat(s.voice, () => s.localId, () => this.sfx.context, () => this.sfx.output, ice, this.settings.voice, this.settings.micDevice);
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
    this.capture();
  }

  /**
   * Capture the mouse, and go fullscreen first if the player asked for it
   * (fullscreen also captures Ctrl+W & co. where the browser allows). Both need
   * a recent click, which START / PLAY / the practice buttons provide.
   */
  private capture(): void {
    if (this.settings.autoFullscreen === 'on') void enterFullscreen().then(() => this.input.lock());
    else this.input.lock();
  }

  /** Leave whatever we are in and go back to the main menu, optionally explaining why. */
  leave(message?: string): void {
    this.connecting++;
    this.unlist();
    this.session?.dispose();
    this.session = null;
    this.voice?.dispose();
    this.voice = null;
    this.heckMic?.stop();
    this.heckMic = null;
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
    if (!s || this.state !== 'game') {
      this.renderer.setPreview(this.menus.screen === 'character' ? this.settings.look : null, PLAYER_COLORS[0]);
      this.renderer.previewTalk = mouthOpenFor(this.menus.previewVoice());
      this.renderer.renderMenu(dt);
      return;
    }
    const me = s.view.getPlayer(s.localId);
    const cam = this.chooseCamera(s);
    this.renderer.render(s.view, s.localId, this.alpha, dt, {
      yaw: this.input.yaw, pitch: this.input.pitch, mouseDX: this.input.swayX, mouseDY: this.input.swayY,
    }, cam, (id) => this.voice?.mouth(id) ?? 0);
    this.input.swayX = this.input.swayY = 0;
    this.input.firePressed = false;
    const watched = cam.mode === 'spectate' ? s.view.getPlayer(cam.target) : undefined;
    this.watching = watched?.id ?? -1;
    this.hud.setSpectating(watched?.name ?? null);
    this.hud.setCinematic(cam.mode === 'orbit');
    this.hud.setDeathCam(cam.mode === 'head');
    this.hud.setScope(this.renderer.scope);
    this.input.zoomScale = this.renderer.zoom;
    this.sfx.setListener(this.renderer.camera.position, this.input.yaw, this.input.pitch);
    // Spectating: the health shown is theirs.
    if (watched) this.hud.update(dt, watched, s.view, s.kind !== 'offline');
    else if (me) this.hud.update(dt, me, s.view, s.kind !== 'offline');
    const count = this.hud.updateMatch(dt, s, me);
    this.drawScoreboard(s, dt);
    if (count !== this.lastCount) {
      if (count > 0) this.sfx.play('ui', null, 1.5);
      this.lastCount = count;
    }
  };

  /** The hold-Tab scoreboard: shown while the key is held, with every player's head turning beside their stats. */
  private drawScoreboard(s: Session, dt: number): void {
    const m = s.match;
    this.tally.sync(m?.phase);
    const open = this.input.isHeld('scores');
    const rows = m
      ? matchRows(m, s.roster, s.localId, (id) => s.view.getPlayer(id)?.alive, this.tally)
      : practiceRows(s.view.players, s.localId);
    const title = m
      ? `MAP ${m.mapNumber} · ROUND ${m.round} — first to ${MATCH.mapsToWin} maps, ${MATCH.roundsPerMap} rounds take a map`
      : s.map.name;
    const talking = (id: number) => (this.voice?.mouth(id) ?? 0) > 0.05;
    const canvases = this.hud.tabBoard(open, title, rows, !!m, talking, MATCH.roundsPerMap);
    if (!canvases) return;
    this.portraits.draw(rows.map((r) => ({ ...r, canvas: canvases.find((c) => c.id === r.id)!.canvas })), (id) => this.voice?.mouth(id) ?? 0, dt);
  }

  /**
   * Normally your own eyes. Out of the round: watch through another player
   * (fire cycles). Match over: everyone circles the winner.
   */
  private chooseCamera(s: Session): CamMode {
    const m = s.match;
    const me = s.view.getPlayer(s.localId);
    if (m && m.phase === 'matchEnd' && s.view.getPlayer(m.winner)?.alive) return { mode: 'orbit', target: m.winner };
    // Just died: for a few seconds we are our own head, flying off.
    if (me && !me.alive && this.renderer.headCamFlying) return { mode: 'head', target: s.localId };
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
    // Dead with nobody to watch (or in practice, waiting to respawn): stay where the head came to rest.
    if (me && !me.alive && this.renderer.headCamExists) return { mode: 'head', target: s.localId };
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
    this.listRoom(s);
    this.updateLoudness(s);
    // Voice runs here, not in the draw loop: browsers stop drawing in background
    // tabs, and an alt-tabbed player must still be heard (and hear) correctly.
    this.updateVoice(s);

    if (s.mapVersion !== this.mapVersion) {
      this.mapVersion = s.mapVersion;
      if (this.state === 'game' || s.kind === 'offline') this.renderer.setMap(s.map);
      if (s instanceof LabSession) this.renderer.setMarkers(s.map.spawns.map((sp) => sp.pos));
    }
    if (s.roundVersion !== this.roundVersion) {
      this.roundVersion = s.roundVersion;
      this.renderer.clearEntities();
      this.renderer.stopHeadCam(); // a new round: back in our body
      this.portraits.clear();
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
      // Melee status, visible to everyone: blood drips from the bleeding, water from the soaked.
      if (dust && p.alive && (p.bleed > 0 || p.soaked > 0)) {
        const at = () => ({ x: p.pos.x + (Math.random() - 0.5) * 0.55, y: p.pos.y + 0.6 + Math.random() * 0.9, z: p.pos.z + (Math.random() - 0.5) * 0.55 });
        if (p.bleed > 0) this.renderer.fx.burst(at(), 0xa81818, 2, 0.6, 0.7, 0.08);
        if (p.soaked > 0) {
          this.renderer.fx.burst(at(), 0x6ac4f4, 2, 0.6, 0.6, 0.075);
          if (p.grounded && Math.random() < 0.4) this.renderer.fx.puff({ x: p.pos.x, y: p.pos.y + 0.05, z: p.pos.z }, 0x9ad8f8, 0.22); // a puddle splash at the feet
        }
      }
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
    const watched = this.watching; // spectating: their shots and hits look like our own
    const { fx } = this.renderer;
    for (const e of s.events) {
      switch (e.t) {
        case 'fire': {
          const local = e.player === me;
          // Other players' gunfire is positional and a little louder than your own, so fights are easy to locate.
          // (Individual weapons' volume, such as the NEEDLE and VERDICT, is set in SOUND_VOLUME in sfx.ts.)
          this.sfx.play(e.weapon, local ? null : e.origin, local ? 1 : 1.5);
          if (local) {
            const r = WEAPONS[e.weapon].recoil;
            this.renderer.vm.onFire(e.weapon, e.hand);
            this.input.addRecoil(r.pitch * D2R, (Math.random() - 0.5) * 2 * r.yaw * D2R);
          } else if (e.player === watched) this.renderer.vm.onFire(e.weapon, e.hand);
          if (e.weapon === 'toaster') {
            // a tongue of flame: orange puffs along the aim, yellow near the nozzle
            for (let k = 1; k <= 5; k++) {
              fx.puff({ x: e.origin.x + e.dir.x * k * 1.5, y: e.origin.y - 0.25 + e.dir.y * k * 1.5, z: e.origin.z + e.dir.z * k * 1.5 }, k < 3 ? 0xffd23a : 0xff7a1a, 0.14 + k * 0.06);
            }
          }
          if (e.weapon === 'afterburn') {
            // a long roaring tongue of flame, the whole length of its reach
            for (let k = 1; k <= 8; k++) {
              fx.puff({ x: e.origin.x + e.dir.x * k * 1.45, y: e.origin.y - 0.25 + e.dir.y * k * 1.45, z: e.origin.z + e.dir.z * k * 1.45 }, k < 3 ? 0xffe070 : k < 6 ? 0xff7a1a : 0xc83a1a, 0.18 + k * 0.08);
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
          const from = e.player === me || e.player === watched ? this.renderer.muzzleWorld(e.hand)
            : new THREE.Vector3(e.from.x, e.from.y - (e.player < 0 ? 0 : 0.25), e.from.z);
          fx.tracer(from, e.to, style?.color, style?.width, style?.life);
          break;
        }
        case 'impact':
          fx.burst(e.pos, 0xd8d0c0, 4, 4, 0.35, 0.05);
          break;
        case 'hit': {
          const victim = sim.getPlayer(e.victim);
          if (e.cause === 'banhammer' && !e.dot) {
            // The BANHAMMER tolls a great bell: in the head of the two players involved,
            // and from where it happened, loud, for everyone else on the map.
            const close = e.victim === me || e.attacker === me || e.victim === watched;
            this.sfx.play('bell', close ? null : e.pos, close ? 1.7 : 2.6);
          }
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
          } else if (e.victim === watched) {
            this.hud.damage(e.damage); // the red flash when the player you watch is hit
          } else if (e.attacker === me && e.dot && !e.killed) {
            // bleeding: no hitmarker every half second
          } else if (e.attacker === me) {
            this.hud.hitmarker(e.head, e.killed);
            this.sfx.play(e.killed ? 'kill' : e.head ? 'headshot' : 'hit');
          }
          break;
        }
        case 'kill': {
          this.tally.add(e, s.match?.phase);
          const victim = sim.getPlayer(e.victim);
          // Dropped or flung to their death by a beam: the fall is the weapon, and its owner gets the credit.
          const credited = e.killer >= 0 && e.killer !== e.victim;
          const label = credited && (e.cause === 'void' || e.cause === 'zone' || e.cause === 'lava' || e.cause === 'crush')
            ? { void: 'VOID', zone: 'ZONE', lava: 'LAVA', crush: 'CRUSHED' }[e.cause]
            : e.cause === 'void' ? 'fell into the void' : e.cause === 'zone' ? 'was taken by the zone'
            : e.cause === 'left' ? 'left the match' : e.cause === 'lava' ? 'touched the floor' : e.cause === 'crush' ? 'was crushed'
            : e.cause === 'throw' ? 'THROW' : WEAPONS[e.cause].name;
          this.hud.killfeed(sim.getPlayer(e.killer), victim, label);
          if (e.killer === me && e.victim !== me && victim) this.hud.toast('ELIMINATED', victim);
          if (victim) {
            const inVoid = e.cause === 'void';
            // The head comes off away from whoever did it (or along the way they were going).
            const killer = e.killer !== e.victim ? sim.getPlayer(e.killer) : undefined;
            const away = killer ? { x: victim.pos.x - killer.pos.x, y: 0, z: victim.pos.z - killer.pos.z } : { x: victim.vel.x, y: 0, z: victim.vel.z };
            if (e.victim === me) {
              // It is us: the camera becomes the head. The body still blows apart, minus the head we are looking out of.
              const floorY = this.renderer.spawnCorpse(victim, inVoid, null, false);
              this.renderer.startHeadCam(this.renderer.camera.position, away, victim.vel, floorY, this.input.yaw, this.input.pitch);
              this.hud.damage(80);
            } else {
              const len = Math.hypot(away.x, away.z) || 1;
              const hv = { x: (away.x / len) * 3.5 + victim.vel.x * 0.4, y: 6.5, z: (away.z / len) * 3.5 + victim.vel.z * 0.4 };
              this.renderer.spawnCorpse(victim, inVoid, Math.hypot(away.x, away.z) > 0.01 ? hv : null, true);
            }
          }
          this.sfx.play('death', e.victim === me ? null : e.pos);
          break;
        }
        case 'explosion': {
          fx.explosion(e.pos, e.radius);
          if (e.festive) {
            // PINATA bomblet: a party pop with a light boom under it (it still hurts) and a puff of confetti.
            this.sfx.play('confetti', e.pos, 1.6);
            this.sfx.play('explosion', e.pos, 0.7);
            for (const c of [0xe8503a, 0xe8c63a, 0x5ad86a, 0x3aa6e8, 0xd85ad8]) fx.burst({ x: e.pos.x, y: e.pos.y + 0.3, z: e.pos.z }, c, 3, 5, 0.9, 0.06, 6);
          } else {
            this.sfx.play('explosion', e.pos, 1.6);
          }
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
          if (e.player === me || e.player === watched) this.renderer.vm.onFire('fists');
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
        case 'party': {
          // The PINATA burst: festive noise and a cloud of confetti, before the bomblets do their work.
          this.sfx.play('party', e.pos, 1.5);
          for (const c of [0xe8503a, 0xe8c63a, 0x5ad86a, 0x3aa6e8, 0xd85ad8, 0xffffff]) fx.burst({ x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z }, c, 7, 7, 1.1, 0.07, 6);
          break;
        }
        case 'shout': {
          // HECKLER pulse: a ring of sound down the aim, and a megaphone crackle (the voice itself is the real sound).
          const def = WEAPONS.heckler.shout!;
          fx.wave(e.origin, e.dir, e.power >= def.whisper ? e.power : 0.05, def.cone);
          const near = e.player === me || e.player === watched;
          this.sfx.play('heckler', near ? null : e.origin, (near ? 0.5 : 0.9) * (0.3 + e.power));
          if (e.player === me) this.renderer.shake = Math.max(this.renderer.shake, e.power * 0.25);
          break;
        }
        case 'shouted':
          // Caught in a HECKLER blast: the aim is thrown about, the view rattles.
          if (e.victim === me) {
            const kick = WEAPONS.heckler.shout!.aimKick * e.power * (Math.PI / 180);
            this.input.addRecoil((Math.random() - 0.3) * kick, (Math.random() - 0.5) * 2 * kick);
            this.renderer.shake += e.power * 0.6;
          }
          break;
        case 'mirror': {
          // REARVIEW: something stopped dead in a field, or the whole lot sent back.
          const mine = e.player === me;
          if (e.kind === 'catch') {
            this.sfx.play('catch', mine ? null : e.pos, mine ? 0.8 : 1.2);
            fx.burst(e.pos, 0xcfe6f0, 5, 3, 0.25, 0.05, 0);
          } else {
            this.sfx.play('reflect', mine ? null : e.pos, 1.2);
            fx.burst(e.pos, 0xfff2c8, 10 + Math.min(20, e.count * 2), 9, 0.35, 0.06, 0);
          }
          break;
        }
        case 'jet': {
          // JETHAMMER: the sound barrier, someone run down, a wall met.
          const mine = e.player === me;
          if (e.kind === 'boom') {
            this.sfx.play('boom', mine ? null : e.pos, mine ? 0.9 : 1.4);
            fx.burst(e.pos, 0xf4f0e8, 26, 16, 0.45, 0.09, 0);
            if (mine) this.renderer.shake = Math.max(this.renderer.shake, 0.7);
          } else if (e.kind === 'smash') {
            this.sfx.play('smash', mine ? null : e.pos, 1.3);
            fx.burst(e.pos, 0xc8281e, 22, 12, 0.6, 0.1);
            if (mine) this.renderer.shake = Math.max(this.renderer.shake, 0.8);
          } else {
            this.sfx.play('splat', mine ? null : e.pos, 1.3);
            fx.burst(e.pos, 0xd8d0c0, 16, 7, 0.5, 0.08);
            if (mine) {
              this.renderer.shake = Math.max(this.renderer.shake, 1);
              this.hud.toast('SPLAT');
            }
          }
          break;
        }
        case 'beam': {
          // MONOLOGUE: someone caught, dropped or hurled.
          const near = e.player === me || e.victim === me;
          this.sfx.play(e.kind === 'grab' ? 'grab' : e.kind, near ? null : e.pos, near ? 0.9 : 1.3);
          fx.burst(e.pos, 0x7af0ff, e.kind === 'grab' ? 14 : 9, e.kind === 'fling' ? 7 : 4, 0.4, 0.06);
          if (e.victim === me && e.kind === 'grab') this.renderer.shake = Math.max(this.renderer.shake, 0.6);
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
        case 'status': {
          // A melee power went off: its own sound, a burst, and a word for the two people involved.
          const mine = e.victim === me, mineToo = e.attacker === me;
          const victim = sim.getPlayer(e.victim);
          const at = mine ? null : e.pos;
          if (e.kind === 'bleed') {
            this.sfx.play('cut', at, 1.2);
            fx.burst(e.pos, 0xb81e1e, 8, 3, 0.5, 0.06);
            if (mine) this.hud.toast('BLEEDING');
          } else if (e.kind === 'soak') {
            this.sfx.play('splash', at, 1.3);
            fx.burst(e.pos, 0x5ab8f0, 16, 5, 0.6, 0.07);
            fx.burst(e.pos, 0xd8f4ff, 6, 3, 0.4, 0.05);
            if (mine) this.hud.toast('SOAKED — SLIPPERY FOOTING');
          } else if (e.kind === 'splat') {
            this.sfx.play('splat', at, 1.5);
            fx.burst(e.pos, victim?.color ?? 0xffffff, 18, 7, 0.6, 0.09);
            fx.burst(e.pos, 0xd8d0c0, 10, 4, 0.5, 0.08);
            if (mine) { this.hud.toast('WALL SPLAT'); this.renderer.shake += 1.6; }
            else if (mineToo && victim) this.hud.toast('WALL SPLAT', victim);
          } else if (e.kind === 'combo') {
            this.sfx.play('uppercut', at, 1.3);
            fx.burst(e.pos, 0xffd23a, 12, 6, 0.4, 0.07);
            if (mine) { this.hud.toast('UPPERCUT!'); this.renderer.shake += 1.2; }
            else if (mineToo && victim) this.hud.toast('UPPERCUT!', victim);
          }
          break;
        }
        case 'respawn':
          if (e.player === me) this.renderer.stopHeadCam();
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
