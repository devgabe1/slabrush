import { LOOK_LABELS, LOOK_PARTS, randomLook } from '../config/looks';
import type { RosterPlayer } from '../sim/match';
import { ACTION_LABELS, DEFAULT_SETTINGS, keyLabel, saveSettings, type Action, type Settings } from './settings';

export type Screen = 'main' | 'join' | 'lab' | 'character' | 'busy' | 'message' | 'lobby' | 'pause' | 'settings' | null;

export interface MenuCallbacks {
  onPractice(): void;
  onLab(seed: string): void;
  onCreate(): void;
  onJoin(code: string): void;
  onStart(): void;
  onMaxPlayers(n: number): void;
  onLeave(): void; // leave lobby / cancel connecting
  onResume(): void;
  onQuit(): void; // leave the running game
  onSettingsChanged(): void;
  onClick(): void; // UI sound + audio unlock
}

export interface LobbyInfo {
  code: string;
  players: RosterPlayer[];
  localId: number;
  isHost: boolean;
  maxPlayers: number;
}

const LAB_KEYS = `<div class="controls">
  <span><kbd>N</kbd> next seed</span><span><kbd>B</kbd> previous seed</span>
  <span><kbd>R</kbd> random seed</span><span><kbd>V</kbd> fly / walk</span>
  <span><kbd>SPACE</kbd> fly up</span><span><kbd>C</kbd> fly down</span>
  <span><kbd>SHIFT</kbd> fly fast</span><span></span>
  <span class="tip">Green beacons mark the six spawn points. Walk mode uses the real movement and physics, so you can test every jump pad, platform and door.</span>
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
  private back: Screen = 'main';
  private rebinding: Action | null = null;
  private text = '';
  private lobby: LobbyInfo | null = null;

  constructor(private root: HTMLElement, private settings: Settings, private cb: MenuCallbacks) {
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
    if (screen === 'settings' && this.screen !== 'settings') this.back = this.screen;
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
        <label>ROOM CODE <input id="code" class="big" maxlength="5" spellcheck="false" autocomplete="off" placeholder="ABCDE"></label>
        <button data-act="dojoin" class="primary">JOIN</button>
        <button data-act="main">BACK</button>
      </div>`;
      case 'lab': return `<div class="panel">
        <h2>MAP LAB</h2>
        <p class="note">Every match map is built from a seed. Type one to inspect what the generator makes of it — a number, or any word. Leave it empty for a random seed.</p>
        <label>SEED <input id="seed" class="big seed" maxlength="16" spellcheck="false" autocomplete="off" placeholder="random"></label>
        <button data-act="dolab" class="primary">GENERATE</button>
        <button data-act="main">BACK</button>
        ${LAB_KEYS}
      </div>`;
      case 'character': return `<div class="panel">
        <h2>CHARACTER</h2>
        <p class="note">Mix a face, a torso and a pair of legs. It changes nothing about how you play: everyone has the same hit box. Your colour is assigned by the room.</p>
        ${LOOK_LABELS.map((label, k) => `<div class="pick"><small>${label}</small>
          <button data-look="${k}:-1" aria-label="previous ${label.toLowerCase()}">&#9664;</button>
          <b>${LOOK_PARTS[k][this.settings.look[k]]}</b>
          <button data-look="${k}:1" aria-label="next ${label.toLowerCase()}">&#9654;</button></div>`).join('')}
        <button data-act="randomlook" class="primary">RANDOMIZE</button>
        <button data-act="main">DONE</button>
        <p class="note">${LOOK_PARTS[0].length * LOOK_PARTS[1].length * LOOK_PARTS[2].length} combinations. Set it before creating or joining a room.</p>
      </div>`;
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

  private controls(): string {
    const k = this.settings.keys;
    const row = (a: Action) => `<span><kbd>${keyLabel(k[a])}</kbd> ${ACTION_LABELS[a]}</span>`;
    return `<div class="controls">
      <span><kbd>${keyLabel(k.forward)}${keyLabel(k.left)}${keyLabel(k.back)}${keyLabel(k.right)}</kbd> Move</span>
      ${(['jump', 'crouch', 'walk', 'fire', 'throw', 'use', 'swap'] as Action[]).map(row).join('')}
      <span class="tip">Hold jump to bunny hop: every hop adds speed. Steer in mid-air with the movement keys; strafe + turn to go even faster. Crouch while fast to slide. Jump again next to a wall to wall jump. Carry two one-handed weapons to hold both: left click fires one, right click the other. An empty gun is still a projectile.</span>
    </div>`;
  }

  private main(): string {
    return `<div class="panel main">
      <h1>SLABRUSH</h1>
      <p class="tag">LAST ONE STANDING TAKES THE SLAB</p>
      <label>NICKNAME <input id="nick" maxlength="14" spellcheck="false" value="${esc(this.settings.nickname)}"></label>
      <button data-act="create" class="primary">CREATE ROOM</button>
      <button data-act="join">JOIN WITH CODE</button>
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
      `<li><i style="background:${css(p.color)}"></i>${esc(p.name)}${p.id === 1 ? '<small>host</small>' : ''}${p.id === l.localId ? '<small>you</small>' : ''}</li>`);
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
      ${this.lab ? LAB_KEYS : this.controls()}
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
      <label class="row"><span>Crosshair</span><select data-sel="crosshair">${([['cross', 'Cross'], ['dot', 'Dot'], ['circle', 'Circle']] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.crosshair ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ${slider('shake', 'Screen shake', 0, 1.5, 0.1, s.shake)}
      <button data-act="fullscreen">TOGGLE FULLSCREEN</button>
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

  private openLab(): void {
    this.cb.onLab((this.root.querySelector('#seed') as HTMLInputElement).value);
  }

  private join(): void {
    const code = (this.root.querySelector('#code') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length === 5) this.cb.onJoin(code);
  }

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('button');
    if (!t || t.disabled) return;
    this.cb.onClick();
    const look = t.dataset.look;
    if (look) {
      // step one slot forwards or backwards, wrapping round
      const [k, step] = look.split(':').map(Number);
      const n = LOOK_PARTS[k].length;
      this.settings.look[k] = (this.settings.look[k] + step + n) % n;
      saveSettings(this.settings);
      this.show('character');
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
      case 'dojoin': this.join(); break;
      case 'lab': this.show('lab'); break;
      case 'character': this.show('character'); break;
      case 'randomlook':
        this.settings.look = randomLook();
        saveSettings(this.settings);
        this.show('character');
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
      case 'fullscreen':
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 'settings': this.show('settings'); break;
      case 'back': this.show(this.back); break;
      case 'defaults':
        Object.assign(this.settings, structuredClone({ ...DEFAULT_SETTINGS, nickname: this.settings.nickname, turn: this.settings.turn }));
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
    const turnKey = t.dataset.turn as 'url' | 'username' | 'credential' | undefined;
    if (turnKey) {
      this.settings.turn[turnKey] = t.value.trim();
      saveSettings(this.settings);
      return;
    }
    const sel = t.dataset.sel as 'retro' | 'crosshair' | undefined;
    if (sel) {
      (this.settings[sel] as string) = t.value;
      this.changed();
      return;
    }
    const key = t.dataset.set as 'sensitivity' | 'fov' | 'volume' | 'renderScale' | 'shake' | undefined;
    if (!key) return;
    this.settings[key] = Number(t.value);
    const out = t.parentElement!.querySelector('output');
    if (out && t.type === 'range') out.textContent = t.value;
    this.changed();
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
