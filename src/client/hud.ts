import { MATCH } from '../config/game';
import { WEAPONS } from '../config/weapons';
import type { Session, SimView } from '../net/session';
import { isDual } from '../sim/game';
import type { Player } from '../sim/types';
import type { ScoreRow } from './scoreboard';
import { keyLabel, type Settings } from './settings';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const css = (color: number) => '#' + color.toString(16).padStart(6, '0');

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
      <div class="spectate" data-el="spec"></div>
      <div class="board" data-el="board"></div>
      <div class="tabboard" data-el="tab"></div>
      <div class="mode" data-el="mode"></div>
      <div class="scores" data-el="scores"></div>
      <div class="banner" data-el="banner"></div>
      <div class="zonewarn" data-el="zone"></div>
      <div class="held" data-el="held"></div>
      <div class="killfeed" data-el="feed"></div>
      <div class="prompt" data-el="prompt"></div>
      <div class="dead" data-el="dead"></div>
      <div class="voice" data-el="voice"></div>
      <div class="health"><span data-el="hp">100</span><small>HP</small></div>
      <div class="speed"><span data-el="spd">0.0</span><small>m/s</small><div class="bar"><div data-el="spdbar"></div></div></div>
      <div class="slots"><div class="slot" data-el="s0"></div><div class="slot" data-el="s1"></div></div>`;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
  }

  /**
   * The hold-Tab scoreboard. Rebuilt only when what it shows changes; returns
   * each row's head canvas (for the portraits) while open, or null when closed.
   * `match` = false in the practice range (only kills and deaths make sense there).
   */
  tabBoard(open: boolean, title: string, rows: ScoreRow[], match: boolean, talking: (id: number) => boolean, roundsPerMap: number):
    { id: number; canvas: HTMLCanvasElement }[] | null {
    const el = this.el.tab;
    el.classList.toggle('on', open);
    if (!open) return null;
    const sig = JSON.stringify([title, rows, match]);
    if (sig !== this.tabSig) {
      this.tabSig = sig;
      const pips = (n: number) => Array.from({ length: roundsPerMap }, (_, i) => `<u class="${i < n ? 'on' : ''}"></u>`).join('');
      const num = (v: number) => (match ? String(v) : '–');
      el.innerHTML = `<div class="tabpanel"><h3>${esc(title)}</h3><table>
        <tr><th></th><th></th><th class="name">PLAYER</th><th>MAPS</th><th>THIS MAP</th><th>ROUNDS</th><th>KILLS</th><th>DEATHS</th></tr>
        ${rows.map((r, n) => `<tr data-pid="${r.id}" class="${r.me ? 'me' : ''} ${r.alive ? '' : 'out'}">
          <td class="rank">${n + 1}</td>
          <td class="head"><canvas width="112" height="112" style="--c:${css(r.color)}"></canvas></td>
          <td class="name"><i style="background:${css(r.color)}"></i>${esc(r.name)}${r.host ? '<small>host</small>' : ''}${r.me ? '<small>you</small>' : ''}${r.alive ? '' : '<small class="tag-out">out</small>'}<small class="tag-talk">talking</small></td>
          <td class="big">${num(r.maps)}</td>
          <td class="pips">${match ? pips(r.mapRounds) : '–'}</td>
          <td>${num(r.rounds)}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('')}
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
    this.el.banner.innerHTML = this.el.scores.innerHTML = this.el.zone.textContent = '';
    this.scoreSig = this.bannerSig = this.phaseKey = this.boardSig = this.tabSig = '';
    this.el.tab.innerHTML = '';
    this.el.tab.classList.remove('on');
    this.el.board.innerHTML = this.el.toast.innerHTML = this.el.spec.textContent = this.el.dir.innerHTML = '';
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
    const html = (live ? '<div class="me">&#9679; MIC LIVE</div>' : '')
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

  /** name = whose eyes you are watching through, or null. */
  setSpectating(name: string | null): void {
    const text = name ? `SPECTATING ${name} — [${keyLabel(this.settings.keys.fire)}] next player` : '';
    if (this.el.spec.textContent !== text) this.el.spec.textContent = text;
    this.root.classList.toggle('spectating', !!name);
  }

  /** Winner's lap: hide the gameplay HUD so the scene and the scoreboard have the screen. */
  setCinematic(on: boolean): void {
    this.root.classList.toggle('cinematic', on);
  }

  damage(amount: number): void {
    this.dmgAlpha = Math.min(0.8, this.dmgAlpha + 0.25 + amount / 100);
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

  /** Scoreboard, round banners, sudden-death warning. Returns the whole seconds left in a countdown (for beeps), else -1. */
  updateMatch(dt: number, s: Session, me: Player | undefined): number {
    const m = s.match;
    if (!m) {
      const label = s.label ?? s.map.name;
      if (this.el.mode.textContent !== label) this.el.mode.textContent = label;
      return -1;
    }
    this.el.mode.textContent = `MAP ${m.mapNumber} · ROUND ${m.round}` + (s.kind === 'client' ? ` · ${s.ping} ms` : '');

    // --- scoreboard: maps taken (number) and rounds won on this map (pips) ---
    const sig = JSON.stringify([s.roster, m.roundWins, m.mapWins]);
    if (sig !== this.scoreSig) {
      this.scoreSig = sig;
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
      return p ? `<b style="color:${css(p.color)}">${esc(p.name)}</b>` : 'NOBODY';
    };
    let banner = '';
    let count = -1;
    switch (m.phase) {
      case 'countdown':
        count = Math.ceil(this.phaseLeft);
        banner = `<small>MAP ${m.mapNumber} — ROUND ${m.round}</small><span class="count">${count || 'GO'}</span>`;
        break;
      case 'roundEnd':
        banner = m.winner >= 0 ? `${name(m.winner)} WINS THE ROUND` : 'DRAW<small>nobody survived — replaying the round</small>';
        break;
      case 'mapEnd':
        banner = `${name(m.winner)} TAKES THE MAP<small>${m.mapWins[m.winner] ?? 0} of ${MATCH.mapsToWin} maps · next map incoming</small>`;
        break;
      case 'matchEnd':
        banner = `${name(m.winner)} WINS THE MATCH<small>back to the lobby in ${Math.ceil(this.phaseLeft)}</small>`;
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
      board = `<table class="${m.phase}"><tr><th></th><th>MAPS</th><th>ROUNDS</th><th>KILLS</th><th>DEATHS</th></tr>` + rows.map((p, n) => {
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
      warn = outside ? 'OUTSIDE THE ZONE — GET TO THE CENTRE' : 'SUDDEN DEATH — THE ZONE IS CLOSING';
      this.el.zone.classList.toggle('danger', !!outside);
    }
    if (this.el.zone.textContent !== warn) this.el.zone.textContent = warn;
    return count;
  }

  update(dt: number, p: Player, sim: SimView, online: boolean): void {
    this.el.hp.textContent = String(Math.max(0, Math.ceil(p.health)));
    this.el.hp.parentElement!.classList.toggle('low', p.health <= 30);

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
      // A beam's charge is a percentage, counted down continuously.
      const ammo = w && WEAPONS[w.type].beam ? `${Math.ceil(w.ammo)}%` : w?.ammo;
      const html = w
        ? `<small>${dual ? keys[i] : i + 1}</small><span>${WEAPONS[w.type].name}</span><b>${ammo}</b>`
        : `<small>${i + 1}</small><span class="none">${i === p.active ? 'FISTS' : '—'}</span>`;
      if (s.className !== cls) s.className = cls;
      if (s.dataset.h !== html) { s.dataset.h = html; s.innerHTML = html; }
    }

    const near = p.nearPickup >= 0 ? sim.pickups.find((x) => x.id === p.nearPickup) : null;
    const held = p.weapons[p.active];
    let prompt = '';
    if (p.alive && near) {
      prompt = `[${keyLabel(this.settings.keys.use)}] ${held && p.weapons[p.active ^ 1] ? 'swap for' : 'pick up'} ` +
        `${WEAPONS[near.weapon.type].name}${near.weapon.ammo <= 0 ? ' (empty)' : ''}`;
    } else if (p.alive && held && held.ammo <= 0) {
      prompt = `EMPTY — [${keyLabel(this.settings.keys.fire)}] or [${keyLabel(this.settings.keys.throw)}] to throw`;
    }
    else if (p.alive && held && WEAPONS[held.type].beam && held.ammo > 0) {
      // The MONOLOGUE's controls are not obvious: spell them out while it is in hand.
      const k = this.settings.keys;
      prompt = `[${keyLabel(k.fire)}] grab · +[${keyLabel(k.fire2)}] burn · WHEEL push / pull · swing and let go to throw`;
    }
    if (this.el.prompt.textContent !== prompt) this.el.prompt.textContent = prompt;

    // Caught in someone's beam: the screen frosts over and says whose.
    const holder = p.alive && p.heldBy >= 0 ? sim.getPlayer(p.heldBy) : undefined;
    const frozen = p.alive && p.heldBy >= 0 ? `FROZEN<small>${holder ? `${esc(holder.name)} has you in the beam` : 'caught in a beam'}</small>` : '';
    if (this.el.held.dataset.h !== frozen) {
      this.el.held.dataset.h = frozen;
      this.el.held.innerHTML = frozen;
      this.el.held.classList.toggle('on', !!frozen);
    }

    const dead = p.alive ? '' : online ? 'ELIMINATED<small>wait for the next round</small>' : 'YOU DIED<small>respawning…</small>';
    if (this.el.dead.dataset.h !== dead) { this.el.dead.dataset.h = dead; this.el.dead.innerHTML = dead; }

    if (this.hitTimer > 0 && (this.hitTimer -= dt) <= 0) this.el.hit.className = 'hitmarker';
    this.dmgAlpha = Math.max(0, this.dmgAlpha - dt * 1.4);
    this.clock += dt;
    // Nearly dead: the red edge stays and throbs like a pulse.
    const low = p.alive && p.health <= 30 ? 0.22 + Math.max(0, Math.sin(this.clock * 7)) * 0.16 : 0;
    this.el.dmg.style.opacity = String(Math.max(this.dmgAlpha, low));
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) this.el.toast.classList.remove('on');
  }
}
