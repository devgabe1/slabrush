import { KILLMARK, MATCH, PLAYER, TEAM } from '../config/game';
/** At or below this, the HP readout turns red and the screen edge throbs (30% of full). */
const LOW_HP = PLAYER.maxHealth * 0.3;
import { WEAPONS, ammoLabel } from '../config/weapons';
import type { BuildBar, Session, SimView } from '../net/session';
import { isDual } from '../sim/game';
import type { Player } from '../sim/types';
import type { ScoreRow } from './scoreboard';
import { keyLabel, type Settings } from './settings';
import { formatDelta, formatTime, type RunState } from '../net/parkourSession';
import { RACE, closesIn, finishOrder, ordinal, raceCourse } from '../sim/race';
import { getLang, t, tName } from '../core/i18n';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const css = (color: number) => '#' + color.toString(16).padStart(6, '0');
/** A finishing place as written in the current language: 1ST in English, 1º in Portuguese. */
const place = (n: number): string => (getLang() === 'pt' ? `${n}º` : ordinal(n));

/** In-game overlay, plain DOM on top of the canvas. */
export class Hud {
  private el: Record<string, HTMLElement> = {};
  private hitTimer = 0;
  private dmgAlpha = 0;
  private scoreSig = '';
  private bannerSig = '';
  private phaseKey = '';
  private phaseLeft = 0; // local countdown of the current phase timer
  private boardSig = '';
  private toastTimer = 0;
  private markTimer = 0;
  private clock = 0;
  private tabSig = '';
  private tabCanvases = new Map<number, HTMLCanvasElement>();

  constructor(private root: HTMLElement, private settings: Settings) {
    root.innerHTML = `
      <div class="scope" data-el="scope"><i></i><i></i><b></b></div>
      <div class="crosshair"><i></i><i></i><i></i><i></i><b></b></div>
      <div class="hitmarker" data-el="hit"><i></i><i></i></div>
      <div class="vignette" data-el="dmg"></div>
      <div class="dmgdir" data-el="dir"></div>
      <div class="toast" data-el="toast"></div>
      <div class="killmark" data-el="mark"></div>
      <div class="spectate" data-el="spec"></div>
      <div class="board" data-el="board"></div>
      <div class="tabboard" data-el="tab"></div>
      <div class="mode" data-el="mode"></div>
      <div class="run" data-el="run"><b data-el="runtime"></b><small data-el="runsub"></small><em data-el="runsplit"></em></div>
      <div class="scores" data-el="scores"></div>
      <div class="racers" data-el="racers"></div>
      <div class="banner" data-el="banner"></div>
      <div class="zonewarn" data-el="zone"></div>
      <div class="held" data-el="held"></div>
      <div class="paused" data-el="paused"></div>
      <div class="killfeed" data-el="feed"></div>
      <div class="prompt" data-el="prompt"></div>
      <div class="dead" data-el="dead"></div>
      <div class="voice" data-el="voice"></div>
      <div class="health"><span data-el="hp">${PLAYER.maxHealth}</span><small>HP</small></div>
      <div class="speed"><span data-el="spd">0.0</span><small>m/s</small><div class="bar"><div data-el="spdbar"></div></div></div>
      <div class="slots"><div class="slot" data-el="s0"></div><div class="slot" data-el="s1"></div></div>
      <div class="build" data-el="build"></div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
  }

  /**
   * The interface language changed. The text is mostly redrawn every frame anyway;
   * the few blocks that only redraw when their data changes are forgotten here, so
   * they show the new words at once.
   */
  relabel(): void {
    this.buildSig = this.scoreSig = this.bannerSig = this.boardSig = this.tabSig = this.runSig = '';
    this.el.build.innerHTML = '';
    this.el.tab.innerHTML = '';
    this.el.tab.classList.remove('on');
    this.tabCanvases.clear();
  }

  /** The map editor's bar (null: not building). Redrawn only when what it shows changes. */
  setBuild(b: BuildBar | null): void {
    this.root.classList.toggle('building', !!b);
    const html = !b ? '' : `
      <div class="hold"><i style="${b.swatch ? `background:${b.swatch}` : 'display:none'}"></i><b>${esc(b.item)}</b>${b.detail ? `<em>${esc(b.detail)}</em>` : ''}<small>${esc(b.keys)}</small></div>
      <div class="mouse"><span><kbd>${t('LMB')}</kbd>${esc(b.place)}</span><span class="${b.remove ? 'rm' : 'off'}"><kbd>${t('RMB')}</kbd>${b.remove ? `${t('remove')} ${esc(b.remove)}` : t('nothing to remove')}</span>${b.target?.what === 'block' ? `<span><kbd>${t('MMB')}</kbd>${t('copy this block')}</span>` : ''}</div>
      <div class="hotbar">${b.slots.map((sl, i) => `<span class="${sl.on ? 'on' : ''}"><kbd>${i + 1}</kbd>${sl.pic ? `<img src="${sl.pic}" alt="">` : sl.swatch ? `<i style="background:${sl.swatch}"></i>` : ''}<b>${esc(sl.label)}</b>${sl.sub ? `<small>${esc(sl.sub)}</small>` : ''}</span>`).join('')}</div>
      <div class="mouse dim"><span><kbd>E</kbd>${t('inventory: everything you can place')}</span><span><kbd>1-9</kbd>/<kbd>${t('WHEEL')}</kbd>${t('slot')}</span><span><kbd>CTRL+Z</kbd>${t('undo')}</span><span><kbd>V</kbd>${t('walk / fly')}</span><span><kbd>ESC</kbd>${t('name, save, test, submit')}</span></div>
      ${b.problem ? `<div class="todo">${t('TO DO:')} ${esc(b.problem)}</div>` : ''}`;
    if (html !== this.buildSig) { this.buildSig = html; this.el.build.innerHTML = html; }
  }
  private buildSig = '';

  /**
   * The hold-Tab scoreboard. Rebuilt only when what it shows changes; returns
   * each row's head canvas (for the portraits) while open, or null when closed.
   * `match` = false in the practice range (only kills and deaths make sense there).
   */
  tabBoard(open: boolean, title: string, rows: ScoreRow[], match: boolean, talking: (id: number) => boolean, roundsPerMap: number, team = false):
    { id: number; canvas: HTMLCanvasElement }[] | null {
    const el = this.el.tab;
    el.classList.toggle('on', open);
    if (!open) return null;
    const sig = JSON.stringify([title, rows, match, team]);
    if (sig !== this.tabSig) {
      this.tabSig = sig;
      const pips = (n: number) => Array.from({ length: roundsPerMap }, (_, i) => `<u class="${i < n ? 'on' : ''}"></u>`).join('');
      const num = (v: number) => (match ? String(v) : '–');
      el.innerHTML = `<div class="tabpanel"><h3>${esc(title)}</h3><table>
        <tr><th></th><th></th><th class="name">${t('PLAYER')}</th>${team ? `<th>${t('TEAM')}</th>` : `<th>${t('MAPS')}</th><th>${t('THIS MAP')}</th><th>${t('ROUNDS')}</th>`}<th>${t('KILLS')}</th><th>${t('DEATHS')}</th></tr>
        ${rows.map((r, n) => `<tr data-pid="${r.id}" class="${r.me ? 'me' : ''} ${r.alive ? '' : 'out'}">
          <td class="rank">${n + 1}</td>
          <td class="head"><canvas width="112" height="112" style="--c:${css(r.color)}"></canvas></td>
          <td class="name"><i style="background:${css(r.color)}"></i>${esc(r.name)}${r.host ? `<small>${t('host')}</small>` : ''}${r.me ? `<small>${t('you')}</small>` : ''}${r.away ? `<small class="tag-out">${t('away')}</small>` : r.alive ? '' : `<small class="tag-out">${t('out')}</small>`}<small class="tag-talk">${t('talking')}</small></td>
          ${team ? `<td style="color:${css(TEAM.colors[r.team ?? 0])}">${t(TEAM.names[r.team ?? 0])}</td>` : `<td class="big">${num(r.maps)}</td>
          <td class="pips">${match ? pips(r.mapRounds) : '–'}</td>
          <td>${num(r.rounds)}</td>`}<td${team ? ' class="big"' : ''}>${r.kills}</td><td>${r.deaths}</td></tr>`).join('')}
      </table></div>`;
      this.tabCanvases.clear();
      el.querySelectorAll<HTMLElement>('tr[data-pid]').forEach((tr) => this.tabCanvases.set(Number(tr.dataset.pid), tr.querySelector('canvas')!));
    }
    el.querySelectorAll<HTMLElement>('tr[data-pid]').forEach((tr) => tr.classList.toggle('talk', talking(Number(tr.dataset.pid))));
    return rows.map((r) => ({ id: r.id, canvas: this.tabCanvases.get(r.id)! })).filter((r) => !!r.canvas);
  }

  show(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  reset(): void {
    this.el.feed.innerHTML = '';
    this.el.banner.innerHTML = this.el.scores.innerHTML = this.el.racers.innerHTML = this.el.zone.textContent = '';
    this.scoreSig = this.bannerSig = this.phaseKey = this.boardSig = this.tabSig = '';
    this.el.tab.innerHTML = '';
    this.el.tab.classList.remove('on');
    this.el.board.innerHTML = this.el.mark.innerHTML = this.el.toast.innerHTML = this.el.spec.textContent = this.el.dir.innerHTML = '';
    this.root.classList.remove('cinematic', 'spectating');
    this.dmgAlpha = 0;
  }

  hitmarker(head: boolean, killed: boolean): void {
    this.hitTimer = killed ? 0.4 : 0.18;
    this.el.hit.className = 'hitmarker on' + (killed ? ' kill' : head ? ' head' : '');
  }

  /**
   * Voice indicators above the health number: who you can hear talking right
   * now, and whether your own microphone is live.
   */
  setVoice(talking: { name: string; color: number }[], live: boolean, note: string): void {
    const html = (live ? `<div class="me">&#9679; ${t('MIC LIVE')}</div>` : '')
      + talking.map((p) => `<div><i style="background:${css(p.color)}"></i>${esc(p.name)}</div>`).join('')
      + (note ? `<div class="warn">${esc(note)}</div>` : '');
    if (this.el.voice.dataset.h !== html) { this.el.voice.dataset.h = html; this.el.voice.innerHTML = html; }
  }

  /** Which way the hit came from. `angle` = direction to the attacker relative to where you look (radians, left positive). */
  damageFrom(angle: number): void {
    const wedge = document.createElement('i');
    wedge.style.transform = `rotate(${-angle}rad)`;
    this.el.dir.append(wedge);
    setTimeout(() => wedge.remove(), 900);
  }

  /** Short message under the crosshair ("ELIMINATED so-and-so"). */
  toast(text: string, who?: Player): void {
    this.el.toast.innerHTML = esc(text) + (who ? ` <b style="color:${css(who.color)}">${esc(who.name)}</b>` : '');
    this.el.toast.classList.add('on');
    this.toastTimer = 1.8;
  }

  /**
   * The kill mark: an emblem that slams in under the crosshair, one pip per kill this round
   * (`n`, 1 to KILLMARK.max), rimmed brighter with each one and red on the last. `head`: the
   * killing blow was a headshot, and the emblem is struck through. Rebuilt every time, so its
   * animation starts over.
   */
  killmark(n: number, head: boolean): void {
    const pips = Array.from({ length: n }, () => '<u></u>').join('');
    this.el.mark.innerHTML = `<div class="km n${n}${n >= KILLMARK.max ? ' top' : ''}${head ? ' head' : ''}">` +
      `<span class="ring"></span>${n >= 3 ? '<span class="ring two"></span>' : ''}<span class="slab"><i></i></span><span class="pips">${pips}</span></div>`;
    this.markTimer = KILLMARK.show;
  }

  setCrosshair(style: string): void {
    this.root.dataset.xh = style;
  }

  /** Death camera (flying head): no crosshair, weapons or speed, just the "eliminated" message. */
  setDeathCam(on: boolean): void {
    this.root.classList.toggle('deathcam', on);
  }

  /** Sniper scope: 0 = none, 1 = looking through it. Replaces the crosshair. */
  setScope(amount: number): void {
    const v = amount.toFixed(2);
    if (this.el.scope.dataset.v === v) return;
    this.el.scope.dataset.v = v;
    this.el.scope.style.opacity = v;
    this.root.classList.toggle('scoped', amount > 0.3);
  }

  /** name = whose eyes you are watching through, or null. `waiting` = we joined mid-round and play from the next one. */
  setSpectating(name: string | null, waiting = false): void {
    const text = name ? `${t('SPECTATING')} ${name}${waiting ? ` — ${t('you play from the next round')}` : ''} — [${keyLabel(this.settings.keys.fire)}] ${t('next player')}` : '';
    if (this.el.spec.textContent !== text) this.el.spec.textContent = text;
    this.root.classList.toggle('spectating', !!name);
  }

  /** Winner's lap: hide the gameplay HUD so the scene and the scoreboard have the screen. */
  setCinematic(on: boolean): void {
    this.root.classList.toggle('cinematic', on);
  }

  damage(amount: number): void {
    this.dmgAlpha = Math.min(0.8, this.dmgAlpha + 0.25 + amount / PLAYER.maxHealth);
  }

  killfeed(killer: Player | undefined, victim: Player | undefined, cause: string): void {
    const row = document.createElement('div');
    const k = killer && killer !== victim ? `<b style="color:${css(killer.color)}">${esc(killer.name)}</b>` : '';
    const v = victim ? `<b style="color:${css(victim.color)}">${esc(victim.name)}</b>` : '?';
    row.innerHTML = k ? `${k}<em>${esc(cause)}</em>${v}` : `${v}<em>${esc(cause)}</em>`;
    this.el.feed.prepend(row);
    setTimeout(() => row.remove(), 5000);
    while (this.el.feed.children.length > 6) this.el.feed.lastChild!.remove();
  }

  private runSig = '';

  /** PARKOUR: the clock, the last checkpoint's split, the result. null hides it. */
  setRun(r: RunState | null, restartKey: string, banner = true): void {
    const el = this.el.run;
    el.classList.toggle('on', !!r);
    this.root.classList.toggle('parkour', !!r); // no health or weapons to show on a course
    if (!r) {
      if (this.runSig) { this.runSig = ''; this.el.banner.innerHTML = ''; }
      return;
    }
    el.classList.toggle('ready', r.phase === 'ready');
    el.classList.toggle('done', r.phase === 'finished');
    this.el.runtime.textContent = formatTime(r.phase === 'finished' && r.result ? r.result.ticks : r.ticks);
    const showSplit = r.split && r.phase === 'running' && r.ticks - r.split.ticks < 180; // 3 s
    const sig = JSON.stringify([r.phase, r.cp, r.best?.best, showSplit, r.result, restartKey]);
    if (sig === this.runSig) return;
    this.runSig = sig;
    const best = r.best ? `${t('BEST')} ${formatTime(r.best.best)}` : t('NO BEST TIME YET');
    this.el.runsub.textContent = r.phase === 'ready'
      ? `${t('LEAVE THE PLATFORM TO START')} · ${best}`
      : `${t('CHECKPOINT')} ${r.cp}/${r.course.checkpoints} · ${best}${restartKey ? ` · ${restartKey} ${t('RESTART')}` : ''}`;
    const sp = this.el.runsplit;
    if (showSplit && r.split) {
      const d = r.split.delta;
      sp.textContent = `${t('CHECKPOINT')} ${r.split.cp}  ${formatTime(r.split.ticks)}${d === null ? '' : '  ' + formatDelta(d)}`;
      sp.className = d === null ? '' : d <= 0 ? 'ahead' : 'behind';
    } else sp.textContent = '';
    // The finish: a banner (online, only while the course is open: the results take over after).
    if (!banner) return;
    const res = r.phase === 'finished' ? r.result : null;
    const vs = !res ? '' : res.newBest ? (res.delta === null ? t('FIRST FINISH: YOUR BEST TIME') : `${t('NEW BEST!')} ${formatDelta(res.delta)}`) : `${formatDelta(res.delta ?? 0)} ${t('ON YOUR BEST')}`;
    this.el.banner.innerHTML = !res ? '' : `<span class="runend ${res.newBest ? 'best' : ''}">${res.place ? place(res.place) + ' · ' :`${t('FINISHED')} `}${formatTime(res.ticks)}`
      + `<small>${vs}${restartKey ? ` · ${esc(restartKey)} ${t('TO GO AGAIN')}` : res.place ? ` · ${t('WAITING FOR THE OTHERS')}` : ''}</small></span>`;
  }

  /** PARKOUR in a room: live standings, the countdown, each course's results, the final standings. */
  private updateRace(dt: number, s: Session): number {
    const m = s.match!, r = m.race!;
    const course = raceCourse(r);
    const label = `${t('PARKOUR')} · ${t('COURSE')} ${r.index + 1}/${r.courses.length} · ${t(course.name)}` + (s.kind === 'client' ? ` · ${s.ping} ms` : '');
    if (this.el.mode.textContent !== label) this.el.mode.textContent = label;
    if (this.el.scores.innerHTML) this.el.scores.innerHTML = '';
    if (this.el.zone.textContent) this.el.zone.textContent = '';

    const key = `${m.phase}/${r.index}`;
    if (key !== this.phaseKey) { this.phaseKey = key; this.phaseLeft = m.timer; }
    this.phaseLeft = Math.max(0, this.phaseLeft - dt);
    const who = (id: number) => s.roster.find((p) => p.id === id);
    const name = (id: number) => {
      const p = who(id);
      return p ? `<b style="color:${css(p.color)}">${esc(p.name)}</b>` : t('NOBODY');
    };

    // Standings down the right: where everyone is on this course, and their points so far.
    const ids = Object.keys(r.runners).map(Number);
    const order = r.order ?? finishOrder(r, ids);
    const someoneHome = ids.some((id) => r.runners[id].finish !== null);
    const closing = m.phase === 'playing' && someoneHome ? Math.ceil(closesIn(r, s.view.worldTick)) : -1;
    const racers = `<h4>${closing >= 0 ? `${t('CLOSES IN')} ${closing}` : t('STANDINGS')}</h4>` + order.map((id, n) => {
      const p = who(id), run = r.runners[id];
      if (!p) return '';
      const at = run.finish !== null ? formatTime(run.finish) : p.away ? t('AWAY') : `${t('CP')} ${run.cp}/${course.checkpoints}`;
      return `<div class="${id === s.localId ? 'me' : ''} ${run.finish !== null ? 'home' : ''}"><em>${n + 1}</em><i style="background:${css(p.color)}"></i>`
        + `<span>${esc(p.name)}</span><small>${at}</small><b>${r.points[id] ?? 0}</b></div>`;
    }).join('');
    if (this.el.racers.innerHTML !== racers) this.el.racers.innerHTML = racers;

    let banner = '';
    let count = -1;
    switch (m.phase) {
      case 'countdown':
        count = Math.ceil(this.phaseLeft);
        banner = `<small>${t('COURSE')} ${r.index + 1} ${t('OF')} ${r.courses.length} — ${esc(t(course.name))}</small><span class="count">${count || t('GO')}</span>`;
        break;
      case 'roundEnd': {
        const rows = (r.order ?? []).map((id, n) => {
          const run = r.runners[id];
          return run?.finish !== null && run ? `${place(n + 1)} ${name(id)} ${formatTime(run.finish)} <u>+${RACE.points[n] ?? 1}</u>` : '';
        }).filter(Boolean);
        banner = `${esc(t(course.name))}<small class="results">${rows.length ? rows.join('<br>') : t('NOBODY MADE IT TO THE FINISH')}</small>`
          + `<small>${r.index + 1 < r.courses.length ? t('next course incoming') : t('final standings incoming')}</small>`;
        break;
      }
      case 'matchEnd':
        banner = m.winner >= 0 ? `${name(m.winner)} ${t('WINS THE RACE')}<small>${t('back to the lobby in {s}', { s: Math.ceil(this.phaseLeft) })}</small>`
          : `${t('NOBODY SCORED')}<small>${t('back to the lobby in {s}', { s: Math.ceil(this.phaseLeft) })}</small>`;
        break;
    }
    if (banner !== this.bannerSig) {
      this.bannerSig = banner;
      this.el.banner.innerHTML = banner;
      this.el.banner.className = 'banner ' + m.phase;
    }
    let board = '';
    if (m.phase === 'matchEnd') {
      const rows = [...s.roster].sort((a, b) => (r.points[b.id] ?? 0) - (r.points[a.id] ?? 0) || (m.stats[b.id]?.rounds ?? 0) - (m.stats[a.id]?.rounds ?? 0));
      board = `<table class="matchEnd"><tr><th></th><th>${t('POINTS')}</th><th>${t('COURSES WON')}</th></tr>` + rows.map((p, n) =>
        `<tr class="${p.id === s.localId ? 'me' : ''}"><td><em>${n + 1}</em><i style="background:${css(p.color)}"></i>${esc(p.name)}</td>`
        + `<td class="big">${r.points[p.id] ?? 0}</td><td>${m.stats[p.id]?.rounds ?? 0}</td></tr>`).join('') + '</table>';
    }
    if (board !== this.boardSig) { this.boardSig = board; this.el.board.innerHTML = board; }
    return count;
  }

  /** TEAM: both sides' kills and the clock at the top, the countdown, and the result with everyone's score. */
  private updateTeam(dt: number, s: Session): number {
    const m = s.match!, tk = m.teamKills ?? [0, 0];
    const label = `${t('TEAM')} · ${t('first to {n} kills', { n: TEAM.killsToWin })}` + (s.kind === 'client' ? ` · ${s.ping} ms` : '');
    if (this.el.mode.textContent !== label) this.el.mode.textContent = label;
    if (this.el.racers.innerHTML) this.el.racers.innerHTML = '';
    if (this.el.zone.textContent) this.el.zone.textContent = '';

    // The clock counts down locally, and catches up whenever the host says how long is left
    // (every match message; on the host itself, every frame).
    const key = `${m.phase}/${m.timer}`;
    if (key !== this.phaseKey) { this.phaseKey = key; this.phaseLeft = m.timer; }
    this.phaseLeft = Math.max(0, this.phaseLeft - dt);
    const left = m.phase === 'playing' ? this.phaseLeft : m.phase === 'countdown' ? TEAM.timeLimit : 0;
    const clock = `${Math.floor(Math.ceil(left) / 60)}:${String(Math.ceil(left) % 60).padStart(2, '0')}`;
    const mine = s.roster.find((p) => p.id === s.localId)?.team;
    const side = (n: number) => `<div class="team ${n ? 'blue' : 'red'} ${mine === n ? 'me' : ''}" style="--c:${css(TEAM.colors[n])}"><span>${t(TEAM.names[n])}</span><b>${tk[n]}</b></div>`;
    const scores = `${side(0)}<div class="clock ${left <= 60 && m.phase === 'playing' ? 'late' : ''}">${clock}</div>${side(1)}`;
    if (scores !== this.scoreSig) { this.scoreSig = scores; this.el.scores.innerHTML = scores; this.el.scores.className = 'scores teams'; }

    const teamName = (n: number) => `<b style="color:${css(TEAM.colors[n])}">${t(TEAM.names[n])}</b>`;
    let banner = '';
    let count = -1;
    switch (m.phase) {
      case 'countdown':
        count = Math.ceil(this.phaseLeft);
        banner = `<small>${mine === 0 || mine === 1 ? t('you are on {team}', { team: teamName(mine) }) : t('TEAM')} — ${t('first to {n} kills', { n: TEAM.killsToWin })}</small><span class="count">${count || t('GO')}</span>`;
        break;
      case 'matchEnd': {
        const back = `<small>${tk[0]} – ${tk[1]} · ${t('back to the lobby in {s}', { s: Math.ceil(this.phaseLeft) })}</small>`;
        banner = m.winTeam === 0 || m.winTeam === 1 ? `${teamName(m.winTeam)} ${t('WINS THE MATCH')}${back}` : `${t('DRAW')}${back}`;
        break;
      }
    }
    if (banner !== this.bannerSig) {
      this.bannerSig = banner;
      this.el.banner.innerHTML = banner;
      this.el.banner.className = 'banner ' + m.phase;
    }

    let board = '';
    if (m.phase === 'matchEnd') {
      const rows = [...s.roster].sort((a, b) => (a.team ?? 0) - (b.team ?? 0)
        || (m.stats[b.id]?.kills ?? 0) - (m.stats[a.id]?.kills ?? 0) || (m.stats[a.id]?.deaths ?? 0) - (m.stats[b.id]?.deaths ?? 0));
      board = `<table class="matchEnd"><tr><th></th><th>${t('TEAM')}</th><th>${t('KILLS')}</th><th>${t('DEATHS')}</th></tr>` + rows.map((p) => {
        const st = m.stats[p.id] ?? { kills: 0, deaths: 0, rounds: 0 };
        return `<tr class="${p.id === s.localId ? 'me' : ''}"><td><i style="background:${css(p.color)}"></i>${esc(p.name)}</td>`
          + `<td>${teamName(p.team ?? 0)}</td><td class="big">${st.kills}</td><td>${st.deaths}</td></tr>`;
      }).join('') + '</table>';
    }
    if (board !== this.boardSig) { this.boardSig = board; this.el.board.innerHTML = board; }
    return count;
  }

  /** Scoreboard, round banners, sudden-death warning. Returns the whole seconds left in a countdown (for beeps), else -1. */
  updateMatch(dt: number, s: Session, me: Player | undefined): number {
    const m = s.match;
    if (!m) {
      const label = tName(s.label ?? s.map.name); // (a map's own name: PRACTICE RANGE, or a generated map's label)
      if (this.el.mode.textContent !== label) this.el.mode.textContent = label;
      return -1;
    }
    if (m.race) return this.updateRace(dt, s);
    if (m.mode === 'team') return this.updateTeam(dt, s);
    this.el.mode.textContent = `${t('MAP')} ${m.mapNumber} · ${t('ROUND')} ${m.round}` + (s.kind === 'client' ? ` · ${s.ping} ms` : '');

    // --- scoreboard: maps taken (number) and rounds won on this map (pips) ---
    const sig = JSON.stringify([s.roster, m.roundWins, m.mapWins]);
    if (sig !== this.scoreSig) {
      this.scoreSig = sig;
      this.el.scores.className = 'scores';
      this.el.scores.innerHTML = s.roster.map((p) => {
        const rounds = m.roundWins[p.id] ?? 0;
        let pips = '';
        for (let i = 0; i < MATCH.roundsPerMap; i++) pips += `<u class="${i < rounds ? 'on' : ''}"></u>`;
        return `<div class="${p.id === s.localId ? 'me' : ''}"><i style="background:${css(p.color)}"></i>` +
          `<span>${esc(p.name)}</span><em>${pips}</em><b>${m.mapWins[p.id] ?? 0}</b></div>`;
      }).join('');
    }

    // --- phase timer (each peer counts down locally from the value it was told) ---
    const key = `${m.phase}/${m.mapNumber}/${m.round}`;
    if (key !== this.phaseKey) { this.phaseKey = key; this.phaseLeft = m.timer; }
    this.phaseLeft = Math.max(0, this.phaseLeft - dt);

    const name = (id: number) => {
      const p = s.roster.find((r) => r.id === id);
      return p ? `<b style="color:${css(p.color)}">${esc(p.name)}</b>` : t('NOBODY');
    };
    let banner = '';
    let count = -1;
    switch (m.phase) {
      case 'countdown':
        count = Math.ceil(this.phaseLeft);
        banner = `<small>${t('MAP')} ${m.mapNumber} — ${t('ROUND')} ${m.round}</small><span class="count">${count || t('GO')}</span>`;
        break;
      case 'roundEnd':
        banner = m.winner >= 0 ? `${name(m.winner)} ${t('WINS THE ROUND')}` : `${t('DRAW')}<small>${t('nobody survived — replaying the round')}</small>`;
        break;
      case 'mapEnd':
        banner = `${name(m.winner)} ${t('TAKES THE MAP')}<small>${t('{a} of {b} maps · next map incoming', { a: m.mapWins[m.winner] ?? 0, b: MATCH.mapsToWin })}</small>`;
        break;
      case 'matchEnd':
        banner = `${name(m.winner)} ${t('WINS THE MATCH')}<small>${t('back to the lobby in {s}', { s: Math.ceil(this.phaseLeft) })}</small>`;
        break;
    }
    if (banner !== this.bannerSig) {
      this.bannerSig = banner;
      this.el.banner.innerHTML = banner;
      this.el.banner.className = 'banner ' + m.phase;
    }

    // --- full scoreboard between maps and at the end ---
    let board = '';
    if (m.phase === 'mapEnd' || m.phase === 'matchEnd') {
      const rows = [...s.roster].sort((a, b) =>
        (m.mapWins[b.id] ?? 0) - (m.mapWins[a.id] ?? 0) || (m.stats[b.id]?.rounds ?? 0) - (m.stats[a.id]?.rounds ?? 0)
        || (m.stats[b.id]?.kills ?? 0) - (m.stats[a.id]?.kills ?? 0));
      board = `<table class="${m.phase}"><tr><th></th><th>${t('MAPS')}</th><th>${t('ROUNDS')}</th><th>${t('KILLS')}</th><th>${t('DEATHS')}</th></tr>` + rows.map((p, n) => {
        const st = m.stats[p.id] ?? { kills: 0, deaths: 0, rounds: 0 };
        return `<tr class="${p.id === s.localId ? 'me' : ''}"><td><em>${n + 1}</em><i style="background:${css(p.color)}"></i>${esc(p.name)}</td>` +
          `<td class="big">${m.mapWins[p.id] ?? 0}</td><td>${st.rounds}</td><td>${st.kills}</td><td>${st.deaths}</td></tr>`;
      }).join('') + '</table>';
    }
    if (board !== this.boardSig) { this.boardSig = board; this.el.board.innerHTML = board; }

    const zone = s.view.zone;
    let warn = '';
    if (zone && m.phase === 'playing') {
      const outside = me?.alive && Math.hypot(me.pos.x - zone.x, me.pos.z - zone.z) > zone.radius;
      warn = outside ? t('OUTSIDE THE ZONE — GET TO THE CENTRE') : t('SUDDEN DEATH — THE ZONE IS CLOSING');
      this.el.zone.classList.toggle('danger', !!outside);
    }
    if (this.el.zone.textContent !== warn) this.el.zone.textContent = warn;
    return count;
  }

  /** The host paused the match: a banner for everyone (empty = not paused). */
  setPaused(by: string | null): void {
    const html = by === null ? '' : `${t('PAUSED')}<small>${t('{name} paused the match', { name: esc(by) })}</small>`;
    if (this.el.paused.dataset.h !== html) {
      this.el.paused.dataset.h = html;
      this.el.paused.innerHTML = html;
      this.el.paused.classList.toggle('on', !!html);
    }
  }

  /** `waiting` = in the room but not in this round (joined mid-round): watching until the next one. */
  update(dt: number, p: Player, sim: SimView, online: boolean, waiting = false): void {
    this.el.hp.textContent = String(Math.max(0, Math.ceil(p.health)));
    this.el.hp.parentElement!.classList.toggle('low', p.health <= LOW_HP);

    const speed = Math.hypot(p.vel.x, p.vel.z);
    this.el.spd.textContent = speed.toFixed(1);
    this.el.spdbar.style.width = Math.min(100, (speed / 24) * 100) + '%';
    this.el.spdbar.classList.toggle('fast', speed > 9);

    // Dual wielding: both weapons are live, each labelled with the button that fires it.
    const dual = isDual(p);
    const keys = [keyLabel(this.settings.keys.fire), keyLabel(this.settings.keys.fire2)];
    for (let i = 0; i < 2; i++) {
      const w = p.weapons[i];
      const s = this.el['s' + i];
      const legendary = !!w && WEAPONS[w.type].category === 'legendary';
      const cls = 'slot' + (dual || i === p.active ? ' active' : '') + (dual ? ' dual' : '') + (w && w.ammo <= 0 ? ' empty' : '') + (legendary ? ' legendary' : '');
      // A beam's (or a megaphone's) charge is a percentage, counted down continuously.
      const ammo = w ? ammoLabel(WEAPONS[w.type], w.ammo) : '';
      // The weapon in hand shows its right-click special and when it is ready.
      const sp = !dual && i === p.active ? WEAPONS[w ? w.type : 'fists'].special : undefined;
      const spHtml = sp ? `<i class="sp ${p.specialCd > 0 ? 'wait' : ''}">${keyLabel(this.settings.keys.fire2)} ${t(sp.name)}${p.specialCd > 0 ? ` ${p.specialCd.toFixed(1)}` : ''}</i>` : '';
      const html = w
        ? `<small>${dual ? keys[i] : i + 1}</small><span>${t(WEAPONS[w.type].name)}${spHtml}</span><b>${ammo}</b>`
        : `<small>${i + 1}</small><span class="none">${i === p.active ? t('FISTS') : '—'}${spHtml}</span>`;
      if (s.className !== cls) s.className = cls;
      if (s.dataset.h !== html) { s.dataset.h = html; s.innerHTML = html; }
    }

    const near = p.nearPickup >= 0 ? sim.pickups.find((x) => x.id === p.nearPickup) : null;
    const held = p.weapons[p.active];
    let prompt = '';
    if (p.alive && near && WEAPONS[near.weapon.type].category === 'vehicle') {
      prompt = `[${keyLabel(this.settings.keys.use)}] ${t('ride')} ${t(WEAPONS[near.weapon.type].name)} (${Math.round(near.weapon.ammo / 10)} s ${t('of')} ${near.weapon.type === 'slabrider' ? t('fuel') : t('flight')})`;
    } else if (p.alive && near) {
      prompt = `[${keyLabel(this.settings.keys.use)}] ${held && p.weapons[p.active ^ 1] ? t('swap for') : t('pick up')} ` +
        `${t(WEAPONS[near.weapon.type].name)}${near.weapon.ammo <= 0 ? ` (${t('empty')})` : ''}`;
    } else if (p.alive && (p.broomT > 0 || p.bikeT > 0 || p.tumbleT > 0)) {
      // Riding (or thrown off): no text over the view.
    } else if (p.alive && held && held.ammo <= 0) {
      prompt = `${t('EMPTY')} — [${keyLabel(this.settings.keys.fire)}] ${t('or')} [${keyLabel(this.settings.keys.throw)}] ${t('to throw')}`;
    }
    if (this.el.prompt.textContent !== prompt) this.el.prompt.textContent = prompt;

    // Caught in someone's beam: the screen frosts over and says whose.
    const holder = p.alive && p.heldBy >= 0 ? sim.getPlayer(p.heldBy) : undefined;
    const frozen = p.alive && p.heldBy >= 0 ? `${t('FROZEN')}<small>${holder ? t('{name} has you in the beam', { name: esc(holder.name) }) : t('caught in a beam')}: ${t('you can still shoot')}</small>` : '';
    if (this.el.held.dataset.h !== frozen) {
      this.el.held.dataset.h = frozen;
      this.el.held.innerHTML = frozen;
      this.el.held.classList.toggle('on', !!frozen);
    }

    const dead = p.alive ? '' : waiting ? `${t('SPECTATING')}<small>${t('you join in from the next round')}</small>` : online ? `${t('ELIMINATED')}<small>${t('wait for the next round')}</small>` : `${t('YOU DIED')}<small>${t('respawning…')}</small>`;
    if (this.el.dead.dataset.h !== dead) { this.el.dead.dataset.h = dead; this.el.dead.innerHTML = dead; }

    if (this.hitTimer > 0 && (this.hitTimer -= dt) <= 0) this.el.hit.className = 'hitmarker';
    this.dmgAlpha = Math.max(0, this.dmgAlpha - dt * 1.4);
    this.clock += dt;
    // Nearly dead: the red edge stays and throbs like a pulse.
    const low = p.alive && p.health <= LOW_HP ? 0.22 + Math.max(0, Math.sin(this.clock * 7)) * 0.16 : 0;
    this.el.dmg.style.opacity = String(Math.max(this.dmgAlpha, low));
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.el.toast.classList.remove('on');
    if (this.markTimer > 0 && (this.markTimer -= dt) <= 0) this.el.mark.innerHTML = '';
  }
}
