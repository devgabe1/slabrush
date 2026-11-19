import { LOOK_LABELS, LOOK_PARTS, randomLook } from '../config/looks';
import type { RosterPlayer } from '../sim/match';
import { VOICE } from '../audio/voiceRules';
import { keyboardLockSupported, keyboardLocked, toggleFullscreen } from './fullscreen';
import { listRooms, type RoomListing } from '../net/roomDirectory';
import { MicMeter, listMics, revealMicNames, type MicDevice } from './micTest';
import { ACTION_LABELS, DEFAULT_SETTINGS, keyLabel, saveSettings, type Action, type Settings } from './settings';

export type Screen = 'main' | 'join' | 'lab' | 'character' | 'busy' | 'message' | 'lobby' | 'pause' | 'settings' | null;

export interface MenuCallbacks {
  onPractice(): void;
  onLab(seed: string, players: number): void;
  onCreate(): void;
  onJoin(code: string): void;
  onRejoin(): void; // back into the match we dropped out of
  onStart(): void;
  onMaxPlayers(n: number): void;
  onLeave(): void; // leave lobby / cancel connecting
  onResume(): void;
  onQuit(): void; // leave the running game
  onSettingsChanged(): void;
  onClick(): void; // UI sound + audio unlock
  /** Character screen: a picture of every option of one body part, worn with the rest of the look ([] = names only). */
  lookPictures(part: number, look: readonly number[]): string[];
}

export interface LobbyInfo {
  code: string;
  players: RosterPlayer[];
  localId: number;
  isHost: boolean;
  maxPlayers: number;
}

/** Map lab hotkeys. Fly up / down / fast are the jump, walk and crouch bindings, so they follow the keybinds. */
const labKeys = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>N</kbd> next seed</span><span><kbd>B</kbd> previous seed</span>
  <span><kbd>R</kbd> random seed</span><span><kbd>V</kbd> fly / walk</span>
  <span><kbd>${keyLabel(k.jump)}</kbd> fly up</span><span><kbd>${keyLabel(k.walk)}</kbd> fly down</span>
  <span><kbd>${keyLabel(k.crouch)}</kbd> fly fast</span><span><kbd>P</kbd> players (2-6)</span>
  <span class="tip">Green beacons mark the spawn points. The map size follows the number of players, as in a match. Walk mode uses the real movement and physics, so you can test every jump pad, platform and door.</span>
</div>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const css = (color: number) => '#' + color.toString(16).padStart(6, '0');

/** Main menu, lobby, pause menu and settings. Plain DOM. */
export class Menus {
  screen: Screen = null;
  /** true while in a multiplayer match: changes the pause menu wording */
  online = false;
  isHost = false;
  /** true in the map lab: the pause menu explains its hotkeys */
  lab = false;
  /** A match we dropped out of recently (its room code), offered on the main menu. */
  rejoinCode: string | null = null;
  /** Map lab: how many players to pretend are in the room (picks the map size). */
  labPlayers = 4;
  private back: Screen = 'main';
  private rebinding: Action | null = null;
  private text = '';
  private lobby: LobbyInfo | null = null;
  /** Character screen: which body part's options are showing (0 face, 1 torso, 2 legs). */
  private lookTab = 0;
  /** Join screen: rooms on this network (null = no list available here), refreshed while it is open. */
  private rooms: RoomListing[] | null = null;
  private roomsTimer = 0;
  // Microphone picker (settings screen)
  private mics: MicDevice[] = [];
  private micsNamed = true;
  private meter = new MicMeter();
  private meterLoop = 0;

  /** `localMode`: this page uses ?local rooms (same browser), so it lists only those. */
  constructor(private root: HTMLElement, private settings: Settings, private localMode: boolean, private cb: MenuCallbacks) {
    root.addEventListener('click', (e) => this.click(e));
    root.addEventListener('input', (e) => this.input(e));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'code') this.join();
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'seed') this.openLab();
    });
    // Capture phase so a rebind grabs the key before anything else sees it.
    document.addEventListener('keydown', (e) => this.rebindWith(e, e.code), true);
    root.addEventListener('mousedown', (e) => this.rebindWith(e, 'Mouse' + e.button), true);
  }

  show(screen: Screen): void {
    if (screen === 'join' && this.screen !== 'join') this.startRoomList();
    else if (screen !== 'join') clearInterval(this.roomsTimer);
    if (screen === 'settings' && this.screen !== 'settings') {
      this.back = this.screen;
      this.openMicPanel();
    } else if (screen !== 'settings' && this.screen === 'settings') this.closeMicPanel();
    // The character screen listens too (only if the microphone is already allowed:
    // it never asks), so your character mouths along when you talk.
    if (screen === 'character' && this.screen !== 'character') void this.listenForPreview();
    else if (screen !== 'character' && this.screen === 'character' && screen !== 'settings') this.meter.stop();
    this.screen = screen;
    this.rebinding = null;
    this.root.className = screen ? 'open ' + screen : '';
    this.root.innerHTML = this.html(screen);
    if (screen === 'join') (this.root.querySelector('#code') as HTMLInputElement).focus();
    if (screen === 'lab') (this.root.querySelector('#seed') as HTMLInputElement).focus();
  }

  /** "Connecting…" style screen with a cancel button. */
  showBusy(text: string): void {
    this.text = text;
    this.show('busy');
  }

  /** Error / notice with a button back to the main menu. */
  showMessage(text: string): void {
    this.text = text;
    this.show('message');
  }

  setLobby(info: LobbyInfo): void {
    this.lobby = info;
    if (this.screen === 'lobby') this.show('lobby');
  }

  private html(screen: Screen): string {
    switch (screen) {
      case 'main': return this.main();
      case 'join': return `<div class="panel">
        <h2>JOIN ROOM</h2>
        <div class="rooms" data-rooms>${this.roomsHtml()}</div>
        <label>ROOM CODE <input id="code" class="big" maxlength="5" spellcheck="false" autocomplete="off" placeholder="ABCDE"></label>
        <button data-act="dojoin" class="primary">JOIN</button>
        <button data-act="main">BACK</button>
      </div>`;
      case 'lab': return `<div class="panel">
        <h2>MAP LAB</h2>
        <p class="note">Every match map is built from a seed. Type one to inspect what the generator makes of it — a number, or any word. Leave it empty for a random seed.</p>
        <label>SEED <input id="seed" class="big seed" maxlength="16" spellcheck="false" autocomplete="off" placeholder="random"></label>
        <label class="row"><span>Players</span><select id="labplayers">${[2, 3, 4, 5, 6]
          .map((n) => `<option ${n === this.labPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <p class="note">The map size is picked as a match with that many players would pick it: few players, mostly small maps.</p>
        <button data-act="dolab" class="primary">GENERATE</button>
        <button data-act="main">BACK</button>
        ${labKeys(this.settings.keys)}
      </div>`;
      case 'character': return this.characterHtml();
      case 'busy': return `<div class="panel"><h2>${esc(this.text)}</h2><p class="note">Setting up a direct connection…</p>
        <button data-act="leave">CANCEL</button></div>`;
      case 'message': return `<div class="panel"><h2>HOLD ON</h2><p class="note big">${esc(this.text)}</p>
        <button data-act="main" class="primary">BACK TO MENU</button></div>`;
      case 'lobby': return this.lobbyHtml();
      case 'pause': return this.pause();
      case 'settings': return this.settingsHtml();
      default: return '';
    }
  }

  /**
   * Character screen: tabs for the three body parts; the chosen tab lists every
   * option as a picture you can click, worn by your character as it is now.
   * The character itself stands to the right, walking, and changes as you pick.
   */
  private characterHtml(): string {
    return `<div class="panel charpanel">
      <h2>CHARACTER</h2>
      <div class="tabs" role="tablist">${this.lookTabsHtml()}</div>
      ${this.lookOptionsHtml()}
      <p class="note">${LOOK_PARTS[0].length * LOOK_PARTS[1].length * LOOK_PARTS[2].length} combinations. Cosmetic only: everyone has the same hit box, and your colour is assigned by the room. Set it before creating or joining a room.</p>
      <div class="rowbtn"><button data-act="randomlook">RANDOMIZE</button><button data-act="main" class="primary">DONE</button></div>
    </div>`;
  }

  private lookTabsHtml(): string {
    const look = this.settings.look;
    return LOOK_LABELS.map((label, i) =>
      `<button data-tab="${i}" class="tab ${i === this.lookTab ? 'on' : ''}" aria-pressed="${i === this.lookTab}">${label}<small>${LOOK_PARTS[i][look[i]].toLowerCase()}</small></button>`).join('');
  }

  private lookOptionsHtml(): string {
    const look = this.settings.look;
    const k = this.lookTab;
    const pics = this.cb.lookPictures(k, look);
    const options = LOOK_PARTS[k].map((name, i) =>
      `<button data-look="${k}:${i}" class="option ${i === look[k] ? 'on' : ''}" aria-pressed="${i === look[k]}" title="${name}">
        ${pics[i] ? `<img src="${pics[i]}" alt="" draggable="false">` : ''}<span>${name}</span></button>`).join('');
    return `<div class="options ${pics.length ? '' : 'nopics'}">${options}</div>`;
  }

  /**
   * Update the character screen in place. `grid` = the options themselves
   * changed (another tab, or a randomized outfit whose pictures differ);
   * otherwise only the highlight and the tab labels move. Never replays the
   * panel's entrance animation.
   */
  private refreshLook(grid: boolean): void {
    if (this.screen !== 'character') return;
    const tabs = this.root.querySelector('.tabs');
    if (tabs) tabs.innerHTML = this.lookTabsHtml();
    if (grid) {
      this.root.querySelector('.options')?.replaceWith(this.htmlNode(this.lookOptionsHtml()));
      return;
    }
    const k = this.lookTab, chosen = this.settings.look[k];
    this.root.querySelectorAll<HTMLElement>('.options .option').forEach((el) => {
      const on = el.dataset.look === `${k}:${chosen}`;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    });
  }

  private htmlNode(html: string): Element {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild!;
  }

  private controls(): string {
    const k = this.settings.keys;
    const row = (a: Action) => `<span><kbd>${keyLabel(k[a])}</kbd> ${ACTION_LABELS[a]}</span>`;
    return `<div class="controls">
      <span><kbd>${keyLabel(k.forward)}${keyLabel(k.left)}${keyLabel(k.back)}${keyLabel(k.right)}</kbd> Move</span>
      ${(['jump', 'crouch', 'duck', 'walk', 'fire', 'fire2', 'throw', 'use', 'swap', 'talk'] as Action[]).map(row).join('')}
      <span class="tip">Hold jump to bunny hop: every hop adds speed. Steer in mid-air with the movement keys; strafe + turn to go even faster. Crouch while fast to slide. Jump again next to a wall to wall jump. Right click aims (the NEEDLE has a scope); carry two one-handed weapons to hold both, and then right click fires the second. An empty gun is still a projectile.</span>
    </div>`;
  }

  private main(): string {
    return `<div class="panel main">
      <h1>SLABRUSH</h1>
      <p class="tag">LAST ONE STANDING TAKES THE SLAB</p>
      <label>NICKNAME <input id="nick" maxlength="14" spellcheck="false" value="${esc(this.settings.nickname)}"></label>
      ${this.rejoinCode ? `<button data-act="rejoin" class="primary">REJOIN ${esc(this.rejoinCode)} <small>back into your match</small></button>` : ''}
      <button data-act="create" class="${this.rejoinCode ? '' : 'primary'}">CREATE ROOM</button>
      <button data-act="join">JOIN ROOM <small>network list or code</small></button>
      <button data-act="character">CHARACTER <small>${LOOK_PARTS[0][this.settings.look[0]].toLowerCase()}</small></button>
      <button data-act="practice">PRACTICE RANGE</button>
      <button data-act="lab">MAP LAB <small>seed viewer</small></button>
      <button data-act="settings">SETTINGS</button>
      ${this.controls()}
      <p class="ver">v1.0 · every map, model, texture and sound is generated in code</p>
    </div>`;
  }

  private lobbyHtml(): string {
    const l = this.lobby;
    if (!l) return '';
    const rows = l.players.map((p) =>
      `<li data-pid="${p.id}"><i style="background:${css(p.color)}"></i>${esc(p.name)}${p.id === 1 ? '<small>host</small>' : ''}${p.id === l.localId ? '<small>you</small>' : ''}${p.away ? '<small>away</small>' : ''}</li>`);
    for (let i = l.players.length; i < l.maxPlayers; i++) rows.push('<li class="open"><i></i>open slot</li>');
    const hostUi = `
      <label class="row"><span>Max players</span><select data-lobby="max">${[2, 3, 4, 5, 6]
        .map((n) => `<option ${n === l.maxPlayers ? 'selected' : ''} ${n < l.players.length ? 'disabled' : ''}>${n}</option>`).join('')}</select></label>
      <button data-act="start" class="primary">${l.players.length > 1 ? 'START MATCH' : 'START SOLO <small>test run</small>'}</button>`;
    return `<div class="panel">
      <h2>LOBBY</h2>
      <p class="note">Room code — share it with your friends:</p>
      <button class="code" data-act="copy" title="Click to copy">${esc(l.code)}</button>
      <ul class="roster">${rows.join('')}</ul>
      <p class="note voicestat" data-voice></p>
      <p class="note">First to take 6 maps wins. A map is taken by winning 2 rounds on it. No respawns.</p>
      ${l.isHost ? hostUi : '<p class="note wait">Waiting for the host to start…</p>'}
      <button data-act="settings">SETTINGS</button>
      <button data-act="leave">${l.isHost ? 'CLOSE ROOM' : 'LEAVE'}</button>
    </div>`;
  }

  private pause(): string {
    const quit = !this.online ? 'QUIT TO MENU' : this.isHost ? 'CLOSE ROOM' : 'LEAVE MATCH';
    return `<div class="panel">
      <h2>${this.online ? 'MENU' : 'PAUSED'}</h2>
      ${this.online ? '<p class="note">The match keeps running while this is open.</p>' : ''}
      <button data-act="resume" class="primary">${this.online ? 'PLAY' : 'RESUME'}</button>
      <button data-act="settings">SETTINGS</button>
      <button data-act="quit">${quit}</button>
      ${this.lab ? labKeys(this.settings.keys) : this.controls()}
    </div>`;
  }

  private settingsHtml(): string {
    const s = this.settings;
    const slider = (id: string, label: string, min: number, max: number, step: number, val: number) =>
      `<label class="row"><span>${label}</span><input type="range" data-set="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></label>`;
    const scales: [number, string][] = [[1, '100% (sharp)'], [0.75, '75%'], [0.5, '50% (retro)'], [0.33, '33% (crunchy)'], [0.25, '25% (1998)']];
    const turn = (key: 'url' | 'username' | 'credential', label: string, ph: string) =>
      `<label class="row"><span>${label}</span><input type="text" data-turn="${key}" spellcheck="false" autocomplete="off" placeholder="${ph}" value="${esc(s.turn[key])}"></label>`;
    return `<div class="panel wide">
      <h2>SETTINGS</h2>
      ${slider('sensitivity', 'Mouse sensitivity', 0.1, 4, 0.05, s.sensitivity)}
      ${slider('fov', 'Field of view', 70, 130, 1, s.fov)}
      ${slider('volume', 'Volume', 0, 1, 0.05, s.volume)}
      <label class="row"><span>Render resolution</span><select data-set="renderScale">${scales
        .map(([v, l]) => `<option value="${v}" ${v === s.renderScale ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      <label class="row"><span>Retro filter</span><select data-sel="retro">${([['dither', 'Dithered colour (default)'], ['crt', 'Dither + scanlines'], ['off', 'Off (clean)']] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.retro ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      <label class="row"><span>Voice chat</span><select data-sel="voice">${([['open', 'Open mic (default)'], ['ptt', `Push to talk (${keyLabel(s.keys.talk)})`], ['off', 'Off']] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.voice ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ${slider('voiceVolume', 'Voice volume', 0, 2, 0.05, s.voiceVolume)}
      ${this.micHtml()}
      <label class="row"><span>Crosshair</span><select data-sel="crosshair">${([['cross', 'Cross'], ['dot', 'Dot'], ['circle', 'Circle']] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.crosshair ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ${slider('shake', 'Screen shake', 0, 1.5, 0.1, s.shake)}
      <label class="row"><span>Fullscreen when playing</span><select data-sel="autoFullscreen">${([['off', 'Off'], ['on', 'On (recommended to crouch with Ctrl)']] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.autoFullscreen ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      <button data-act="fullscreen">TOGGLE FULLSCREEN</button>
      <p class="note">${keyboardLockSupported
        ? `In fullscreen, browser shortcuts like Ctrl+W, Ctrl+T and Ctrl+N go to the game instead, so Ctrl is safe to bind (e.g. to crouch). Esc still opens the menu.${keyboardLocked ? ' <b class="ok">Captured right now.</b>' : ''}`
        : 'This browser cannot capture shortcuts like Ctrl+W, even in fullscreen (Chrome and Edge can). During online matches, closing the tab asks first.'}</p>
      <h3>KEYBINDS <small>click, then press a key or mouse button (Esc cancels)</small></h3>
      <div class="binds">${(Object.keys(ACTION_LABELS) as Action[])
        .map((a) => `<label>${ACTION_LABELS[a]}<button data-bind="${a}" class="${this.rebinding === a ? 'listening' : ''}">${
          this.rebinding === a ? 'press…' : keyLabel(s.keys[a])}</button></label>`).join('')}</div>
      <h3>TURN SERVER <small>optional — only if someone cannot connect (strict NAT / firewall). Used for the next room.</small></h3>
      ${turn('url', 'URL', 'turn:example.com:3478')}
      ${turn('username', 'Username', '')}
      ${turn('credential', 'Password', '')}
      <div class="rowbtn"><button data-act="defaults">RESET DEFAULTS</button><button data-act="back" class="primary">BACK</button></div>
    </div>`;
  }

  // ------------------------------------------------------------- microphone
  private openMicPanel(): void {
    void this.refreshMics();
    if (!this.micListener && navigator.mediaDevices?.addEventListener) {
      this.micListener = () => { if (this.screen === 'settings') void this.refreshMics(); };
      navigator.mediaDevices.addEventListener('devicechange', this.micListener);
    }
    this.restartMeter();
    const tick = () => {
      if (this.screen !== 'settings') return;
      const level = this.meter.sample();
      const bar = this.root.querySelector<HTMLElement>('[data-meter]');
      if (bar) bar.style.width = (level * 100).toFixed(0) + '%';
      const info = this.root.querySelector<HTMLElement>('[data-meterinfo]');
      const dying = this.meter.dyingUntil > 0 && performance.now() / 1000 < this.deathPreviewEnds;
      const text = this.settings.voice === 'off' ? 'voice off' : this.meter.error
        || (dying ? 'death voice…' : level > 0.08 ? 'hearing you' : 'speak to test');
      if (info && info.textContent !== text) info.textContent = text;
      this.meterLoop = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.meterLoop);
    this.meterLoop = requestAnimationFrame(tick);
  }
  private micListener: (() => void) | null = null;
  private deathPreviewEnds = 0;

  private async listenForPreview(): Promise<void> {
    if (this.settings.voice === 'off' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const perm = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      if (perm?.state !== 'granted' || this.screen !== 'character') return;
    } catch {
      return; // cannot tell without asking: stay quiet
    }
    await this.meter.start(this.settings.micDevice);
    if (this.screen !== 'character') this.meter.stop();
  }

  /** Your voice's loudness while the character screen is open (0 otherwise); drives the preview's mouth. */
  previewVoice(): number {
    return this.screen === 'character' && this.meter.running ? this.meter.rms() : 0;
  }

  private closeMicPanel(): void {
    cancelAnimationFrame(this.meterLoop);
    this.meter.loopback = false; // never left playing in the background
    this.meter.stop();
  }

  private restartMeter(): void {
    if (this.settings.voice === 'off' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { this.meter.stop(); return; }
    void this.meter.start(this.settings.micDevice).then(() => void this.refreshMics()); // permission may just have revealed names
  }

  private async refreshMics(): Promise<void> {
    const { devices, named } = await listMics().catch(() => ({ devices: [] as MicDevice[], named: false }));
    const changed = JSON.stringify([devices, named]) !== JSON.stringify([this.mics, this.micsNamed]);
    this.mics = devices;
    this.micsNamed = named;
    if (changed && this.screen === 'settings' && !this.rebinding) this.show('settings');
  }

  private micHtml(): string {
    const s = this.settings;
    const known = !s.micDevice || this.mics.some((m) => m.id === s.micDevice);
    const opts = [`<option value="" ${!s.micDevice ? 'selected' : ''}>System default</option>`]
      .concat(this.mics.map((m) => `<option value="${esc(m.id)}" ${m.id === s.micDevice ? 'selected' : ''}>${esc(m.label)}</option>`));
    if (!known) opts.push(`<option value="${esc(s.micDevice)}" selected>Chosen microphone (not connected)</option>`);
    return `<label class="row"><span>Microphone</span><select data-sel="micDevice">${opts.join('')}</select><output></output></label>
      <div class="row microw"><span>Mic level</span><div class="micmeter"><div data-meter></div></div><output data-meterinfo></output></div>
      ${this.loopbackHtml()}
      ${this.micsNamed || !this.mics.length ? '' : '<button data-act="micnames">SHOW MICROPHONE NAMES <small>asks for microphone permission</small></button>'}`;
  }

  private loopbackHtml(): string {
    if (this.settings.voice === 'off') return '';
    const m = this.meter;
    const hp = [[100, 'full health'], [50, '50 HP'], [25, '25 HP'], [10, '10 HP'], [1, '1 HP']] as const;
    return `<div class="rowbtn loopback">
        <button data-act="loopback" class="${m.loopback ? 'primary' : ''}">LOOPBACK ${m.loopback ? 'ON' : 'OFF'}</button>
        <select data-loophp aria-label="Hear yourself at">${hp.map(([v, l]) => `<option value="${v}" ${v === m.health ? 'selected' : ''}>as at ${l}</option>`).join('')}</select>
        <button data-act="deathvoice">DEATH VOICE</button>
      </div>
      <p class="note">Loopback plays your microphone back to you, voiced the way other players hear you. Use headphones: through speakers it feeds back.</p>`;
  }

  private loopbackVolume(): number {
    return this.settings.volume * this.settings.voiceVolume;
  }

  private openLab(): void {
    const pick = this.root.querySelector('#labplayers') as HTMLSelectElement | null;
    if (pick) this.labPlayers = Number(pick.value) || 4;
    this.cb.onLab((this.root.querySelector('#seed') as HTMLInputElement).value, this.labPlayers);
  }

  // ------------------------------------------------- rooms on this network
  private startRoomList(): void {
    clearInterval(this.roomsTimer);
    const poll = async () => {
      const all = await listRooms();
      if (this.screen !== 'join') return;
      const rooms = all && all.filter((r) => r.local === this.localMode);
      const changed = JSON.stringify(rooms) !== JSON.stringify(this.rooms);
      this.rooms = rooms;
      // Update the list in place: the code field keeps its focus and what was typed.
      const el = this.root.querySelector('[data-rooms]');
      if (changed && el) el.innerHTML = this.roomsHtml();
    };
    void poll();
    this.roomsTimer = window.setInterval(() => void poll(), 2000);
  }

  private roomsHtml(): string {
    if (!this.rooms) return ''; // no list here (e.g. the published site): the code field is the way in
    const rows = this.rooms.map((r) => {
      const full = r.players >= r.max, open = !full; // a match in progress can be joined too: you play from the next round
      const status = full ? 'full' : r.phase === 'playing' ? 'in progress · join' : 'open';
      return `<button class="room" data-room="${esc(r.code)}" ${open ? '' : 'disabled'}>
        <b>${esc(r.host)}</b><span>${r.players}/${r.max}</span><small class="${open ? 'open' : ''}">${status}</small><code>${esc(r.code)}</code></button>`;
    });
    return `<h3>ROOMS ON THIS NETWORK</h3>${rows.length ? rows.join('')
      : '<p class="note">No rooms yet. When someone on this network creates one, it shows up here.</p>'}`;
  }

  private join(): void {
    const code = (this.root.querySelector('#code') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length === 5) this.cb.onJoin(code);
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('button');
    if (!t || t.disabled) return;
    this.cb.onClick();
    if (t.dataset.room) {
      this.cb.onJoin(t.dataset.room);
      return;
    }
    if (t.dataset.tab) {
      const tab = Number(t.dataset.tab);
      if (tab !== this.lookTab) { this.lookTab = tab; this.refreshLook(true); }
      return;
    }
    const look = t.dataset.look;
    if (look) {
      // pick an option for a body part
      const [k, i] = look.split(':').map(Number);
      if (i >= 0 && i < LOOK_PARTS[k].length) this.settings.look[k] = i;
      saveSettings(this.settings);
      this.refreshLook(false);
      return;
    }
    const bind = t.dataset.bind as Action | undefined;
    if (bind) {
      this.rebinding = bind;
      this.show('settings');
      return;
    }
    switch (t.dataset.act) {
      case 'practice': this.cb.onPractice(); break;
      case 'create': this.cb.onCreate(); break;
      case 'join': this.show('join'); break;
      case 'rejoin': this.cb.onRejoin(); break;
      case 'dojoin': this.join(); break;
      case 'lab': this.show('lab'); break;
      case 'character': this.show('character'); break;
      case 'randomlook':
        this.settings.look = randomLook();
        saveSettings(this.settings);
        this.refreshLook(true);
        break;
      case 'dolab': this.openLab(); break;
      case 'start': this.cb.onStart(); break;
      case 'leave': this.cb.onLeave(); break;
      case 'copy':
        void navigator.clipboard?.writeText(this.lobby?.code ?? '').catch(() => {});
        t.classList.add('copied');
        break;
      case 'resume': this.cb.onResume(); break;
      case 'quit': this.cb.onQuit(); break;
      case 'main': this.show('main'); break;
      case 'loopback':
        this.meter.setLoopback(!this.meter.loopback, this.loopbackVolume());
        this.show('settings');
        break;
      case 'deathvoice':
        this.meter.previewDeath();
        this.deathPreviewEnds = performance.now() / 1000 + VOICE.death.seconds;
        this.show('settings'); // loopback may have just switched on
        break;
      case 'micnames':
        void revealMicNames().then(() => this.refreshMics());
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'settings': this.show('settings'); break;
      case 'back': this.show(this.back); break;
      case 'defaults':
        Object.assign(this.settings, structuredClone({ ...DEFAULT_SETTINGS, nickname: this.settings.nickname, turn: this.settings.turn, micDevice: this.settings.micDevice }));
        this.changed();
        this.show('settings');
        break;
    }
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.id === 'nick') {
      this.settings.nickname = t.value.trim().slice(0, 14) || 'PLAYER';
      saveSettings(this.settings);
      return;
    }
    if (t.id === 'code') {
      t.value = t.value.toUpperCase().replace(/[^A-Z]/g, '');
      return;
    }
    if (t.dataset.lobby === 'max') {
      this.cb.onMaxPlayers(Number(t.value));
      return;
    }
    if (t.dataset.loophp !== undefined) {
      this.meter.setHealth(Number(t.value));
      return;
    }
    const turnKey = t.dataset.turn as 'url' | 'username' | 'credential' | undefined;
    if (turnKey) {
      this.settings.turn[turnKey] = t.value.trim();
      saveSettings(this.settings);
      return;
    }
    const sel = t.dataset.sel as 'retro' | 'crosshair' | 'voice' | 'micDevice' | 'autoFullscreen' | undefined;
    if (sel) {
      (this.settings[sel] as string) = t.value;
      this.changed();
      if (sel === 'micDevice' || sel === 'voice') this.restartMeter();
      return;
    }
    const key = t.dataset.set as 'sensitivity' | 'fov' | 'volume' | 'voiceVolume' | 'renderScale' | 'shake' | undefined;
    if (!key) return;
    this.settings[key] = Number(t.value);
    const out = t.parentElement!.querySelector('output');
    if (out && t.type === 'range') out.textContent = t.value;
    this.changed();
    if ((key === 'volume' || key === 'voiceVolume') && this.meter.loopback) this.meter.setLoopback(true, this.loopbackVolume());
  }

  private rebindWith(e: Event, code: string): void {
    if (!this.rebinding || this.screen !== 'settings') return;
    e.preventDefault();
    e.stopPropagation();
    if (code !== 'Escape') {
      this.settings.keys[this.rebinding] = code;
      this.changed();
    }
    this.rebinding = null;
    // Re-render on the next tick so the click that completes a mouse rebind
    // does not immediately start another one.
    setTimeout(() => this.screen === 'settings' && this.show('settings'), 0);
  }

  private changed(): void {
    saveSettings(this.settings);
    this.cb.onSettingsChanged();
  }
}
