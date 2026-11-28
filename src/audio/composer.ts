import { Rng } from '../core/rng';
import { MUSIC } from '../config/music';

// The soundtrack's composer. It writes a song while it plays, one bar at a
// time, and the synth (music.ts) turns each bar into sound. Nothing here
// touches Web Audio, so the tests can read whole songs.
//
// Why compose instead of looping a track: a loop is heard as a loop within a
// few minutes. Each song here picks its own key, mode, tuning, tempo and meter,
// writes its own riffs, chord progression, melody and arpeggio, and lays them
// out in a form drawn at random (intro, verses, choruses, breaks, solos, outro).
// A section that comes back is varied (its riff mutates, the melody shifts),
// solos are improvised bar by bar, and when the song ends there is a pause and
// then a completely new song.
//
// The sound it aims for is heavy progressive rock with an electronic layer:
// palm-muted chugs and power chords on low-tuned double-tracked guitars, odd
// accent groupings (3+3+2...) and odd meters (7/8), a soaring lead, clean
// arpeggios and synth pads in the quiet parts. All of it is written here from
// scale rules; no existing melody is used.

export type Mood = 'menu' | 'match';
export type Part = 'kick' | 'snare' | 'hat' | 'crash' | 'tom' | 'bass' | 'rhythm' | 'lead' | 'clean' | 'pad';
export type SectionKind = 'intro' | 'build' | 'verse' | 'chorus' | 'break' | 'solo' | 'ambient' | 'outro';

export interface MusicNote {
  part: Part;
  /** Start, in sixteenth notes from the start of the bar. */
  step: number;
  /** Length in sixteenth notes. */
  len: number;
  /** MIDI notes sounded together (one for a melody, several for a chord). Drums use it for a tom's pitch. */
  midi: number[];
  /** Loudness, 0..1. */
  vel: number;
  /** Rhythm guitar: palm-muted (short and dark). */
  mute?: boolean;
  /** Lead guitar: semitones it bends up from at the start (0 = none). */
  bend?: number;
}

export interface Bar {
  /** Sixteenth notes in the bar: 16 is 4/4, 14 is 7/8, 12 is 3/4. */
  steps: number;
  /** Seconds per sixteenth note. */
  stepSec: number;
  section: SectionKind;
  /** 0 = ambient, 1 = light drums, 2 = full band, 3 = everything at once. */
  intensity: number;
  notes: MusicNote[];
}

interface Section { kind: SectionKind; bars: number; intensity: number }
/** One step of a riff: a muted chug, a ringing power chord, a rest, or holding the last chord. */
interface RiffStep { kind: 'chug' | 'chord' | 'rest' | 'hold'; deg: number }
interface MelodyNote { step: number; len: number; off: number; bend: number }

/** Scales a song may be in, as semitones from the root. All dark: minor modes. */
const MODES: Record<string, readonly number[]> = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
};

export class Composer {
  readonly mood: Mood;
  readonly bpm: number;
  readonly steps: number;
  readonly root: number;
  readonly modeName: string;
  readonly form: Section[];
  private rng: Rng;
  private scale: readonly number[];
  /** Accent groups of a bar for the guitars (3+3+2...) and for the drums. */
  private groups: number[];
  private drumGroups: number[];
  private chorusProg: number[];
  private verseProg: number[];
  private riffA: RiffStep[];
  private riffB: RiffStep[];
  private melody: MelodyNote[];
  private arp: number[];
  private arpRate: number;
  /** Where the song is: section index, bar within it, how often each kind has been heard. */
  private si = 0;
  private bi = 0;
  private seen: Partial<Record<SectionKind, number>> = {};
  private riffNow: RiffStep[] = [];
  private melodyNow: MelodyNote[] = [];
  private arpNow: number[] = [];
  /** The solo's last note (scale degree above the lead's base), so it moves on from where it was. */
  private soloDeg = 7;

  constructor(seed: number, mood: Mood) {
    const rng = (this.rng = new Rng(seed));
    this.mood = mood;
    const [lo, hi] = mood === 'match' ? MUSIC.matchBpm : MUSIC.menuBpm;
    this.bpm = Math.round(rng.range(lo, hi));
    // Battle songs are mostly in 4/4, sometimes 7/8 or 3/4; menu songs in 4/4 or 3/4.
    this.steps = mood === 'match' ? rng.pick([16, 16, 16, 14, 12]) : rng.pick([16, 16, 12]);
    this.root = rng.pick(MUSIC.tunings);
    this.modeName = rng.pick(Object.keys(MODES));
    this.scale = MODES[this.modeName];
    this.groups = this.accentGroups();
    this.drumGroups = { 16: [4, 4, 4, 4], 14: [4, 4, 3, 3], 12: [3, 3, 3, 3] }[this.steps] ?? [4, 4, 4, 4];
    this.chorusProg = this.progression(true);
    this.verseProg = this.progression(false);
    this.riffA = this.writeRiff(0.55);
    this.riffB = this.writeRiff(0.3);
    this.melody = this.writeMelody();
    this.arp = Array.from({ length: 8 }, (_, i) => (i === 0 ? 0 : rng.pick([0, 2, 4, 7, 9, 4, 2])));
    this.arpRate = this.steps === 12 ? 3 : 2;
    this.form = this.writeForm();
  }

  /** Seconds in one bar. */
  get barSec(): number { return this.steps * this.stepSec; }
  get stepSec(): number { return 60 / this.bpm / 4; }
  /** Seconds the whole song lasts. */
  get length(): number { return this.form.reduce((n, s) => n + s.bars, 0) * this.barSec; }

  /** The next bar of the song, or null once it has ended. */
  nextBar(): Bar | null {
    const sec = this.form[this.si];
    if (!sec) return null;
    if (this.bi === 0) this.enterSection(sec);
    const notes: MusicNote[] = [];
    const last = this.bi === sec.bars - 1;
    const chord = this.chordAt(sec);
    this.drums(sec, last, notes);
    this.guitars(sec, chord, notes);
    this.layers(sec, chord, notes);
    const bar: Bar = { steps: this.steps, stepSec: this.stepSec, section: sec.kind, intensity: sec.intensity, notes };
    if (++this.bi >= sec.bars) { this.bi = 0; this.si++; }
    return bar;
  }

  // ------------------------------------------------------------- the plan

  /** Split a bar into accent groups of 2, 3 and 4 sixteenths, ending on a 2 or 4 so the downbeat lands. */
  private accentGroups(): number[] {
    const out: number[] = [];
    let left = this.steps;
    while (left > 0) {
      const g = left <= 4 ? left : this.rng.pick(left - 3 === 1 ? [2, 4] : [3, 3, 2, 4]);
      out.push(g);
      left -= g;
    }
    return out;
  }

  /** Four chords as scale degrees, starting on the tonic. A verse leans on the tonic; a chorus moves. */
  private progression(moving: boolean): number[] {
    const pool = this.modeName.startsWith('phrygian') ? [1, 2, 3, 4, 5, 6] : [2, 3, 4, 5, 6];
    const out: number[] = [0];
    while (out.length < 4) {
      const prev = out[out.length - 1];
      const d = !moving && this.rng.next() < 0.5 ? 0 : this.rng.pick(pool.filter((x) => x !== prev));
      out.push(d);
    }
    if (!out.some((d) => d !== 0)) out[3] = this.rng.pick(pool); // even a verse goes somewhere once
    return out;
  }

  /** Two bars of rhythm guitar. `density`: how much of it is chugging rather than rests and held chords. */
  private writeRiff(density: number): RiffStep[] {
    const riff: RiffStep[] = [];
    for (let bar = 0; bar < 2; bar++) {
      for (const g of this.groups) {
        for (let k = 0; k < g; k++) {
          const r = this.rng.next();
          if (k === 0) {
            // Each group opens on an accent: the low string, or a power chord a few degrees up.
            riff.push(r < 0.55 ? { kind: 'chug', deg: 0 } : { kind: 'chord', deg: this.rng.pick([0, 0, 1, 2, 3, 4, 5]) });
          } else if (riff[riff.length - 1].kind === 'chord' && r < 0.6) riff.push({ kind: 'hold', deg: 0 });
          else riff.push(r < density ? { kind: 'chug', deg: 0 } : { kind: 'rest', deg: 0 });
        }
      }
      // The second bar answers the first: it ends on a climbing figure.
      if (bar === 1) {
        const at = riff.length - this.groups[this.groups.length - 1];
        for (let i = at, d = this.rng.int(2, 4); i < riff.length; i++, d++) riff[i] = { kind: 'chord', deg: d };
      }
    }
    return riff;
  }

  /**
   * Two bars of lead melody, as offsets in scale degrees from the chord's root
   * (so the same melody follows the chords). Strong beats take chord tones.
   */
  private writeMelody(): MelodyNote[] {
    const out: MelodyNote[] = [];
    const total = this.steps * 2;
    let step = this.rng.pick([0, 0, 2, 4]);
    let off = this.rng.pick([0, 2, 4, 7]);
    while (step < total - 1) {
      const len = Math.min(total - step, this.rng.pick([2, 2, 3, 4, 4, 6, 8]));
      const strong = this.groupStart(step % this.steps);
      if (strong) off = this.nearestChordTone(off + this.rng.int(-2, 2));
      else off += this.rng.pick([-1, -1, 1, 1, 2, -2]);
      off = Math.max(-3, Math.min(9, off));
      out.push({ step, len, off, bend: len >= 4 && this.rng.next() < 0.3 ? this.rng.pick([1, 2]) : 0 });
      step += len + (this.rng.next() < 0.2 ? 2 : 0);
    }
    // The phrase comes home: its last note is the chord's root or fifth.
    if (out.length) out[out.length - 1].off = this.rng.pick([0, 4, 7]);
    return out;
  }

  /** The order of sections, filled until the song reaches its length. */
  private writeForm(): Section[] {
    const r = this.rng;
    const match = this.mood === 'match';
    const [lo, hi] = match ? MUSIC.matchLength : MUSIC.menuLength;
    const target = Math.max(8, Math.round(r.range(lo, hi) / this.barSec));
    const form: Section[] = [];
    const add = (kind: SectionKind, bars: number, intensity: number) => form.push({ kind, bars, intensity });
    const total = () => form.reduce((n, s) => n + s.bars, 0);
    if (match) {
      if (r.next() < 0.6) add('intro', r.pick([4, 8]), r.pick([0, 1]));
      add('build', 4, 1);
      let kind: SectionKind = 'verse';
      let solos = 0;
      while (total() < target) {
        if (kind === 'verse') add('verse', r.pick([8, 8, 12, 16]), 2);
        else if (kind === 'chorus') add('chorus', 8, 3);
        else if (kind === 'break') add('break', r.pick([4, 8]), r.pick([1, 2]));
        else { add('solo', r.pick([8, 16]), 3); solos++; }
        // What may follow what: a chorus usually after a verse, a solo never three times.
        const next: Record<string, SectionKind[]> = {
          verse: ['chorus', 'chorus', 'chorus', 'break', 'verse', 'solo'],
          chorus: ['verse', 'verse', 'break', 'solo', 'solo'],
          break: ['solo', 'solo', 'verse', 'chorus'],
          solo: ['chorus', 'chorus', 'chorus', 'verse', 'break'],
        };
        kind = r.pick(next[kind].filter((k) => k !== 'solo' || solos < 2));
      }
      if (form[form.length - 1].kind !== 'chorus' && r.next() < 0.5) add('chorus', 8, 3);
      add('outro', r.pick([4, 8]), 0);
    } else {
      add('intro', r.pick([4, 8]), 0);
      while (total() < target) {
        add('ambient', r.pick([8, 8, 12, 16]), r.pick([0, 0, 1]));
        if (total() >= target) break;
        if (r.next() < 0.5) add('build', 4, 1);
        if (r.next() < 0.6) add('chorus', 8, 2);
        else add('break', r.pick([4, 8]), 1);
      }
      add('outro', r.pick([4, 8]), 0);
    }
    return form;
  }

  /** A section starts: a returning one is varied, so it is never heard twice the same. */
  private enterSection(sec: Section): void {
    const n = (this.seen[sec.kind] = (this.seen[sec.kind] ?? 0) + 1) - 1;
    const base = sec.kind === 'break' ? this.riffB : this.riffA;
    this.riffNow = n === 0 ? base.slice() : this.mutateRiff(base, 0.12 + 0.08 * n);
    this.arpNow = this.arp.map((d, i) => (n > 0 && i > 0 && this.rng.next() < 0.35 ? this.rng.pick([0, 2, 4, 7, 9]) : d));
    this.melodyNow = n === 0 ? this.melody.slice() : this.melody.map((m) => ({
      ...m, off: this.rng.next() < 0.3 ? this.nearestChordTone(m.off + this.rng.pick([-2, 2, 7])) : m.off,
    }));
    if (sec.kind === 'solo') this.soloDeg = 7;
  }

  private mutateRiff(riff: RiffStep[], amount: number): RiffStep[] {
    return riff.map((s, i) => {
      if (this.rng.next() >= amount) return { ...s };
      const prev = riff[i - 1];
      if (s.kind === 'chord') return { kind: 'chord', deg: this.rng.int(0, 5) };
      if (s.kind === 'rest') return { kind: 'chug', deg: 0 };
      if (s.kind === 'chug') return prev && prev.kind !== 'rest' ? { kind: 'rest', deg: 0 } : { kind: 'chord', deg: this.rng.int(1, 4) };
      return { ...s };
    });
  }

  // ----------------------------------------------------------- the parts

  /** The chord of the bar: choruses, solos and the quiet parts move through the progression; verses mostly sit. */
  private chordAt(sec: Section): number {
    const prog = sec.kind === 'verse' || sec.kind === 'break' ? this.verseProg : this.chorusProg;
    const per = this.barSec < 2.2 ? 2 : 1; // short bars: a chord lasts two of them
    return prog[Math.floor(this.bi / per) % prog.length];
  }

  private drums(sec: Section, last: boolean, out: MusicNote[]): void {
    const S = this.steps, lvl = sec.intensity, r = this.rng;
    const soft = this.mood === 'menu' ? 0.6 : 1; // menu songs keep the drums back
    const hit = (part: Part, step: number, vel: number, len = 1, midi: number[] = []) => out.push({ part, step, len, midi, vel: vel * soft });
    const quiet = sec.kind === 'intro' || sec.kind === 'ambient' || sec.kind === 'outro';
    // The first bar of a loud section opens with a crash; choruses crash every four bars.
    if (this.bi === 0 && lvl >= 2) hit('crash', 0, 0.8, S);
    else if (sec.kind === 'chorus' && this.bi % 4 === 0) hit('crash', 0, 0.6, S);
    if (sec.kind === 'outro' && this.bi === 0 && this.si > 0 && this.form[this.si - 1].intensity >= 2) hit('crash', 0, 0.9, S);
    if (lvl === 0 && quiet) {
      // Ambient: only a low tom swell now and then.
      if (this.bi % 4 === 3 && r.next() < 0.5) hit('tom', S - 4, 0.35, 4, [this.root - 7]);
      return;
    }
    // A fill closes a section going somewhere: toms walking down the last group or two.
    const fillFrom = last && this.si < this.form.length - 1 && lvl >= 1 ? S - (lvl >= 2 ? r.pick([4, 6]) : 4) : S;
    const backbeats = this.drumGroups.map((_, i) => this.drumGroups.slice(0, i).reduce((a, b) => a + b, 0)).filter((_, i) => i % 2 === 1);
    const half = Math.floor(S / 2);
    const halfTime = lvl === 1 || sec.kind === 'break';

    if (sec.kind === 'build') {
      // A build: quarter kicks, then a snare roll that swells into the next section.
      for (let s = 0; s < S; s += 4) hit('kick', s, 0.7);
      if (last) for (let s = half; s < S; s++) hit('snare', s, 0.3 + 0.6 * (s - half) / (S - half));
      else hit('snare', half, 0.5);
      for (let s = 0; s < S; s += 2) hit('hat', s, 0.25);
      return;
    }
    for (let s = 0; s < fillFrom; s++) {
      const riff = this.riffNow[(this.bi % 2) * S + s];
      const onGuitar = riff && (riff.kind === 'chug' || riff.kind === 'chord');
      const groupStart = this.groupStart(s);
      // Kick: with the guitar's accents (the metal way), denser the louder it is.
      let kick = s === 0;
      if (sec.kind === 'verse' || sec.kind === 'break') kick ||= onGuitar && (lvl >= 2 ? (groupStart || r.next() < 0.7) : groupStart);
      else if (sec.kind === 'solo') kick ||= this.bi % 4 < 2 ? true : s % 2 === 0; // double kick runs
      else if (sec.kind === 'chorus') kick ||= s % 4 === 0 || (s % 4 === 3 && r.next() < 0.4);
      else kick ||= groupStart && r.next() < 0.5;
      if (kick) hit('kick', s, s === 0 ? 0.95 : 0.75);
      // Snare: the backbeat, or one hit in the middle at half time.
      if (halfTime ? s === half : backbeats.includes(s)) hit('snare', s, 0.85);
      else if (lvl >= 2 && s % 2 === 1 && r.next() < 0.06) hit('snare', s, 0.2); // a ghost note
      // Hats: quarters at half time, eighths otherwise.
      if (s % (halfTime ? 4 : 2) === 0) hit('hat', s, s % 4 === 0 ? 0.35 : 0.25, s === S - 2 && lvl >= 3 ? 2 : 1);
    }
    for (let s = fillFrom, k = 0; s < S; s++, k++) {
      if (s % 2 === 0 || lvl >= 3) hit('tom', s, 0.6 + 0.1 * (k % 2), 1, [this.root + 7 - Math.floor(k * 2)]);
      if (k % 2 === 1 && lvl >= 2) hit('kick', s, 0.6);
    }
  }

  /** Rhythm guitars, bass and lead. */
  private guitars(sec: Section, chord: number, out: MusicNote[]): void {
    const S = this.steps;
    const chordRoot = this.low(chord);
    const bassNote = (n: number) => n - 12;
    if (this.mood === 'match' && (sec.kind === 'verse' || sec.kind === 'break' || sec.kind === 'solo')) {
      // The riff, played over the chord. Solos ride on the riff with the chords moving underneath.
      const riff = this.riffNow;
      const first = (this.bi % 2) * S;
      const answer = this.bi % 4 === 3 && sec.kind !== 'solo'; // every fourth bar ends differently
      for (let s = 0; s < S; s++) {
        let st = riff[first + s];
        if (answer && s >= S - this.groups[this.groups.length - 1]) st = { kind: 'chord', deg: chord + 4 - (S - s) % 3 };
        if (st.kind === 'rest' || st.kind === 'hold') continue;
        let len = 1;
        if (st.kind === 'chord') while (s + len < S && riff[first + s + len]?.kind === 'hold') len++;
        const n = st.kind === 'chug' ? chordRoot : this.low(chord + st.deg);
        const mute = st.kind === 'chug';
        out.push({ part: 'rhythm', step: s, len, midi: mute ? [n, n + 7] : [n, n + 7, n + 12], vel: mute ? 0.8 : 1, mute });
        out.push({ part: 'bass', step: s, len: Math.max(len, mute ? 1 : 2), midi: [bassNote(n)], vel: 0.8 });
      }
    } else if (sec.kind === 'chorus' || (sec.kind === 'build' && this.mood === 'match' && this.bi >= 2)) {
      // Big open chords, struck on each accent group and left ringing; eighth notes under them.
      let s = 0;
      for (const g of this.groups) {
        const n = chordRoot;
        out.push({ part: 'rhythm', step: s, len: g, midi: [n, n + 7, n + 12], vel: sec.kind === 'build' ? 0.6 : 0.95 });
        out.push({ part: 'bass', step: s, len: g, midi: [bassNote(n)], vel: 0.85 });
        s += g;
      }
    } else if (sec.kind === 'outro' && this.bi === 0 && this.si > 0 && this.form[this.si - 1].intensity >= 2) {
      // The last hit after a loud song: one chord left to ring out.
      const n = this.low(0);
      out.push({ part: 'rhythm', step: 0, len: S * 2, midi: [n, n + 7, n + 12], vel: 1 });
      out.push({ part: 'bass', step: 0, len: S * 2, midi: [bassNote(n)], vel: 0.9 });
    } else if (sec.intensity >= 1 && sec.kind !== 'intro') {
      // Quiet parts with drums: the bass holds the chord root.
      out.push({ part: 'bass', step: 0, len: S, midi: [bassNote(chordRoot)], vel: 0.6 });
    }

    // Lead: the chorus melody, the solo, or a long swelling note in a battle intro.
    if (sec.kind === 'chorus') {
      const off = (this.bi % 2) * S;
      for (const m of this.melodyNow) {
        if (m.step < off || m.step >= off + S) continue;
        out.push({ part: 'lead', step: m.step - off, len: m.len, midi: [this.lead(chord + m.off)], vel: 0.8, bend: m.bend });
      }
    } else if (sec.kind === 'solo') {
      this.solo(sec, chord, out);
    } else if (sec.kind === 'intro' && this.mood === 'match' && this.bi % 4 === 2) {
      out.push({ part: 'lead', step: 0, len: S * 2, midi: [this.lead(this.rng.pick([4, 7]))], vel: 0.5, bend: 2 });
    }
  }

  /** One bar of improvised solo: phrases of chord tones and scale runs, climbing as the solo goes on. */
  private solo(sec: Section, chord: number, out: MusicNote[]): void {
    const S = this.steps, r = this.rng;
    const climb = Math.floor(4 * this.bi / sec.bars); // later in the solo, higher up
    let s = this.bi % 4 === 0 ? 0 : r.pick([0, 0, 1, 2]);
    while (s < S) {
      const run = sec.intensity >= 3 && r.next() < 0.25; // a fast run of sixteenths up or down the scale
      if (run) {
        const dir = r.next() < 0.5 ? 1 : -1;
        const n = Math.min(S - s, r.int(4, 6));
        for (let k = 0; k < n; k++, s++) {
          this.soloDeg += dir;
          out.push({ part: 'lead', step: s, len: 1, midi: [this.lead(this.clampSolo(climb))], vel: 0.75 });
        }
        continue;
      }
      const len = Math.min(S - s, r.pick([1, 2, 2, 3, 4, 6]));
      if (this.groupStart(s)) this.soloDeg = chord + this.nearestChordTone(this.soloDeg - chord + r.int(-1, 1));
      else this.soloDeg += r.pick([-2, -1, -1, 1, 1, 2, 3]);
      out.push({ part: 'lead', step: s, len, midi: [this.lead(this.clampSolo(climb))], vel: 0.85, bend: len >= 4 && r.next() < 0.4 ? 2 : 0 });
      s += len;
      if (r.next() < 0.12) s += r.pick([1, 2, 3]); // a breath between phrases
    }
  }

  private clampSolo(climb: number): number {
    const lo = 2 + climb, hi = 11 + climb;
    if (this.soloDeg < lo) this.soloDeg = lo + 1;
    if (this.soloDeg > hi) this.soloDeg = hi - 1;
    return this.soloDeg;
  }

  /** Pads and clean guitar arpeggios: the quiet parts, and a glow under the choruses. */
  private layers(sec: Section, chord: number, out: MusicNote[]): void {
    const S = this.steps;
    const per = this.barSec < 2.2 ? 2 : 1;
    const padVel = { intro: 0.7, ambient: 0.75, build: 0.6, break: 0.55, chorus: 0.35, outro: 0.7, verse: 0, solo: 0.25 }[sec.kind];
    if (padVel > 0 && this.bi % per === 0) {
      const b = this.root + 12;
      const fade = sec.kind === 'outro' ? 1 - this.bi / sec.bars : 1;
      out.push({ part: 'pad', step: 0, len: S * per, midi: [chord, chord + 2, chord + 4].map((d) => this.note(d, b)), vel: padVel * fade });
    }
    const arp = sec.kind === 'intro' || sec.kind === 'ambient' || sec.kind === 'break' || sec.kind === 'outro' || (sec.kind === 'build' && this.mood === 'menu');
    if (!arp) return;
    const fade = sec.kind === 'outro' ? 1 - this.bi / sec.bars : 1;
    // Every four bars the pattern turns (starts further along) and, now and then, climbs an octave.
    const phrase = Math.floor(this.bi / 4);
    const turn = phrase * 3, up = phrase % 3 === 2 ? 7 : 0;
    for (let s = 0, k = 0; s < S; s += this.arpRate, k++) {
      const d = this.arpNow[(k + turn) % this.arpNow.length] + (k % 2 === 1 ? up : 0);
      out.push({ part: 'clean', step: s, len: this.arpRate * 2, midi: [this.note(chord + d, this.root + 12)], vel: (k === 0 ? 0.7 : 0.5) * fade });
    }
    // Long ambient parts: every other phrase, the song's melody comes in softly on a clean guitar above.
    if (sec.kind === 'ambient' && phrase % 2 === 1) {
      const off = (this.bi % 2) * S;
      for (const m of this.melodyNow) {
        if (m.step < off || m.step >= off + S) continue;
        out.push({ part: 'clean', step: m.step - off, len: m.len + 2, midi: [this.lead(chord + m.off)], vel: 0.6 });
      }
    }
  }

  // ------------------------------------------------------------- helpers

  /** MIDI note of a scale degree (any integer: negative goes down, 7 is the octave) above `base`. */
  note(deg: number, base: number): number {
    const o = Math.floor(deg / 7);
    return base + o * 12 + this.scale[((deg % 7) + 7) % 7];
  }

  /** A degree on the low strings: within the octave above the lowest string, which nothing goes under. */
  private low(deg: number): number {
    let n = this.note(deg, this.root);
    while (n > this.root + 11) n -= 12;
    while (n < this.root) n += 12;
    return n;
  }

  /**
   * A degree for the lead guitar, folded by octaves into its register: two octaves
   * above the lowest string, up to about A5 at most, so the melody sings without shrieking.
   */
  private lead(deg: number): number {
    const lo = this.root + 24, hi = Math.min(84, this.root + 43);
    let n = this.note(deg, lo);
    while (n > hi) n -= 12;
    while (n < lo) n += 12;
    return n;
  }

  private groupStart(step: number): boolean {
    let at = 0;
    for (const g of this.groups) { if (at === step) return true; at += g; }
    return false;
  }

  /** The chord tone (root, third, fifth in any octave) nearest to a degree offset from the chord's root. */
  private nearestChordTone(off: number): number {
    const m = ((off % 7) + 7) % 7;
    const down = m === 0 || m === 2 || m === 4 ? 0 : m === 1 || m === 3 || m === 5 ? 1 : 2; // 6 goes up to the octave
    return m === 6 ? off + 1 : off - down;
  }
}
