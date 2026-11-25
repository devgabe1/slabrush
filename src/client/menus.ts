import { PLAYER } from '../config/game';
import { LOOK_LABELS, LOOK_PARTS, randomLook } from '../config/looks';
import type { GameMode, RosterPlayer } from '../sim/match';
import { VOICE } from '../audio/voiceRules';
import { keyboardLockSupported, keyboardLocked, toggleFullscreen } from './fullscreen';
import { listRooms, type RoomListing } from '../net/roomDirectory';
import { MicMeter, listMics, revealMicNames, type MicDevice } from './micTest';
import { COURSES } from '../maps/parkour';
import { formatTime, loadRecords } from '../net/parkourSession';
import { ACTION_LABELS, DEFAULT_SETTINGS, keyLabel, saveSettings, type Action, type Settings } from './settings';

export type Screen = 'name' | 'main' | 'create' | 'join' | 'lab' | 'parkour' | 'character' | 'busy' | 'message' | 'lobby' | 'pause' | 'settings' | null;

export interface MenuCallbacks {
  onPractice(): void;
  onLab(seed: string, players: number): void;
  onParkour(courseId: string): void;
  onRestartRun(): void; // parkour: back to the start, clock reset
  onCreate(isPublic: boolean, mode: GameMode, course: string): void;
  onVisibility(isPublic: boolean): void; // the host changes it from the lobby
  onJoin(code: string): void;
  onRejoin(): void; // back into the match we dropped out of
  onStart(): void;
  onMaxPlayers(n: number): void;
  onMode(mode: GameMode, course: string): void; // the host picks what the room plays
  onLeave(): void; // leave lobby / cancel connecting
  onResume(): void;
  onQuit(): void; // leave the running game
  onHostPause(): void; // host: pause / resume the match
  onSettingsChanged(): void;
  onClick(): void; // UI sound + audio unlock
  /** Character screen: a picture of every option of one body part, worn with the rest of the look ([] = names only). */
  lookPictures(part: number, look: readonly number[]): string[];
  /** A picture of a parkour course (null while it is still being made). */
  coursePicture(id: string): string | null;
}

/** Screens where your character stands to the right, listening to your microphone. */
const WITH_CHARACTER: Screen[] = ['name', 'main', 'character'];

export interface LobbyInfo {
  code: string;
  players: RosterPlayer[];
  localId: number;
  isHost: boolean;
  maxPlayers: number;
  isPublic?: boolean; // the host's own room: listed or code-only
  mode: GameMode;
  course: string; // PARKOUR: a course id, or 'all'
}

/** Map lab hotkeys. Fly up / down / fast are the jump, walk and crouch bindings, so they follow the keybinds. */
const labKeys = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>N</kbd> next seed</span><span><kbd>B</kbd> previous seed</span>
  <span><kbd>R</kbd> random seed</span><span><kbd>V</kbd> fly / walk</span>
  <span><kbd>${keyLabel(k.jump)}</kbd> fly up</span><span><kbd>${keyLabel(k.walk)}</kbd> fly down</span>
  <span><kbd>${keyLabel(k.crouch)}</kbd> fly fast</span><span><kbd>P</kbd> players (2-6)</span>
  <span class="tip">Green beacons mark the spawn points. The map size follows the number of players, as in a match. Walk mode uses the real movement and physics, so you can test every jump pad, platform and door.</span>
</div>`;

/** Parkour moves, for the parkour screens. */
const parkourTips = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>${keyLabel(k.jump)}</kbd> jump / wall jump</span>
  <span><kbd>${keyLabel(k.crouch)}</kbd> crouch / slide</span>
  <span><kbd>${keyLabel(k.restart)}</kbd> restart the run</span>
  <span class="tip">Hold jump to bunny hop (each hop adds speed). Jump at a wall while fast to run along it; jump between two walls to climb. Slide under low gaps.</span>
</div>`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const css = (color: number) => '#' + color.toString(16).padStart(6, '0');

/** Main menu, lobby, pause menu and settings. Plain DOM. */
export class Menus {
  screen: Screen = null;
  /** true while in a multiplayer match: changes the pause menu wording */
  online = false;
  isHost = false;
  /** The match is paused by the host (the host's menu then offers RESUME MATCH). Set by the app. */
  matchPaused = false;
  /** A match is under way (not the lobby): the host can pause it. */
  inMatch = false;
  /** true in the map lab: the pause menu explains its hotkeys */
  lab = false;
  /** The pause menu's controls list, folded away until asked for (remembered while the page is open). */
  private keysOpen = false;
  /** true on a parkour course: the pause menu offers a restart and the course list */
  parkour = false;
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
  /** Join screen: which rooms to show. */
  private roomFilter: 'all' | GameMode = 'all';
  /** Create screen: what the new room will play. */
  private createMode: GameMode = 'battle';
  private createCourse = COURSES[0].id;
  private roomsTimer = 0;
  // Microphone picker (settings screen)
  private mics: MicDevice[] = [];
  private micsNamed = true;
  private meter = new MicMeter();
  private meterLoop = 0;

  /** `localMode`: this page uses ?local rooms (same browser), so it lists only those. */
  constructor(private root: HTMLElement, private settings: Settings, private localMode: boolean, private cb: MenuCallbacks) {
    root.addEventListener('click', (e) => this.click(e));
    root.addEventListener('toggle', (e) => { const d = e.target as HTMLElement; if (d.matches?.('details.keys')) this.keysOpen = (d as HTMLDetailsElement).open; }, true);
    root.addEventListener('input', (e) => this.input(e));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'code') this.join();
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'seed') this.openLab();
      if (e.key === 'Enter' && (e.target as HTMLElement).id === 'nick') this.setName();
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
    // Where your character shows, it listens (if the microphone is already allowed;
    // otherwise only once you ask it to), so it mouths along when you talk.
    const withChar = WITH_CHARACTER.includes(screen), hadChar = WITH_CHARACTER.includes(this.screen);
    if (withChar && !hadChar) void this.listenForPreview();
    else if (!withChar && hadChar && screen !== 'settings') this.meter.stop();
    const again = screen === this.screen;
    this.screen = screen;
    this.rebinding = null;
    // (redrawn in place, as when picking a mode: no entrance animation again)
    this.root.className = screen ? 'open ' + screen + (again ? ' still' : '') : '';
    this.root.innerHTML = this.html(screen);
    if (screen === 'join') (this.root.querySelector('#code') as HTMLInputElement).focus();
    if (screen === 'lab') (this.root.querySelector('#seed') as HTMLInputElement).focus();
    if (screen === 'name') { const n = this.root.querySelector('#nick') as HTMLInputElement; n.focus(); n.select(); }
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
      case 'name': return this.nameHtml();
      case 'create': return this.createHtml();
      case 'join': return `<div class="panel wide">
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
      case 'parkour': return this.parkourHtml();
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
      <span class="tip">Hold jump to bunny hop (each hop adds speed). Crouch while fast to slide. Two one-handed weapons: right click fires the second. An empty gun can still be thrown.</span>
    </div>`;
  }

  private main(): string {
    const voiceOk = this.settings.voice !== 'off' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
    return `<div class="panel main">
      <h1>SLABRUSH</h1>
      <p class="tag">LAST ONE STANDING TAKES THE SLAB</p>
      ${this.rejoinCode ? `<button data-act="rejoin" class="primary">REJOIN ${esc(this.rejoinCode)} <small>back into your match</small></button>` : ''}
      <button data-act="create" class="${this.rejoinCode ? '' : 'primary'}">CREATE ROOM <small>battle or parkour</small></button>
      <button data-act="join">JOIN ROOM <small>public rooms or a code</small></button>
      <button data-act="practice">PRACTICE RANGE</button>
      <button data-act="lab">MAP LAB <small>seed viewer</small></button>
      <button data-act="settings">SETTINGS</button>
      <p class="ver">v1.0 · every map, model, texture and sound is generated in code</p>
    </div>
    <div class="me">
      <div class="who"><b>${esc(this.settings.nickname)}</b><button data-act="changename">CHANGE NAME</button></div>
      <button data-act="character" class="primary">CUSTOMIZE <small>${LOOK_PARTS[0][this.settings.look[0]].toLowerCase()}</small></button>
      ${voiceOk && !this.meter.running ? '<button data-act="micpreview" class="mic">LET IT HEAR YOU <small>uses your microphone</small></button>' : ''}
    </div>`;
  }

  /** The name screen: on the very first visit, before anything else; later from CHANGE NAME. */
  private nameHtml(): string {
    const first = !this.settings.named;
    return `<div class="panel namepanel">
      <h2>${first ? 'WHAT IS YOUR NAME?' : 'CHANGE NAME'}</h2>
      <p class="note">${first ? 'This is you. Pick the name other players will see over your head.' : 'The name other players see over your head.'}</p>
      <input id="nick" class="big" maxlength="14" spellcheck="false" autocomplete="off" value="${first ? '' : esc(this.settings.nickname)}" placeholder="YOUR NAME">
      <button data-act="setname" class="primary">${first ? 'CONTINUE' : 'SAVE'}</button>
      ${first ? '' : '<button data-act="main">CANCEL</button>'}
    </div>`;
  }

  /** Save the name typed on the name screen, and on to the main menu. */
  private setName(): void {
    const field = this.root.querySelector('#nick') as HTMLInputElement | null;
    const name = field?.value.replace(/[<>&"]/g, '').trim().slice(0, 14) ?? '';
    if (!name) { field?.classList.add('need'); field?.focus(); return; }
    this.settings.nickname = name;
    this.settings.named = true;
    saveSettings(this.settings);
    this.show('main');
  }

  /** A course's picture (or, until it is made, its name on a plain card). */
  private coursePic(id: string): string {
    const url = this.cb.coursePicture(id);
    return url ? `<img data-pic="${id}" src="${url}" alt="" draggable="false">` : `<i data-pic="${id}"></i>`;
  }

  /** A course to pick: its picture, name and difficulty (and your best time when `best`). */
  private courseCard(id: string, attrs: string, on: boolean, best: boolean): string {
    const rec = loadRecords();
    if (id === 'all') {
      return `<button ${attrs} class="ccard all ${on ? 'on' : ''}" aria-pressed="${on}">
        <span class="pics">${COURSES.map((c) => this.coursePic(c.id)).join('')}</span>
        <b>ALL ${COURSES.length}</b><em>one after the other</em></button>`;
    }
    const c = COURSES.find((x) => x.id === id)!;
    return `<button ${attrs} class="ccard ${on ? 'on' : ''}" aria-pressed="${on}" title="${esc(c.name)}">
      <span class="pics">${this.coursePic(c.id)}</span>
      <b>${esc(c.name)}</b><em class="diff ${c.difficulty.toLowerCase()}">${c.difficulty}</em>
      ${best ? `<small>${rec[c.id] ? `BEST ${formatTime(rec[c.id].best)}` : 'NOT FINISHED YET'}</small>` : ''}</button>`;
  }

  /** Put the pictures that have just been made into the screen showing (without redrawing it). */
  refreshPictures(): void {
    this.root.querySelectorAll<HTMLElement>('[data-pic]').forEach((el) => {
      const url = this.cb.coursePicture(el.dataset.pic!);
      if (!url) return;
      if (el instanceof HTMLImageElement) { if (el.src !== url) el.src = url; return; }
      const img = document.createElement('img');
      img.dataset.pic = el.dataset.pic;
      img.src = url;
      img.alt = '';
      img.draggable = false;
      el.replaceWith(img);
    });
  }

  /** CREATE ROOM: what it plays (and for parkour, which course), who can find it. */
  private createHtml(): string {
    const pub = this.settings.roomVisibility !== 'private', m = this.createMode;
    const mode = (id: GameMode, name: string, what: string) =>
      `<button data-cmode="${id}" class="toggle ${m === id ? 'on' : ''}" aria-pressed="${m === id}"><b>${name}</b><small>${what}</small></button>`;
    return `<div class="panel wide create">
      <h2>CREATE ROOM</h2>
      <h3>GAME MODE</h3>
      <div class="modes">
        ${mode('battle', 'BATTLE', 'last one standing takes the slab')}
        ${mode('parkour', 'PARKOUR', 'race the obstacle courses')}
      </div>
      ${m === 'parkour' ? `<h3>COURSE</h3>
      <div class="ccards">${COURSES.map((c) => c.id).map((id) => this.courseCard(id, `data-ccourse="${id}"`, this.createCourse === id, false)).join('')}</div>` : ''}
      <h3>WHO CAN FIND IT</h3>
      <div class="modes">
        <button data-act="vis-public" class="toggle ${pub ? 'on' : ''}" aria-pressed="${pub}"><b>PUBLIC</b><small>listed under JOIN ROOM</small></button>
        <button data-act="vis-private" class="toggle ${pub ? '' : 'on'}" aria-pressed="${!pub}"><b>PRIVATE</b><small>only with the code</small></button>
      </div>
      <button data-act="docreate" class="primary">CREATE ROOM</button>
      ${m === 'parkour' ? '<button data-act="solorun">RUN IT SOLO <small>against the clock, your best times</small></button>' : ''}
      <button data-act="main">BACK</button>
      <p class="note">You can change all of it from the lobby.</p>
    </div>`;
  }

  private parkourHtml(): string {
    return `<div class="panel wide parkour">
      <h2>COURSES</h2>
      <div class="ccards">${COURSES.map((c) => this.courseCard(c.id, `data-course="${c.id}"`, false, true)).join('')}</div>
      <button data-act="${this.parkour ? 'pause' : 'main'}">BACK</button>
      ${parkourTips(this.settings.keys)}
    </div>`;
  }

  private lobbyHtml(): string {
    const l = this.lobby;
    if (!l) return '';
    const rows = l.players.map((p) =>
      `<li data-pid="${p.id}"><i style="background:${css(p.color)}"></i>${esc(p.name)}${p.id === 1 ? '<small>host</small>' : ''}${p.id === l.localId ? '<small>you</small>' : ''}${p.away ? '<small>away</small>' : ''}</li>`);
    for (let i = l.players.length; i < l.maxPlayers; i++) rows.push('<li class="open"><i></i>open slot</li>');
    const hostUi = `
      <label class="row"><span>Visibility</span><select data-lobby="vis">
        <option value="public" ${l.isPublic ? 'selected' : ''}>Public: listed under JOIN ROOM</option>
        <option value="private" ${l.isPublic ? '' : 'selected'}>Private: only with the code</option></select></label>
      <label class="row"><span>Mode</span><select data-lobby="mode">
        <option value="battle" ${l.mode === 'parkour' ? '' : 'selected'}>Battle: last one standing</option>
        <option value="parkour" ${l.mode === 'parkour' ? 'selected' : ''}>Parkour: race the courses</option></select></label>
      ${l.mode === 'parkour' ? `<label class="row"><span>Course</span><select data-lobby="course">
        ${COURSES.map((c) => `<option value="${c.id}" ${l.course === c.id ? 'selected' : ''}>${esc(c.name)} (${c.difficulty.toLowerCase()})</option>`).join('')}</select></label>` : ''}
      <label class="row"><span>Max players</span><select data-lobby="max">${[2, 3, 4, 5, 6]
        .map((n) => `<option ${n === l.maxPlayers ? 'selected' : ''} ${n < l.players.length ? 'disabled' : ''}>${n}</option>`).join('')}</select></label>
      <button data-act="start" class="primary">${l.players.length > 1 ? 'START MATCH' : 'START SOLO <small>test run</small>'}</button>`;
    return `<div class="panel">
      <h2>LOBBY</h2>
      <p class="note">Room code — share it with your friends:</p>
      <button class="code" data-act="copy" title="Click to copy">${esc(l.code)}</button>
      <ul class="roster">${rows.join('')}</ul>
      <p class="note voicestat" data-voice></p>
      ${l.mode === 'parkour' ? `<div class="ccards lobbycourse">${this.courseCard(l.course, 'disabled', true, false)}</div>` : '<p class="note">First to take 6 maps wins. A map is taken by winning 2 rounds on it. No respawns.</p>'}
      ${l.isHost ? hostUi : '<p class="note wait">Waiting for the host to start…</p>'}
      <button data-act="settings">SETTINGS</button>
      <button data-act="leave">${l.isHost ? 'CLOSE ROOM' : 'LEAVE'}</button>
    </div>`;
  }

  private pause(): string {
    const quit = !this.online ? 'QUIT TO MENU' : this.isHost ? 'CLOSE ROOM' : 'LEAVE MATCH';
    return `<div class="panel">
      <h2>${this.online ? (this.matchPaused ? 'MATCH PAUSED' : 'MENU') : 'PAUSED'}</h2>
      ${this.online ? `<p class="note">${this.matchPaused ? 'Nothing moves until the host resumes it.' : 'The match keeps running while this is open.'}</p>` : ''}
      <button data-act="resume" class="primary">${this.online ? 'PLAY' : 'RESUME'}</button>
      ${this.parkour ? `<button data-act="restartrun">RESTART RUN <small>${keyLabel(this.settings.keys.restart)}</small></button><button data-act="parkour">COURSES</button>` : ''}
      ${this.online && this.isHost && this.inMatch ? `<button data-act="hostpause">${this.matchPaused ? 'RESUME MATCH <small>for everyone</small>' : 'PAUSE MATCH <small>for everyone</small>'}</button>` : ''}
      <button data-act="settings">SETTINGS</button>
      <button data-act="quit">${quit}</button>
      <details class="keys" ${this.keysOpen ? 'open' : ''}><summary>CONTROLS</summary>
        ${this.lab ? labKeys(this.settings.keys) : this.parkour ? parkourTips(this.settings.keys) : this.controls()}
      </details>
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

  /** `ask`: the player pressed LET IT HEAR YOU (may bring up the browser's permission prompt). */
  private async listenForPreview(ask = false): Promise<void> {
    if (this.settings.voice === 'off' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    if (!ask) {
      try {
        const perm = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
        if (perm?.state !== 'granted' || !WITH_CHARACTER.includes(this.screen)) return;
      } catch {
        return; // cannot tell without asking: stay quiet
      }
    }
    await this.meter.start(this.settings.micDevice);
    if (!WITH_CHARACTER.includes(this.screen)) this.meter.stop();
    else if (this.screen === 'main') this.root.querySelector('[data-act=micpreview]')?.remove(); // it hears you now
  }

  /** Your voice's loudness while your character is on screen (0 otherwise); drives its mouth. */
  previewVoice(): number {
    return WITH_CHARACTER.includes(this.screen) && this.meter.running ? this.meter.rms() : 0;
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
    const full = PLAYER.maxHealth;
    const hp = [[full, 'full health'], [full / 2, `${full / 2} HP`], [full / 4, `${Math.round(full / 4)} HP`], [full / 10, `${full / 10} HP`], [1, '1 HP']] as const;
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
    this.roomsTimer = window.setInterval(() => void poll(), 1000); // a closed room disappears within a second
  }

  private roomsHtml(): string {
    // (No list yet, or none reachable: the filters stay, with a word that it is still looking.)
    const rooms = this.rooms ?? [];
    const f = this.roomFilter, count = (m: 'all' | GameMode) => (this.rooms ? String(rooms.filter((r) => m === 'all' || r.mode === m).length) : '…');
    const tab = (m: 'all' | GameMode, label: string) => `<button data-filter="${m}" class="tab ${f === m ? 'on' : ''}" aria-pressed="${f === m}">${label}<small>${count(m)}</small></button>`;
    const shown = rooms.filter((r) => f === 'all' || r.mode === f);
    const rows = shown.map((r) => {
      const full = r.players >= r.max, open = !full; // a match in progress can be joined too: you play from the next round
      const status = full ? 'full' : r.phase === 'playing' ? 'in progress · join' : 'open';
      const course = r.mode === 'parkour' ? (r.course === 'all' ? `all ${COURSES.length} courses` : COURSES.find((c) => c.id === r.course)?.name.toLowerCase() ?? '') : '';
      return `<button class="room" data-room="${esc(r.code)}" ${open ? '' : 'disabled'}>
        <b>${esc(r.host)}</b><em class="rmode ${r.mode}">${r.mode === 'parkour' ? 'PARKOUR' : 'BATTLE'}${course ? ` · ${esc(course)}` : ''}</em><span>${r.players}/${r.max}</span><small class="${open ? 'open' : ''}">${status}</small><code>${esc(r.code)}</code></button>`;
    });
    const none = !this.rooms ? 'Looking for public rooms… (a room code always gets you in)' : f === 'all' ? 'No public rooms right now. When someone creates one, it shows up here. Private rooms are joined with their code.'
      : `No public ${f === 'parkour' ? 'parkour' : 'battle'} rooms right now.`;
    return `<h3>PUBLIC ROOMS</h3>
      <div class="tabs filter">${tab('all', 'ALL')}${tab('battle', 'BATTLE')}${tab('parkour', 'PARKOUR')}</div>
      ${rows.length ? rows.join('') : `<p class="note">${none}</p>`}`;
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
    if (t.dataset.course) { this.cb.onParkour(t.dataset.course); return; }
    if (t.dataset.cmode) { this.createMode = t.dataset.cmode === 'parkour' ? 'parkour' : 'battle'; this.show('create'); return; }
    if (t.dataset.ccourse) { this.createCourse = t.dataset.ccourse; this.show('create'); return; }
    if (t.dataset.filter) {
      this.roomFilter = t.dataset.filter === 'battle' || t.dataset.filter === 'parkour' ? t.dataset.filter : 'all';
      const el = this.root.querySelector('[data-rooms]');
      if (el) el.innerHTML = this.roomsHtml();
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
      case 'parkour': this.show('parkour'); break;
      case 'restartrun': this.cb.onRestartRun(); break;
      case 'create': this.show('create'); break;
      case 'vis-public': case 'vis-private':
        this.settings.roomVisibility = t.dataset.act === 'vis-public' ? 'public' : 'private';
        saveSettings(this.settings);
        this.show('create');
        break;
      case 'docreate': this.cb.onCreate(this.settings.roomVisibility !== 'private', this.createMode, this.createMode === 'parkour' ? this.createCourse : 'all'); break;
      case 'solorun': this.cb.onParkour(this.createCourse); break;
      case 'setname': this.setName(); break;
      case 'changename': this.show('name'); break;
      case 'micpreview': void this.listenForPreview(true); break;
      case 'join': this.show('join'); break;
      case 'rejoin': this.cb.onRejoin(); break;
      case 'hostpause': this.cb.onHostPause(); break;
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
      case 'pause': this.show('pause'); break;
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
    if (t.id === 'nick') { t.classList.remove('need'); return; }
    if (t.id === 'code') {
      t.value = t.value.toUpperCase().replace(/[^A-Z]/g, '');
      return;
    }
    if (t.dataset.lobby === 'mode' || t.dataset.lobby === 'course') {
      const mode = (this.root.querySelector('[data-lobby=mode]') as HTMLSelectElement).value as GameMode;
      let course = (this.root.querySelector('[data-lobby=course]') as HTMLSelectElement | null)?.value ?? this.lobby?.course ?? COURSES[0].id;
      if (course === 'all') course = COURSES[0].id; // (rooms race one course at a time)
      this.cb.onMode(mode, course);
      return;
    }
    if (t.dataset.lobby === 'max') {
      this.cb.onMaxPlayers(Number(t.value));
      return;
    }
    if (t.dataset.lobby === 'vis') {
      this.settings.roomVisibility = t.value === 'private' ? 'private' : 'public';
      saveSettings(this.settings);
      this.cb.onVisibility(t.value !== 'private');
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
