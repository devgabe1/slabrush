import { BOT_LEVELS, BOT_LEVEL_NAMES, type BotLevel } from '../config/bots';
import { PLAYER } from '../config/game';
import type { Icon, InvEntry } from '../maps/editor';
import type { HotbarSlot } from '../net/session';
import { LOOK_LABELS, LOOK_PARTS, randomLook } from '../config/looks';
import type { GameMode, RosterPlayer } from '../sim/match';
import { VOICE } from '../audio/voiceRules';
import { keyboardLockSupported, keyboardLocked, toggleFullscreen } from './fullscreen';
import { listRooms, type RoomListing } from '../net/roomDirectory';
import { MicMeter, listMics, revealMicNames, type MicDevice } from './micTest';
import { COURSES } from '../maps/parkour';
import type { MapFile, MapKind } from '../maps/mapFile';
import { loadMaps } from './myMaps';
import { formatTime, loadRecords } from '../net/parkourSession';
import { ACTION_LABELS, DEFAULT_SETTINGS, keyLabel, saveSettings, type Action, type Settings } from './settings';
import { LANGS, LANG_NAMES, getLang, setLang, t, type Lang } from '../core/i18n';

export type Screen = 'inventory' | 'name' | 'main' | 'create' | 'join' | 'lab' | 'labgen' | 'labbuild' | 'parkour' | 'character' | 'busy' | 'message' | 'lobby' | 'pause' | 'settings' | null;

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
  onBots(count: number, level: BotLevel): void; // BATTLE: the host fills seats with bots
  onMode(mode: GameMode, course: string): void; // the host picks what the room plays
  onLeave(): void; // leave lobby / cancel connecting
  onResume(): void;
  onQuit(): void; // leave the running game
  onHostPause(): void; // host: pause / resume the match
  onSettingsChanged(): void;
  onLanguage(): void; // the interface language changed: the HUD relabels itself
  onClick(): void; // UI sound + audio unlock
  /** Map lab, building your own: a new map, one of yours (saved or a file), and what to do with the one being edited. */
  onNewMap(kind: MapKind): void;
  onOpenMap(f: MapFile): void;
  onDeleteMap(id: string): void;
  onImportMap(file: File): void;
  onMapAction(act: 'save' | 'download' | 'test' | 'submit' | 'back'): void;
  onMapName(name: string): void;
  /** Map editor's inventory: everything that can go in the slot in hand, the hotbar, and what clicking does. */
  inventory(): InvEntry[];
  hotbar(): HotbarSlot[];
  onInventory(): void; // an entry was clicked (and applied)
  onSlot(i: number): void;
  /** A picture of an inventory item ('' if none can be made). */
  itemPicture(icon: Icon): string;
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
  botLevel: BotLevel; // BATTLE: how well the room's bots play (the host's choice, even with no bots yet)
}

/** Map lab hotkeys. Fly up / down / fast are the jump, walk and crouch bindings, so they follow the keybinds. */
const labKeys = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>N</kbd> ${t('next seed')}</span><span><kbd>B</kbd> ${t('previous seed')}</span>
  <span><kbd>R</kbd> ${t('random seed')}</span><span><kbd>V</kbd> ${t('fly / walk')}</span>
  <span><kbd>${keyLabel(k.jump)}</kbd> ${t('fly up')}</span><span><kbd>${keyLabel(k.walk)}</kbd> ${t('fly down')}</span>
  <span><kbd>${keyLabel(k.crouch)}</kbd> ${t('fly fast')}</span><span><kbd>P</kbd> ${t('players (2-6)')}</span>
  <span class="tip">${t('Green beacons mark the spawn points. The map size follows the number of players, as in a match. Walk mode uses the real movement and physics, so you can test every jump pad, platform and door.')}</span>
</div>`;

/** Map editor controls. */
const editKeys = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>E</kbd> ${t('inventory: everything you can place')}</span><span><kbd>1</kbd>-<kbd>9</kbd> / <kbd>${t('WHEEL')}</kbd> ${t('hotbar slot')}</span>
  <span><kbd>${t('LMB')}</kbd> ${t('place')}</span><span><kbd>${t('RMB')}</kbd> ${t('remove what is outlined in red')}</span><span><kbd>${t('MMB')}</kbd> ${t('copy the block you aim at')}</span>
  <span><kbd>R</kbd> ${t('turn the block')}</span><span><kbd>SHIFT</kbd>+<kbd>${t('WHEEL')}</kbd> ${t('taller / flatter')}</span>
  <span><kbd>CTRL</kbd>+<kbd>Z</kbd> ${t('undo')}</span><span><kbd>V</kbd> ${t('fly / walk')}</span>
  <span><kbd>${keyLabel(k.jump)}</kbd> ${t('fly up')}</span><span><kbd>${keyLabel(k.walk)}</kbd> ${t('fly down')}</span>
  <span class="tip">${t('What you place is what is in the hotbar slot in hand. Open the inventory (E), pick a slot, and click a block (by material), a shape, a hazard, a spawn point, a weapon spot (any weapon, or random) or a zone to put it there; the map\'s look is chosen there too. Blocks join up with the one you aim at; aimed at a ramp, the next ramp carries on from its top. A battle map needs at least 2 spawn points; a parkour map a START and a FINISH, with checkpoints between, numbered in the order you place them.')}</span>
</div>`;

/** Parkour moves, for the parkour screens. */
const parkourTips = (k: Settings['keys']) => `<div class="controls">
  <span><kbd>${keyLabel(k.jump)}</kbd> ${t('jump / wall jump')}</span>
  <span><kbd>${keyLabel(k.crouch)}</kbd> ${t('crouch / slide')}</span>
  <span><kbd>${keyLabel(k.restart)}</kbd> ${t('restart the run')}</span>
  <span class="tip">${t('Hold jump to bunny hop (each hop adds speed). Jump at a wall while fast to run along it; jump between two walls to climb. Slide under low gaps.')}</span>
</div>`;

/** The flags of the two languages (drawn, not pictures: small and sharp at any size). */
const FLAG_BR = `<svg viewBox="0 0 40 28" aria-hidden="true"><rect width="40" height="28" fill="#009c3b"/><path d="M20 2.5 L37.5 14 L20 25.5 L2.5 14 Z" fill="#ffdf00"/><circle cx="20" cy="14" r="6.4" fill="#002776"/><path d="M13.9 12.4 Q20 16.6 26.1 11.4" stroke="#fff" stroke-width="1.3" fill="none"/></svg>`;
const FLAG_US = `<svg viewBox="0 0 40 28" aria-hidden="true"><rect width="40" height="28" fill="#fff"/><g fill="#b22234"><rect y="0" width="40" height="2.15"/><rect y="4.3" width="40" height="2.15"/><rect y="8.6" width="40" height="2.15"/><rect y="12.9" width="40" height="2.15"/><rect y="17.2" width="40" height="2.15"/><rect y="21.5" width="40" height="2.15"/><rect y="25.8" width="40" height="2.2"/></g><rect width="16" height="15.1" fill="#3c3b6e"/><pattern id="usstars" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".55" fill="#fff"/><circle cx="3" cy="3" r=".55" fill="#fff"/></pattern><rect width="16" height="15.1" fill="url(#usstars)"/></svg>`;
const FLAG: Record<Lang, string> = { pt: FLAG_BR, en: FLAG_US };

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
  /** The map being built in the map lab (null when not editing), what it still lacks, and a word on the last action. */
  editing: MapFile | null = null;
  editProblem = '';
  editNote = '';
  /** Running a test of the map being built (a parkour course): the menu offers the way back to the editor. */
  testing = false;
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
    if (screen === 'labgen') (this.root.querySelector('#seed') as HTMLInputElement).focus();
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
        <h2>${t('JOIN ROOM')}</h2>
        <div class="rooms" data-rooms>${this.roomsHtml()}</div>
        <label>${t('ROOM CODE')} <input id="code" class="big" maxlength="5" spellcheck="false" autocomplete="off" placeholder="ABCDE"></label>
        <button data-act="dojoin" class="primary">${t('JOIN')}</button>
        <button data-act="main">${t('BACK')}</button>
      </div>`;
      case 'lab': return `<div class="panel lab">
        <h2>${t('MAP LAB')}</h2>
        <button data-act="labbuild" class="choice primary"><b>${t('BUILD YOUR OWN MAP')}</b><span>${t('Make a battle or parkour map by hand, block by block; test it, save it, send it in for the rotation.')}</span></button>
        <button data-act="labgen" class="choice"><b>${t('EXPLORE GENERATED MAPS')}</b><span>${t('See what the game\'s map generator makes of a seed, and fly or walk round it.')}</span></button>
        <button data-act="main">${t('BACK')}</button>
      </div>`;
      case 'labbuild': return `<div class="panel lab">
        <h2>${t('BUILD YOUR OWN')}</h2>
        <h3>${t('START A NEW MAP')}</h3>
        <div class="rowbtn"><button data-newmap="battle" class="choice"><b>${t('BATTLE MAP')}</b><span>${t('spawn points, weapons, cover')}</span></button><button data-newmap="parkour" class="choice"><b>${t('PARKOUR MAP')}</b><span>${t('a course: start, checkpoints, finish')}</span></button></div>
        <h3>${t('YOUR MAPS')}</h3>
        ${this.myMapsHtml()}
        <label class="filebtn"><input type="file" id="mapfile" accept=".json,application/json" hidden><span>${t('IMPORT A MAP FILE')}</span></label>
        ${this.editNote ? `<p class="note" data-labnote>${esc(this.editNote)}</p>` : ''}
        <button data-act="lab">${t('BACK')}</button>
      </div>`;
      case 'labgen': return `<div class="panel lab">
        <h2>${t('GENERATED MAPS')}</h2>
        <p class="note">${t('Every match map is built from a seed. Type one to inspect what the generator makes of it — a number, or any word. Leave it empty for a random seed.')}</p>
        <label>${t('SEED')} <input id="seed" class="big seed" maxlength="16" spellcheck="false" autocomplete="off" placeholder="${t('random')}"></label>
        <label class="row"><span>${t('Players')}</span><select id="labplayers">${[2, 3, 4, 5, 6]
          .map((n) => `<option ${n === this.labPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <p class="note">${t('The map size is picked as a match with that many players would pick it: few players, mostly small maps.')}</p>
        <button data-act="dolab" class="primary">${t('GENERATE')}</button>
        <button data-act="lab">${t('BACK')}</button>
        ${labKeys(this.settings.keys)}
      </div>`;
      case 'parkour': return this.parkourHtml();
      case 'character': return this.characterHtml();
      case 'busy': return `<div class="panel"><h2>${esc(this.text)}</h2><p class="note">${t('Setting up a direct connection…')}</p>
        <button data-act="leave">${t('CANCEL')}</button></div>`;
      case 'message': return `<div class="panel"><h2>${t('HOLD ON')}</h2><p class="note big">${esc(this.text)}</p>
        <button data-act="main" class="primary">${t('BACK TO MENU')}</button></div>`;
      case 'lobby': return this.lobbyHtml();
      case 'pause': return this.pause();
      case 'settings': return this.settingsHtml();
      case 'inventory': return this.inventoryHtml();
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
      <h2>${t('CHARACTER')}</h2>
      <div class="tabs" role="tablist">${this.lookTabsHtml()}</div>
      ${this.lookOptionsHtml()}
      <p class="note">${t('{n} combinations. Cosmetic only: everyone has the same hit box, and your colour is assigned by the room. Set it before creating or joining a room.', { n: LOOK_PARTS[0].length * LOOK_PARTS[1].length * LOOK_PARTS[2].length })}</p>
      <div class="rowbtn"><button data-act="randomlook">${t('RANDOMIZE')}</button><button data-act="main" class="primary">${t('DONE')}</button></div>
    </div>`;
  }

  private lookTabsHtml(): string {
    const look = this.settings.look;
    return LOOK_LABELS.map((label, i) =>
      `<button data-tab="${i}" class="tab ${i === this.lookTab ? 'on' : ''}" aria-pressed="${i === this.lookTab}">${t(label)}<small>${t(LOOK_PARTS[i][look[i]]).toLowerCase()}</small></button>`).join('');
  }

  private lookOptionsHtml(): string {
    const look = this.settings.look;
    const k = this.lookTab;
    const pics = this.cb.lookPictures(k, look);
    const options = LOOK_PARTS[k].map((name, i) =>
      `<button data-look="${k}:${i}" class="option ${i === look[k] ? 'on' : ''}" aria-pressed="${i === look[k]}" title="${t(name)}">
        ${pics[i] ? `<img src="${pics[i]}" alt="" draggable="false">` : ''}<span>${t(name)}</span></button>`).join('');
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
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild!;
  }

  private controls(): string {
    const k = this.settings.keys;
    const row = (a: Action) => `<span><kbd>${keyLabel(k[a])}</kbd> ${t(ACTION_LABELS[a])}</span>`;
    return `<div class="controls">
      <span><kbd>${keyLabel(k.forward)}${keyLabel(k.left)}${keyLabel(k.back)}${keyLabel(k.right)}</kbd> ${t('Move')}</span>
      ${(['jump', 'crouch', 'duck', 'walk', 'fire', 'fire2', 'throw', 'use', 'swap', 'talk'] as Action[]).map(row).join('')}
      <span class="tip">${t('Hold jump to bunny hop (each hop adds speed). Crouch while fast to slide. Two one-handed weapons: right click fires the second. An empty gun can still be thrown.')}</span>
    </div>`;
  }

  /** The flag button: shows the language you are in now; a click switches to the other one. */
  private langButton(): string {
    const lang = getLang(), other = LANGS.find((l) => l !== lang)!;
    return `<button data-act="lang" class="langbtn" title="${esc(LANG_NAMES[other])}" aria-label="${esc(LANG_NAMES[other])}">${FLAG[lang]}</button>`;
  }

  private main(): string {
    const voiceOk = this.settings.voice !== 'off' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
    return `${this.langButton()}<div class="panel main">
      <h1>SLABRUSH</h1>
      <p class="tag">${t('LAST ONE STANDING TAKES THE SLAB')}</p>
      ${this.rejoinCode ? `<button data-act="rejoin" class="primary">${t('REJOIN {code}', { code: esc(this.rejoinCode) })} <small>${t('back into your match')}</small></button>` : ''}
      <button data-act="create" class="${this.rejoinCode ? '' : 'primary'}">${t('CREATE ROOM')} <small>${t('battle or parkour')}</small></button>
      <button data-act="join">${t('JOIN ROOM')} <small>${t('public rooms or a code')}</small></button>
      <button data-act="practice">${t('PRACTICE RANGE')}</button>
      <button data-act="lab">${t('MAP LAB')} <small>${t('seed viewer')}</small></button>
      <button data-act="settings">${t('SETTINGS')}</button>
      <p class="ver">${t('v1.0 · every map, model, texture and sound is generated in code')}</p>
    </div>
    <div class="me">
      <div class="who"><b>${esc(this.settings.nickname)}</b><button data-act="changename">${t('CHANGE NAME')}</button></div>
      <button data-act="character" class="primary">${t('CUSTOMIZE')} <small>${t(LOOK_PARTS[0][this.settings.look[0]]).toLowerCase()}</small></button>
      ${voiceOk && !this.meter.running ? `<button data-act="micpreview" class="mic">${t('LET IT HEAR YOU')} <small>${t('uses your microphone')}</small></button>` : ''}
    </div>`;
  }

  /** The name screen: on the very first visit, before anything else; later from CHANGE NAME. */
  private nameHtml(): string {
    const first = !this.settings.named;
    return `<div class="panel namepanel">
      <h2>${first ? t('WHAT IS YOUR NAME?') : t('CHANGE NAME')}</h2>
      <p class="note">${first ? t('This is you. Pick the name other players will see over your head.') : t('The name other players see over your head.')}</p>
      <input id="nick" class="big" maxlength="14" spellcheck="false" autocomplete="off" value="${first ? '' : esc(this.settings.nickname)}" placeholder="${t('YOUR NAME')}">
      <button data-act="setname" class="primary">${first ? t('CONTINUE') : t('SAVE')}</button>
      ${first ? '' : `<button data-act="main">${t('CANCEL')}</button>`}
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
        <b>${t('ALL {n}', { n: COURSES.length })}</b><em>${t('one after the other')}</em></button>`;
    }
    const c = COURSES.find((x) => x.id === id)!;
    return `<button ${attrs} class="ccard ${on ? 'on' : ''}" aria-pressed="${on}" title="${esc(t(c.name))}">
      <span class="pics">${this.coursePic(c.id)}</span>
      <b>${esc(t(c.name))}</b><em class="diff ${c.difficulty.toLowerCase()}">${t(c.difficulty)}</em>
      ${best ? `<small>${rec[c.id] ? t('BEST {time}', { time: formatTime(rec[c.id].best) }) : t('NOT FINISHED YET')}</small>` : ''}</button>`;
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
      <h2>${t('CREATE ROOM')}</h2>
      <h3>${t('GAME MODE')}</h3>
      <div class="modes">
        ${mode('battle', t('BATTLE'), t('last one standing takes the slab'))}
        ${mode('parkour', t('PARKOUR'), t('race the obstacle courses'))}
      </div>
      ${m === 'parkour' ? `<h3>${t('COURSE')}</h3>
      <div class="ccards">${COURSES.map((c) => c.id).map((id) => this.courseCard(id, `data-ccourse="${id}"`, this.createCourse === id, false)).join('')}</div>` : ''}
      <h3>${t('WHO CAN FIND IT')}</h3>
      <div class="modes">
        <button data-act="vis-public" class="toggle ${pub ? 'on' : ''}" aria-pressed="${pub}"><b>${t('PUBLIC')}</b><small>${t('listed under JOIN ROOM')}</small></button>
        <button data-act="vis-private" class="toggle ${pub ? '' : 'on'}" aria-pressed="${!pub}"><b>${t('PRIVATE')}</b><small>${t('only with the code')}</small></button>
      </div>
      <button data-act="docreate" class="primary">${t('CREATE ROOM')}</button>
      ${m === 'parkour' ? `<button data-act="solorun">${t('RUN IT SOLO')} <small>${t('against the clock, your best times')}</small></button>` : ''}
      <button data-act="main">${t('BACK')}</button>
      <p class="note">${t('You can change all of it from the lobby.')}</p>
    </div>`;
  }

  private parkourHtml(): string {
    return `<div class="panel wide parkour">
      <h2>${t('COURSES')}</h2>
      <div class="ccards">${COURSES.map((c) => this.courseCard(c.id, `data-course="${c.id}"`, false, true)).join('')}</div>
      <button data-act="${this.parkour ? 'pause' : 'main'}">${t('BACK')}</button>
      ${parkourTips(this.settings.keys)}
    </div>`;
  }

  private lobbyHtml(): string {
    const l = this.lobby;
    if (!l) return '';
    const rows = l.players.map((p) =>
      `<li data-pid="${p.id}"><i style="background:${css(p.color)}"></i>${esc(p.name)}${p.id === 1 ? `<small>${t('host')}</small>` : ''}${p.id === l.localId ? `<small>${t('you')}</small>` : ''}${p.away ? `<small>${t('away')}</small>` : ''}${p.bot ? `<small class="bot">${t('BOT')} · ${t(BOT_LEVEL_NAMES[p.bot] ?? '')}</small>` : ''}</li>`);
    const humans = l.players.filter((p) => !p.bot).length;
    const bots = l.players.length - humans;
    const botUi = l.mode === 'parkour' ? '' : `
      <label class="row"><span>${t('Bots')}</span><select data-lobby="bots">${Array.from({ length: l.maxPlayers - humans + 1 }, (_, n) =>
        `<option value="${n}" ${n === bots ? 'selected' : ''}>${n === 0 ? t('None') : n}</option>`).join('')}</select></label>
      <label class="row"><span>${t('Bot difficulty')}</span><select data-lobby="botlevel">${BOT_LEVELS.map((v) =>
        `<option value="${v}" ${v === l.botLevel ? 'selected' : ''}>${t(BOT_LEVEL_NAMES[v])}</option>`).join('')}</select></label>`;
    for (let i = l.players.length; i < l.maxPlayers; i++) rows.push(`<li class="open"><i></i>${t('open slot')}</li>`);
    // (The host's settings sit in two columns, so the waiting room stays within one window.)
    const hostUi = `<div class="lobbyform">
      <label class="row"><span>${t('Visibility')}</span><select data-lobby="vis">
        <option value="public" ${l.isPublic ? 'selected' : ''}>${t('Public: listed under JOIN ROOM')}</option>
        <option value="private" ${l.isPublic ? '' : 'selected'}>${t('Private: only with the code')}</option></select></label>
      <label class="row"><span>${t('Mode')}</span><select data-lobby="mode">
        <option value="battle" ${l.mode === 'parkour' ? '' : 'selected'}>${t('Battle: last one standing')}</option>
        <option value="parkour" ${l.mode === 'parkour' ? 'selected' : ''}>${t('Parkour: race the courses')}</option></select></label>
      ${l.mode === 'parkour' ? `<label class="row"><span>${t('Course')}</span><select data-lobby="course">
        ${COURSES.map((c) => `<option value="${c.id}" ${l.course === c.id ? 'selected' : ''}>${esc(t(c.name))} (${t(c.difficulty).toLowerCase()})</option>`).join('')}</select></label>` : ''}
      <label class="row"><span>${t('Max players')}</span><select data-lobby="max">${[2, 3, 4, 5, 6]
        .map((n) => `<option ${n === l.maxPlayers ? 'selected' : ''} ${n < humans ? 'disabled' : ''}>${n}</option>`).join('')}</select></label>${botUi}</div>
      <button data-act="start" class="primary">${l.players.length > 1 ? t('START MATCH') : `${t('START SOLO')} <small>${t('test run')}</small>`}</button>`;
    return `<div class="panel lobby">
      <h2>${t('LOBBY')}</h2>
      <p class="note">${t('Room code — share it with your friends:')}</p>
      <button class="code" data-act="copy" title="${t('Click to copy')}">${esc(l.code)}</button>
      <ul class="roster">${rows.join('')}</ul>
      <p class="note voicestat" data-voice></p>
      ${l.mode === 'parkour' ? `<div class="ccards lobbycourse">${this.courseCard(l.course, 'disabled', true, false)}</div>` : `<p class="note">${t('First to take 6 maps wins. A map is taken by winning 2 rounds on it. No respawns.')}</p>`}
      ${l.isHost ? hostUi : `<p class="note wait">${t('Waiting for the host to start…')}</p>`}
      <div class="rowbtn"><button data-act="settings">${t('SETTINGS')}</button>
      <button data-act="leave">${l.isHost ? t('CLOSE ROOM') : t('LEAVE')}</button></div>
    </div>`;
  }

  /** Your saved maps, on the map lab screen: open one to keep building it, or delete it. */
  private myMapsHtml(): string {
    const maps = loadMaps();
    if (!maps.length) return `<p class="note">${t('Maps you build are saved in this browser and listed here.')}</p>`;
    return `<div class="mymaps">${maps.map((f) => `<div class="mymap"><button data-openmap="${esc(f.id)}"><b>${esc(f.name)}</b><small>${f.kind} · ${f.map.solids.length} ${t('blocks')}</small></button><button data-delmap="${esc(f.id)}" title="${t('Delete')}" aria-label="${t('Delete {name}', { name: esc(f.name) })}">×</button></div>`).join('')}</div>`;
  }

  /** Redraw the inventory in place, keeping where it is scrolled to. */
  private refreshInventory(): void {
    const panel = this.root.querySelector('.panel'), top = panel?.scrollTop ?? 0;
    this.show('inventory');
    const again = this.root.querySelector('.panel');
    if (again) again.scrollTop = top;
  }

  /** The map editor's inventory (E): the hotbar on top (click a slot to fill it), then everything that can go in it. */
  private inventoryHtml(): string {
    const entries = this.cb.inventory(), slots = this.cb.hotbar();
    const groups = [...new Set(entries.map((x) => x.group))];
    const pic = (icon: Icon, swatch?: string) => { const url = this.cb.itemPicture(icon); return url ? `<img src="${url}" alt="" draggable="false">` : swatch ? `<i style="background:${swatch}"></i>` : ''; };
    // (The editor's names are English; a word it knows is translated here, the rest stays as it is.)
    const card = (x: InvEntry, i: number) => `<button data-inv="${i}" class="invitem ${x.on ? 'on' : ''}" aria-pressed="${x.on}" title="${esc(t(x.label))}">
      ${pic(x.icon, x.swatch)}<b>${esc(t(x.label))}</b>${x.sub ? `<small>${esc(t(x.sub))}</small>` : ''}</button>`;
    return `<div class="panel wide inventory">
      <h2>${t('INVENTORY')}</h2>
      <p class="note">${t('Pick a slot, then click what goes in it. Then <b>E</b> (or DONE) to build with it: <b>1</b>-<b>9</b> or the wheel switch slots.')}</p>
      <div class="hotbar">${slots.map((sl, i) => `<button data-slot="${i}" class="${sl.on ? 'on' : ''}" aria-pressed="${sl.on}"><kbd>${i + 1}</kbd>${sl.pic ? `<img src="${sl.pic}" alt="" draggable="false">` : sl.swatch ? `<i style="background:${sl.swatch}"></i>` : ''}<b>${esc(sl.label)}</b>${sl.sub ? `<small>${esc(sl.sub)}</small>` : ''}</button>`).join('')}</div>
      ${groups.map((g) => `<h3>${esc(t(g))}</h3><div class="invgrid">${entries.map((x, i) => (x.group === g ? card(x, i) : '')).join('')}</div>`).join('')}
      <button data-act="resume" class="primary">${t('DONE')} <small>E</small></button>
    </div>`;
  }

  /** The menu while building a map: its name, and what to do with it. */
  private editHtml(): string {
    const f = this.editing!, ready = !this.editProblem;
    return `<div class="panel editpanel">
      <h2>${t('MAP EDITOR')}</h2>
      <label>${t('NAME')} <input id="mapname" class="big" maxlength="24" spellcheck="false" autocomplete="off" value="${esc(f.name)}"></label>
      <button data-act="resume" class="primary">${t('KEEP BUILDING')}</button>
      <div class="rowbtn"><button data-mapact="save">${t('SAVE')}</button><button data-mapact="download" ${ready ? '' : 'disabled'}>${t('DOWNLOAD')}</button></div>
      <button data-mapact="test" ${ready ? '' : 'disabled'}>${t('TEST IT')} <small>${f.kind === 'parkour' ? t('run the course') : t('walk it (V flies again)')}</small></button>
      <button data-mapact="submit" ${ready ? '' : 'disabled'}>${t('SUBMIT')} <small>${t('for the map rotation')}</small></button>
      <p class="note">${ready ? esc(this.editNote) || t('Saved maps stay in this browser. SUBMIT sends the map in to be added to the game.') : `${t('Not ready to test, download or submit yet:')} ${esc(this.editProblem)}`}</p>
      <button data-act="settings">${t('SETTINGS')}</button>
      <button data-act="quit">${t('QUIT TO MENU')} <small>${t('saves it')}</small></button>
      <details class="keys" ${this.keysOpen ? 'open' : ''}><summary>${t('CONTROLS')}</summary>${editKeys(this.settings.keys)}</details>
    </div>`;
  }

  private pause(): string {
    if (this.editing && !this.testing) return this.editHtml();
    const quit = !this.online ? t('QUIT TO MENU') : this.isHost ? t('CLOSE ROOM') : t('LEAVE MATCH');
    return `<div class="panel">
      <h2>${this.online ? (this.matchPaused ? t('MATCH PAUSED') : t('MENU')) : t('PAUSED')}</h2>
      ${this.online ? `<p class="note">${this.matchPaused ? t('Nothing moves until the host resumes it.') : t('The match keeps running while this is open.')}</p>` : ''}
      <button data-act="resume" class="primary">${this.online ? t('PLAY') : t('RESUME')}</button>
      ${this.parkour ? `<button data-act="restartrun">${t('RESTART RUN')} <small>${keyLabel(this.settings.keys.restart)}</small></button><button data-act="parkour">${t('COURSES')}</button>` : ''}
      ${this.online && this.isHost && this.inMatch ? `<button data-act="hostpause">${this.matchPaused ? `${t('RESUME MATCH')} <small>${t('for everyone')}</small>` : `${t('PAUSE MATCH')} <small>${t('for everyone')}</small>`}</button>` : ''}
      <button data-act="settings">${t('SETTINGS')}</button>
      <button data-act="quit">${this.testing ? t('BACK TO THE EDITOR') : quit}</button>
      <details class="keys" ${this.keysOpen ? 'open' : ''}><summary>${t('CONTROLS')}</summary>
        ${this.lab ? labKeys(this.settings.keys) : this.parkour ? parkourTips(this.settings.keys) : this.controls()}
      </details>
    </div>`;
  }

  /** Settings' two tabs: 0 = GENERAL, 1 = CONTROLS. */
  private settingsTab = 0;

  private settingsTabsHtml(): string {
    return [[0, t('GENERAL')], [1, t('CONTROLS')]].map(([i, label]) =>
      `<button data-stab="${i}" class="tab ${i === this.settingsTab ? 'on' : ''}" aria-pressed="${i === this.settingsTab}">${label}</button>`).join('');
  }

  private settingsHtml(): string {
    const s = this.settings;
    const slider = (id: string, label: string, min: number, max: number, step: number, val: number) =>
      `<label class="row"><span>${label}</span><input type="range" data-set="${id}" min="${min}" max="${max}" step="${step}" value="${val}"><output>${val}</output></label>`;
    const scales: [number, string][] = [[1, t('100% (sharp)')], [0.75, '75%'], [0.5, t('50% (retro)')], [0.33, t('33% (crunchy)')], [0.25, t('25% (1998)')]];
    const turn = (key: 'url' | 'username' | 'credential', label: string, ph: string) =>
      `<label class="row"><span>${label}</span><input type="text" data-turn="${key}" spellcheck="false" autocomplete="off" placeholder="${ph}" value="${esc(s.turn[key])}"></label>`;
    // Two tabs, so each one fits a window: GENERAL (the game and sound) and CONTROLS (the keys and the network).
    return `<div class="panel wide settings">
      <h2>${t('SETTINGS')}</h2>
      <div class="tabs" role="tablist">${this.settingsTabsHtml()}</div>
      ${this.settingsTab === 0 ? `
      <label class="row"><span>${t('Language')}</span><select data-sel="lang">${LANGS
        .map((l) => `<option value="${l}" ${l === getLang() ? 'selected' : ''}>${esc(LANG_NAMES[l])}</option>`).join('')}</select><output></output></label>
      ${slider('sensitivity', t('Mouse sensitivity'), 0.1, 4, 0.05, s.sensitivity)}
      ${slider('fov', t('Field of view'), 70, 130, 1, s.fov)}
      ${slider('volume', t('Volume'), 0, 1, 0.05, s.volume)}
      <label class="row"><span>${t('Render resolution')}</span><select data-set="renderScale">${scales
        .map(([v, l]) => `<option value="${v}" ${v === s.renderScale ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      <label class="row"><span>${t('Retro filter')}</span><select data-sel="retro">${([['dither', t('Dithered colour (default)')], ['crt', t('Dither + scanlines')], ['off', t('Off (clean)')]] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.retro ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      <label class="row"><span>${t('Voice chat')}</span><select data-sel="voice">${([['open', t('Open mic (default)')], ['ptt', `${t('Push to talk')} (${keyLabel(s.keys.talk)})`], ['off', t('Off')]] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.voice ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ${slider('voiceVolume', t('Voice volume'), 0, 2, 0.05, s.voiceVolume)}
      ${this.micHtml()}
      <label class="row"><span>${t('Crosshair')}</span><select data-sel="crosshair">${([['cross', t('Cross')], ['dot', t('Dot')], ['circle', t('Circle')]] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.crosshair ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ${slider('shake', t('Screen shake'), 0, 1.5, 0.1, s.shake)}
      <label class="row"><span>${t('Fullscreen when playing')}</span><select data-sel="autoFullscreen">${([['off', t('Off')], ['on', t('On (recommended to crouch with Ctrl)')]] as const)
        .map(([v, l]) => `<option value="${v}" ${v === s.autoFullscreen ? 'selected' : ''}>${l}</option>`).join('')}</select><output></output></label>
      ` : ''}
      ${this.settingsTab === 1 ? `
      <button data-act="fullscreen">${t('TOGGLE FULLSCREEN')}</button>
      <p class="note">${keyboardLockSupported
        ? `${t('In fullscreen, browser shortcuts like Ctrl+W, Ctrl+T and Ctrl+N go to the game instead, so Ctrl is safe to bind (e.g. to crouch). Esc still opens the menu.')}${keyboardLocked ? ` <b class="ok">${t('Captured right now.')}</b>` : ''}`
        : t('This browser cannot capture shortcuts like Ctrl+W, even in fullscreen (Chrome and Edge can). During online matches, closing the tab asks first.')}</p>
      <h3>${t('KEYBINDS')} <small>${t('click, then press a key or mouse button (Esc cancels)')}</small></h3>
      <div class="binds">${(Object.keys(ACTION_LABELS) as Action[])
        .map((a) => `<label>${t(ACTION_LABELS[a])}<button data-bind="${a}" class="${this.rebinding === a ? 'listening' : ''}">${
          this.rebinding === a ? `${t('press')}…` : keyLabel(s.keys[a])}</button></label>`).join('')}</div>
      <h3>${t('TURN SERVER')} <small>${t('optional — only if someone cannot connect (strict NAT / firewall). Used for the next room.')}</small></h3>
      ${turn('url', 'URL', 'turn:example.com:3478')}
      ${turn('username', t('Username'), '')}
      ${turn('credential', t('Password'), '')}
      ` : ''}
      <div class="rowbtn"><button data-act="defaults">${t('RESET DEFAULTS')}</button><button data-act="back" class="primary">${t('BACK')}</button></div>
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
      const text = this.settings.voice === 'off' ? t('voice off') : this.meter.error
        || (dying ? `${t('death voice')}…` : level > 0.08 ? t('hearing you') : t('speak to test'));
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
    const opts = [`<option value="" ${!s.micDevice ? 'selected' : ''}>${t('System default')}</option>`]
      .concat(this.mics.map((m) => `<option value="${esc(m.id)}" ${m.id === s.micDevice ? 'selected' : ''}>${esc(m.label)}</option>`));
    if (!known) opts.push(`<option value="${esc(s.micDevice)}" selected>${t('Chosen microphone (not connected)')}</option>`);
    return `<label class="row"><span>${t('Microphone')}</span><select data-sel="micDevice">${opts.join('')}</select><output></output></label>
      <div class="row microw"><span>${t('Mic level')}</span><div class="micmeter"><div data-meter></div></div><output data-meterinfo></output></div>
      ${this.loopbackHtml()}
      ${this.micsNamed || !this.mics.length ? '' : `<button data-act="micnames">${t('SHOW MICROPHONE NAMES')} <small>${t('asks for microphone permission')}</small></button>`}`;
  }

  private loopbackHtml(): string {
    if (this.settings.voice === 'off') return '';
    const m = this.meter;
    const full = PLAYER.maxHealth;
    const hp = [[full, t('full health')], [full / 2, `${full / 2} HP`], [full / 4, `${Math.round(full / 4)} HP`], [full / 10, `${full / 10} HP`], [1, '1 HP']] as const;
    return `<div class="rowbtn loopback">
        <button data-act="loopback" class="${m.loopback ? 'primary' : ''}">${t('LOOPBACK')} ${m.loopback ? t('ON') : t('OFF')}</button>
        <select data-loophp aria-label="${t('Hear yourself at')}">${hp.map(([v, l]) => `<option value="${v}" ${v === m.health ? 'selected' : ''}>${t('as at {hp}', { hp: l })}</option>`).join('')}</select>
        <button data-act="deathvoice">${t('DEATH VOICE')}</button>
      </div>
      <p class="note">${t('Loopback plays your microphone back to you, voiced the way other players hear you. Use headphones: through speakers it feeds back.')}</p>`;
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
      const status = full ? t('full') : r.phase === 'playing' ? t('in progress · join') : t('open');
      const course = r.mode === 'parkour' ? (r.course === 'all' ? t('all {n} courses', { n: COURSES.length }) : t(COURSES.find((c) => c.id === r.course)?.name ?? '').toLowerCase()) : '';
      return `<button class="room" data-room="${esc(r.code)}" ${open ? '' : 'disabled'}>
        <b>${esc(r.host)}</b><em class="rmode ${r.mode}">${r.mode === 'parkour' ? t('PARKOUR') : t('BATTLE')}${course ? ` · ${esc(course)}` : ''}</em><span>${r.players}/${r.max}</span><small class="${open ? 'open' : ''}">${status}</small><code>${esc(r.code)}</code></button>`;
    });
    const none = !this.rooms ? t('Looking for public rooms… (a room code always gets you in)') : f === 'all' ? t('No public rooms right now. When someone creates one, it shows up here. Private rooms are joined with their code.')
      : f === 'parkour' ? t('No public parkour rooms right now.') : t('No public battle rooms right now.');
    return `<h3>${t('PUBLIC ROOMS')}</h3>
      <div class="tabs filter">${tab('all', t('ALL'))}${tab('battle', t('BATTLE'))}${tab('parkour', t('PARKOUR'))}</div>
      ${rows.length ? rows.join('') : `<p class="note">${none}</p>`}`;
  }

  private join(): void {
    const code = (this.root.querySelector('#code') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length === 5) this.cb.onJoin(code);
  }

  private click(e: Event): void {
    const t0 = (e.target as HTMLElement).closest('button');
    if (!t0 || t0.disabled) return;
    this.cb.onClick();
    if (t0.dataset.room) {
      this.cb.onJoin(t0.dataset.room);
      return;
    }
    if (t0.dataset.stab !== undefined) {
      this.settingsTab = Number(t0.dataset.stab) === 1 ? 1 : 0;
      this.show('settings');
      return;
    }
    if (t0.dataset.tab) {
      const tab = Number(t0.dataset.tab);
      if (tab !== this.lookTab) { this.lookTab = tab; this.refreshLook(true); }
      return;
    }
    const look = t0.dataset.look;
    if (look) {
      // pick an option for a body part
      const [k, i] = look.split(':').map(Number);
      if (i >= 0 && i < LOOK_PARTS[k].length) this.settings.look[k] = i;
      saveSettings(this.settings);
      this.refreshLook(false);
      return;
    }
    if (t0.dataset.course) { this.cb.onParkour(t0.dataset.course); return; }
    if (t0.dataset.inv) {
      this.cb.inventory()[Number(t0.dataset.inv)]?.apply();
      this.cb.onInventory();
      this.refreshInventory();
      return;
    }
    if (t0.dataset.slot) { this.cb.onSlot(Number(t0.dataset.slot)); this.refreshInventory(); return; }
    if (t0.dataset.newmap) { this.cb.onNewMap(t0.dataset.newmap === 'parkour' ? 'parkour' : 'battle'); return; }
    if (t0.dataset.openmap) { const f = loadMaps().find((m) => m.id === t0.dataset.openmap); if (f) this.cb.onOpenMap(f); return; }
    if (t0.dataset.delmap) { if (confirm(t('Delete this map? This cannot be undone.'))) { this.cb.onDeleteMap(t0.dataset.delmap); this.show('labbuild'); } return; }
    if (t0.dataset.mapact) { this.cb.onMapAction(t0.dataset.mapact as 'save' | 'download' | 'test' | 'submit'); return; }
    if (t0.dataset.cmode) { this.createMode = t0.dataset.cmode === 'parkour' ? 'parkour' : 'battle'; this.show('create'); return; }
    if (t0.dataset.ccourse) { this.createCourse = t0.dataset.ccourse; this.show('create'); return; }
    if (t0.dataset.filter) {
      this.roomFilter = t0.dataset.filter === 'battle' || t0.dataset.filter === 'parkour' ? t0.dataset.filter : 'all';
      const el = this.root.querySelector('[data-rooms]');
      if (el) el.innerHTML = this.roomsHtml();
      return;
    }
    const bind = t0.dataset.bind as Action | undefined;
    if (bind) {
      this.rebinding = bind;
      this.show('settings');
      return;
    }
    switch (t0.dataset.act) {
      case 'lang': this.setLanguage(getLang() === 'pt' ? 'en' : 'pt'); break;
      case 'practice': this.cb.onPractice(); break;
      case 'parkour': this.show('parkour'); break;
      case 'restartrun': this.cb.onRestartRun(); break;
      case 'create': this.show('create'); break;
      case 'vis-public': case 'vis-private':
        this.settings.roomVisibility = t0.dataset.act === 'vis-public' ? 'public' : 'private';
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
      case 'labbuild': this.show('labbuild'); break;
      case 'labgen': this.show('labgen'); break;
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
        t0.classList.add('copied');
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
        // The language stays as it is: resetting the controls should not flip the words on screen.
        Object.assign(this.settings, structuredClone({ ...DEFAULT_SETTINGS, nickname: this.settings.nickname, turn: this.settings.turn, micDevice: this.settings.micDevice, lang: this.settings.lang }));
        this.changed();
        this.show('settings');
        break;
    }
  }

  /** Switch the interface language: the screen showing is redrawn in it, and the game's own labels follow. */
  private setLanguage(lang: Lang): void {
    this.settings.lang = lang;
    setLang(lang);
    this.changed();
    this.cb.onLanguage();
    this.show(this.screen);
  }

  private input(e: Event): void {
    const t0 = e.target as HTMLInputElement;
    if (t0.id === 'nick') { t0.classList.remove('need'); return; }
    if (t0.id === 'mapname') { this.cb.onMapName(t0.value); return; }
    if (t0.id === 'mapfile') { const file = t0.files?.[0]; if (file) this.cb.onImportMap(file); t0.value = ''; return; }
    if (t0.id === 'code') {
      t0.value = t0.value.toUpperCase().replace(/[^A-Z]/g, '');
      return;
    }
    if (t0.dataset.lobby === 'mode' || t0.dataset.lobby === 'course') {
      const mode = (this.root.querySelector('[data-lobby=mode]') as HTMLSelectElement).value as GameMode;
      let course = (this.root.querySelector('[data-lobby=course]') as HTMLSelectElement | null)?.value ?? this.lobby?.course ?? COURSES[0].id;
      if (course === 'all') course = COURSES[0].id; // (rooms race one course at a time)
      this.cb.onMode(mode, course);
      return;
    }
    if (t0.dataset.lobby === 'max') {
      this.cb.onMaxPlayers(Number(t0.value));
      return;
    }
    if (t0.dataset.lobby === 'bots' || t0.dataset.lobby === 'botlevel') {
      const count = Number((this.root.querySelector('[data-lobby=bots]') as HTMLSelectElement).value);
      const level = (this.root.querySelector('[data-lobby=botlevel]') as HTMLSelectElement).value as BotLevel;
      this.cb.onBots(count, level);
      return;
    }
    if (t0.dataset.lobby === 'vis') {
      this.settings.roomVisibility = t0.value === 'private' ? 'private' : 'public';
      saveSettings(this.settings);
      this.cb.onVisibility(t0.value !== 'private');
      return;
    }
    if (t0.dataset.loophp !== undefined) {
      this.meter.setHealth(Number(t0.value));
      return;
    }
    const turnKey = t0.dataset.turn as 'url' | 'username' | 'credential' | undefined;
    if (turnKey) {
      this.settings.turn[turnKey] = t0.value.trim();
      saveSettings(this.settings);
      return;
    }
    if (t0.dataset.sel === 'lang') { this.setLanguage(t0.value === 'en' ? 'en' : 'pt'); return; }
    const sel = t0.dataset.sel as 'retro' | 'crosshair' | 'voice' | 'micDevice' | 'autoFullscreen' | undefined;
    if (sel) {
      (this.settings[sel] as string) = t0.value;
      this.changed();
      if (sel === 'micDevice' || sel === 'voice') this.restartMeter();
      return;
    }
    const key = t0.dataset.set as 'sensitivity' | 'fov' | 'volume' | 'voiceVolume' | 'renderScale' | 'shake' | undefined;
    if (!key) return;
    this.settings[key] = Number(t0.value);
    const out = t0.parentElement!.querySelector('output');
    if (out && t0.type === 'range') out.textContent = t0.value;
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
