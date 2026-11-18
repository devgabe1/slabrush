import type { WeaponId } from '../config/weapons';
import type { Vec3 } from '../core/vec';

// Every sound is synthesized with the Web Audio API: oscillator sweeps for
// tone, filtered noise bursts for body. No audio files.
//
// Voicing rules. The first version was shrill, the second muffled; this is the
// middle, leaning warm:
//   - everything goes through a master low-pass at 6.5 kHz: presence stays, sizzle goes
//   - noise is lightly pre-softened and shaped with LOW-pass filters: thump, not hiss
//   - guns are a low noise body + a sub thump + a short knock, plus a small,
//     quiet snap around 2-3 kHz so they cut through instead of sounding boxed in
//   - harsh waveforms (square, sawtooth) get their own low-pass per note
//   - feedback blips (hit, pickup, UI) sit between 400 and 1200 Hz, on soft waves

/** Every weapon id is also a sound id: its firing sound. */
export type SoundId =
  | WeaponId | 'explosion'
  | 'hit' | 'headshot' | 'kill' | 'hurt' | 'death'
  | 'jump' | 'land' | 'step' | 'walljump' | 'slide'
  | 'pickup' | 'throw' | 'empty' | 'thud' | 'respawn' | 'ui' | 'pad' | 'tele' | 'snap' | 'hiss'
  | 'splash' | 'cut' | 'splat' | 'uppercut' | 'bell' | 'party' | 'confetti'
  | 'grab' | 'drop' | 'fling';

type Synth = (s: Sfx, out: AudioNode, t: number) => void;

// Three knobs for the overall character. Raise them for a sharper mix, lower for a duller one.
const MASTER_CUTOFF = 6500; // Hz, final low-pass (was 3800 when it sounded muffled)
const BRIGHT = 1.4; // multiplier on every gun's blast brightness
const SNAP = 0.22; // loudness of the gunshot snap relative to the shot (0 = none)
const SNAP_HZ = 2600;
// How far positional sounds (other players' shots, steps, explosions) carry.
/**
 * Per-sound volume (1 = as synthesized). The NEEDLE and the VERDICT are driven
 * into hard saturation, so their character does not change with level: this
 * only sets how loud they are. They were at 1.6 and that was too much.
 */
export const SOUND_VOLUME: Partial<Record<SoundId, number>> = { needle: 0.8, verdict: 0.8 };
const HEAR_NEAR = 12; // metres at full volume
const HEAR_FALLOFF = 1; // higher = fades faster with distance

/**
 * A gunshot. `cut` = how bright the blast is (Hz), `dur` = how long it rings,
 * `low` = pitch of the thump (lower = bigger gun).
 */
function gun(s: Sfx, o: AudioNode, t: number, cut: number, dur: number, vol: number, low: number): void {
  s.noise(o, t, 'lowpass', cut * BRIGHT, Math.max(90, cut * 0.12), dur, vol);
  s.tone(o, t, 'sine', low * 1.9, low * 0.5, Math.min(dur, 0.36), vol * 0.9);
  s.tone(o, t, 'triangle', low * 3.2, low, 0.05, vol * 0.4);
  s.noise(o, t, 'bandpass', SNAP_HZ, SNAP_HZ * 0.7, 0.035, vol * SNAP, 1.2); // the snap
}
/** Something swung or thrown through the air. */
function whoosh(s: Sfx, o: AudioNode, t: number, f0: number, f1: number, dur: number, vol: number): void {
  s.noise(o, t, 'bandpass', f0, f1, dur, vol, 0.9);
}

const SOUNDS: Record<SoundId, Synth> = {
  fists: (s, o, t) => whoosh(s, o, t, 420, 190, 0.12, 0.6),

  // ------------------------------------------------------------- pistols
  rivet: (s, o, t) => gun(s, o, t, 1900, 0.13, 0.7, 95),
  pepper: (s, o, t) => gun(s, o, t, 2100, 0.07, 0.5, 118),
  magnate: (s, o, t) => gun(s, o, t, 1500, 0.36, 1.0, 62),
  gambler: (s, o, t) => {
    gun(s, o, t, 1700, 0.17, 0.75, 88);
    s.tone(o, t + 0.05, 'triangle', 620, 620, 0.05, 0.14); // a coin, somewhere
    s.tone(o, t + 0.1, 'triangle', 830, 830, 0.08, 0.14);
  },

  // ---------------------------------------------------------- automatics
  chatter: (s, o, t) => gun(s, o, t, 1700, 0.08, 0.55, 104),
  hornet: (s, o, t) => gun(s, o, t, 2000, 0.045, 0.38, 132),
  ledger: (s, o, t) => gun(s, o, t, 1600, 0.15, 0.75, 84),
  kingpin: (s, o, t) => gun(s, o, t, 1500, 0.055, 0.5, 78),

  // ------------------------------------------------------------ shotguns
  slab: (s, o, t) => {
    gun(s, o, t, 1300, 0.42, 1.0, 58);
    s.tone(o, t + 0.32, 'triangle', 150, 110, 0.05, 0.16); // pump
    s.tone(o, t + 0.42, 'triangle', 200, 140, 0.05, 0.16);
  },
  twins: (s, o, t) => gun(s, o, t, 1100, 0.62, 1.3, 45),

  // ----------------------------------------------------------- precision
  needle: (s, o, t) => { // a heavy-magnum bolt-action sniper, in the classic tactical-shooter style
    // Everything but the bolt goes through hard saturation: that is what makes
    // it bark instead of pop, and sound far louder than its peak.
    const hot = s.drive(o, 4.5);
    // The crack: the supersonic round, a vicious bright snap.
    s.noise(hot, t, 'bandpass', 3800, 2200, 0.05, 1.6, 0.9);
    s.noise(hot, t, 'highpass', 2600, 1600, 0.03, 1.0);
    // The bark: a big mid-range punch, then the boom under it.
    s.tone(hot, t, 'sawtooth', 420, 90, 0.12, 1.2);
    s.noise(hot, t, 'lowpass', 3000, 110, 0.9, 1.9);
    s.tone(hot, t, 'sine', 110, 30, 0.8, 1.8); // the sub you feel
    s.tone(o, t, 'sine', 62, 28, 0.6, 0.9); // clean low end under the grit
    // The tail: the shot slamming off walls and rolling away across the map.
    for (const [d, v] of [[0.09, 0.7], [0.2, 0.5], [0.34, 0.34], [0.52, 0.2], [0.75, 0.1]] as const) {
      s.noise(hot, t + d, 'lowpass', 1100, 140, 0.35, v);
    }
    // The bolt, cycled once the rifle comes down: back... and forward.
    for (const [d, f] of [[0.68, 1300], [0.86, 1050]] as const) {
      s.noise(o, t + d, 'bandpass', f * 2, f, 0.05, 0.4, 4);
      s.tone(o, t + d, 'triangle', f, f * 0.6, 0.045, 0.22);
    }
    s.tone(o, t + 0.88, 'sine', 180, 120, 0.07, 0.25); // the bolt seating home
  },
  bouncer: (s, o, t) => {
    s.tone(o, t, 'sine', 180, 540, 0.12, 0.5);
    s.tone(o, t + 0.06, 'triangle', 540, 250, 0.17, 0.32);
    s.noise(o, t, 'lowpass', 1200, 300, 0.06, 0.3);
  },
  verdict: (s, o, t) => { // the railgun: the NEEDLE's punch made of synth, a flat wall of sound, then cut dead
    const CUT = 0.3, HIT = 0.04; // the impact dives for 40 ms; after that NOTHING changes until the cut
    const len = CUT + 0.05; // every held layer outlasts the gate
    const cut = s.gate(o, t, CUT);
    const hot = s.drive(cut, 6); // hard drive pins the level flat
    // Impact (first 40 ms only): the crack and a pitch dive, like the sniper's report.
    s.noise(hot, t, 'bandpass', 4600, 2400, 0.05, 1.4, 0.9);
    s.tone(hot, t, 'sawtooth', 900, 220, HIT, 1.0);
    s.fm(hot, t, 1500, 330, 1.41, 8, 4, HIT, 0.8);
    // The wall: constant pitch, constant brightness, constant level, all held until the gate.
    // (A falling pitch sounds like falling volume, so nothing here moves.)
    const at = t + HIT * 0.6; // slides in under the end of the impact
    s.tone(hot, at, 'sawtooth', 220, 220, len, 0.85, true); // the bark, sustained
    s.noise(hot, at, 'lowpass', 2600, 2600, len, 1.2, 0.7, true); // the roar
    s.tone(hot, at, 'sine', 55, 55, len, 1.4, true); // the sub, driven
    s.tone(cut, at, 'sine', 55, 55, len, 0.7, true); // and clean underneath
    s.fm(hot, at, 330, 330, 1.41, 4, 4, len, 0.85, true); // metallic synth body
    s.fm(hot, at, 660, 660, 2.0, 3, 3, len, 0.45, true);
    s.tone(hot, at, 'square', 1320, 1320, len, 0.3, true); // the laser edge
    s.fm(cut, at, 1760, 1760, 3.5, 2.5, 2.5, len, 0.2, true); // a high synthetic ring
  },
  stapler: (s, o, t) => {
    s.tone(o, t, 'triangle', 300, 105, 0.08, 0.65);
    s.noise(o, t, 'lowpass', 1400, 280, 0.07, 0.5);
  },

  // ---------------------------------------------------------- explosives
  postman: (s, o, t) => {
    whoosh(s, o, t, 200, 1100, 0.46, 0.7);
    s.tone(o, t, 'sine', 68, 150, 0.32, 0.65);
  },
  bigone: (s, o, t) => {
    whoosh(s, o, t, 140, 650, 0.8, 0.9);
    s.tone(o, t, 'sine', 44, 105, 0.6, 0.9);
  },
  lobber: (s, o, t) => {
    s.tone(o, t, 'sine', 200, 60, 0.16, 0.85);
    s.noise(o, t, 'lowpass', 650, 180, 0.11, 0.5);
  },
  pinata: (s, o, t) => {
    s.tone(o, t, 'sine', 220, 70, 0.15, 0.8);
    s.noise(o, t, 'lowpass', 700, 200, 0.1, 0.45);
    [330, 415, 494].forEach((f, i) => s.tone(o, t + 0.04 + i * 0.045, 'triangle', f, f, 0.06, 0.13));
  },
  pineapple: (s, o, t) => {
    s.tone(o, t, 'triangle', 900, 760, 0.07, 0.18); // the pin
    whoosh(s, o, t + 0.03, 350, 900, 0.2, 0.42);
  },
  clinger: (s, o, t) => {
    whoosh(s, o, t, 350, 850, 0.15, 0.38);
    s.tone(o, t + 0.1, 'triangle', 600, 600, 0.05, 0.18);
    s.tone(o, t + 0.2, 'triangle', 760, 760, 0.05, 0.18);
  },
  potato: (s, o, t) => {
    whoosh(s, o, t, 300, 800, 0.2, 0.45);
    s.tone(o, t, 'sine', 170, 110, 0.1, 0.3);
  },

  // --------------------------------------------------------------- melee
  shiv: (s, o, t) => whoosh(s, o, t, 1800, 3400, 0.07, 0.34),
  slugger: (s, o, t) => {
    whoosh(s, o, t, 220, 700, 0.2, 0.7);
    s.tone(o, t, 'sine', 105, 55, 0.12, 0.35);
  },
  banhammer: (s, o, t) => {
    whoosh(s, o, t, 130, 480, 0.4, 1.0);
    s.tone(o, t, 'sine', 72, 36, 0.36, 0.8);
  },
  fish: (s, o, t) => { // a wet slap
    s.noise(o, t, 'lowpass', 1500, 280, 0.09, 0.7);
    s.tone(o, t, 'sine', 300, 135, 0.1, 0.45);
    s.tone(o, t + 0.03, 'triangle', 170, 260, 0.09, 0.25);
  },

  // --------------------------------------------------------------- weird
  zapper: (s, o, t) => {
    s.tone(o, t, 'sawtooth', 96, 84, 0.06, 0.34);
    s.tone(o, t, 'triangle', 700, 440, 0.05, 0.07);
  },
  toaster: (s, o, t) => {
    whoosh(s, o, t, 480, 880, 0.1, 0.42);
    s.tone(o, t, 'sine', 74, 66, 0.09, 0.3);
  },
  icebox: (s, o, t) => {
    s.tone(o, t, 'sine', 520, 290, 0.11, 0.3);
    s.noise(o, t, 'bandpass', 900, 600, 0.06, 0.2, 2);
  },
  reeler: (s, o, t) => {
    s.tone(o, t, 'triangle', 240, 115, 0.13, 0.55);
    s.noise(o, t, 'lowpass', 900, 190, 0.16, 0.45);
  },
  gust: (s, o, t) => {
    whoosh(s, o, t, 150, 1500, 0.58, 1.1);
    s.tone(o, t, 'sine', 50, 122, 0.34, 0.6);
  },
  swapper: (s, o, t) => {
    s.tone(o, t, 'sine', 300, 820, 0.16, 0.4);
    s.tone(o, t + 0.08, 'triangle', 820, 240, 0.22, 0.32);
  },

  // --------------------------------------------------------------- traps
  snapper: (s, o, t) => whoosh(s, o, t, 320, 800, 0.16, 0.4),
  popper: (s, o, t) => whoosh(s, o, t, 320, 800, 0.16, 0.4),
  stinker: (s, o, t) => whoosh(s, o, t, 320, 800, 0.16, 0.4),
  sentry: (s, o, t) => gun(s, o, t, 1800, 0.07, 0.5, 110), // also the sound of it firing
  snap: (s, o, t) => { // jaws closing
    s.tone(o, t, 'triangle', 900, 300, 0.05, 0.6);
    s.noise(o, t, 'bandpass', 2400, 900, 0.07, 0.6, 1.5);
    s.tone(o, t + 0.02, 'sine', 160, 70, 0.12, 0.6);
  },
  hiss: (s, o, t) => s.noise(o, t, 'bandpass', 2600, 1500, 1.2, 0.45, 0.8),

  // ------------------------------------------------------- melee powers
  splash: (s, o, t) => { // FISH hit: a big splash of water
    // The slap: a fat wet impact, broad and soft.
    s.noise(o, t, 'lowpass', 5200, 900, 0.12, 1.1);
    s.tone(o, t, 'sine', 140, 70, 0.1, 0.6);
    // The water itself flying out: a hissy "shhhh" that closes down as it falls.
    s.noise(o, t + 0.015, 'bandpass', 3200, 700, 0.45, 0.85, 0.6);
    s.noise(o, t + 0.03, 'highpass', 4000, 2200, 0.3, 0.3);
    // A low slosh as the bulk of it lands.
    s.noise(o, t + 0.12, 'lowpass', 700, 180, 0.3, 0.55);
    s.tone(o, t + 0.1, 'sine', 170, 320, 0.12, 0.3); // the "glug"
    // Droplets raining back down: little rising plinks (that is how drops sound).
    for (let k = 0; k < 14; k++) {
      const at = t + 0.12 + Math.random() * 0.55, f = 900 + Math.random() * 1900; // audio only, not gameplay
      s.tone(o, at, 'sine', f, f * 1.7, 0.03 + Math.random() * 0.03, 0.06 + Math.random() * 0.08);
    }
  },
  party: (s, o, t) => { // PINATA bursting: a party popper, a horn, a fanfare and maracas
    // The popper: a bright crack and a puff of air.
    s.noise(o, t, 'bandpass', 3000, 1500, 0.05, 1.0, 1.2);
    s.tone(o, t, 'triangle', 700, 300, 0.06, 0.5);
    // A party horn: a wobbly, buzzy "bweeeee" that rises, then droops at the end.
    s.tone(o, t + 0.05, 'sawtooth', 520, 700, 0.42, 0.42);
    s.tone(o, t + 0.05, 'square', 523, 703, 0.42, 0.18);
    s.tone(o, t + 0.47, 'sawtooth', 700, 420, 0.16, 0.3);
    // A little major-key fanfare on top: da-da-da-DAAA.
    [[523, 0.06], [659, 0.15], [784, 0.24], [1047, 0.33]].forEach(([f, d], i) => {
      s.tone(o, t + d, 'triangle', f, f, i === 3 ? 0.5 : 0.11, 0.32);
      s.tone(o, t + d, 'sine', f * 2, f * 2, i === 3 ? 0.35 : 0.08, 0.1); // a bit of sparkle
    });
    // Maracas: shaka-shaka-shaka.
    for (let k = 0; k < 6; k++) s.noise(o, t + 0.1 + k * 0.09, 'highpass', 6000, 4500, 0.05, 0.28, 0.8);
    // And a few kazoo-ish "toots" to finish it off.
    [[0.62, 784], [0.72, 988]].forEach(([d, f]) => s.tone(o, t + d, 'square', f, f, 0.08, 0.14));
  },
  confetti: (s, o, t) => { // a PINATA bomblet: a little festive pop, each on its own note
    // Notes of one happy chord (C major, over two octaves), picked at random, so
    // six bomblets going off together sound like a celebration, not six bangs.
    const notes = [523, 659, 784, 1047, 1319, 1568];
    const f = notes[Math.floor(Math.random() * notes.length)]; // audio only, not gameplay
    s.noise(o, t, 'bandpass', 3400, 1600, 0.04, 0.8, 1.3); // popper crack
    s.tone(o, t, 'triangle', f, f, 0.16, 0.34); // its note
    s.tone(o, t + 0.04, 'triangle', f * 1.5, f * 1.5, 0.12, 0.2); // and the fifth above it: ta-DA
    s.tone(o, t, 'sine', f * 2, f * 2, 0.09, 0.1); // sparkle
    s.tone(o, t + 0.02, 'square', f / 2, f * 0.62, 0.12, 0.12); // a short squeak of party blower
    s.noise(o, t + 0.05, 'highpass', 6000, 4500, 0.06, 0.2, 0.8); // a shake of the maracas
  },
  cut: (s, o, t) => { // SHIV: a thin slice that opens a wound
    s.noise(o, t, 'bandpass', 3200, 2000, 0.06, 0.45, 2);
    s.tone(o, t + 0.03, 'triangle', 300, 140, 0.1, 0.2);
  },
  splat: (s, o, t) => { // SLUGGER: someone meets a wall at speed
    s.tone(o, t, 'sine', 140, 40, 0.3, 1.1);
    s.noise(o, t, 'lowpass', 1400, 120, 0.25, 1.0);
    s.tone(o, t + 0.04, 'triangle', 420, 120, 0.12, 0.35);
  },
  bell: (s, o, t) => { // BANHAMMER hit: a great church bell, tolling for whoever was hit
    // A bell's overtones are not harmonic: hum, strike note, minor-third "tierce",
    // fifth, nominal (the octave) and a few high partials, the low ones ringing
    // longest. Each partial has a slightly detuned twin, so the toll beats and
    // shimmers as it dies away, like a big cast bell.
    const f = 98; // strike note (G2): a large tower bell
    const partials: [ratio: number, vol: number, dur: number][] = [
      [0.5, 0.42, 13], // hum, the last thing you hear
      [1, 0.4, 11], // prime / strike note
      [1.19, 0.3, 8.5], // tierce: the minor third that makes it sound like a bell
      [1.5, 0.16, 6], // quint
      [2, 0.34, 7.5], // nominal
      [2.51, 0.13, 3.2],
      [2.66, 0.12, 2.8],
      [3.01, 0.13, 2.4],
      [4.07, 0.09, 1.6],
      [5.15, 0.06, 1.1],
      [6.27, 0.04, 0.8],
    ];
    for (const [ratio, vol, dur] of partials) {
      s.tone(o, t, 'sine', f * ratio, f * ratio * 0.9995, dur, vol);
      s.tone(o, t, 'sine', f * ratio + 0.35 + ratio * 0.3, f * ratio + 0.35 + ratio * 0.3, dur * 0.9, vol * 0.6); // the beat
    }
    // The clapper striking bronze: a bright metallic clang that dies at once.
    s.noise(o, t, 'bandpass', 3400, 1800, 0.09, 0.55, 3);
    s.tone(o, t, 'triangle', 1960, 1940, 0.25, 0.14);
    s.tone(o, t, 'sine', 70, 49, 0.35, 0.5); // and the weight of it
  },
  uppercut: (s, o, t) => { // FISTS: the third hit of a combo
    s.noise(o, t, 'lowpass', 1600, 300, 0.12, 0.9);
    s.tone(o, t, 'sine', 110, 260, 0.18, 0.8);
    s.tone(o, t + 0.06, 'triangle', 660, 990, 0.12, 0.22);
  },

  // --------------------------------------------------------------- world
  explosion: (s, o, t) => {
    s.noise(o, t, 'lowpass', 2200, 45, 1.15, 1.4);
    s.noise(o, t, 'bandpass', 1800, 700, 0.12, 0.3); // the crack at the front of the blast
    s.tone(o, t, 'sine', 62, 20, 0.95, 1.3);
    s.tone(o, t, 'triangle', 130, 40, 0.25, 0.5);
  },
  hit: (s, o, t) => s.tone(o, t, 'triangle', 620, 440, 0.05, 0.32),
  headshot: (s, o, t) => {
    s.tone(o, t, 'sine', 880, 1180, 0.13, 0.36);
    s.tone(o, t, 'triangle', 590, 590, 0.06, 0.16);
  },
  kill: (s, o, t) => {
    s.tone(o, t, 'triangle', 440, 440, 0.07, 0.28);
    s.tone(o, t + 0.07, 'triangle', 660, 660, 0.13, 0.28);
  },
  hurt: (s, o, t) => {
    s.tone(o, t, 'sawtooth', 150, 65, 0.17, 0.5);
    s.noise(o, t, 'lowpass', 600, 160, 0.1, 0.4);
  },
  death: (s, o, t) => s.tone(o, t, 'sawtooth', 220, 35, 0.6, 0.55),
  jump: (s, o, t) => {
    s.tone(o, t, 'sine', 150, 235, 0.09, 0.2);
    s.noise(o, t, 'lowpass', 500, 250, 0.06, 0.1);
  },
  walljump: (s, o, t) => {
    s.tone(o, t, 'triangle', 210, 360, 0.1, 0.32);
    s.noise(o, t, 'lowpass', 700, 300, 0.08, 0.22);
  },
  // ----------------------------------------------------------- legendary
  // MONOLOGUE: the beam throbs (one pulse every quarter second while it is on),
  // seizes with a rising wobble, lets go with a falling one.
  tirade: (s, o, t) => gun(s, o, t, 2300, 0.035, 0.4, 150), // one round of ~55 a second: together, a buzzsaw roar
  monologue: (s, o, t) => {
    s.fm(o, t, 62, 58, 2, 3.5, 2, 0.32, 0.32);
    s.tone(o, t, 'sine', 124, 118, 0.26, 0.12);
  },
  grab: (s, o, t) => {
    s.fm(o, t, 70, 150, 1.5, 4, 1.5, 0.4, 0.42);
    s.noise(o, t, 'lowpass', 500, 1400, 0.25, 0.22);
  },
  drop: (s, o, t) => s.fm(o, t, 150, 55, 1.5, 2, 4, 0.35, 0.36),
  fling: (s, o, t) => {
    s.fm(o, t, 160, 50, 2, 2, 5, 0.3, 0.4);
    whoosh(s, o, t, 300, 1200, 0.32, 0.5);
  },
  land: (s, o, t) => {
    s.noise(o, t, 'lowpass', 600, 110, 0.1, 0.55);
    s.tone(o, t, 'sine', 82, 40, 0.1, 0.42);
  },
  step: (s, o, t) => s.noise(o, t, 'lowpass', 650, 180, 0.05, 0.26),
  slide: (s, o, t) => whoosh(s, o, t, 700, 240, 0.5, 0.3),
  pickup: (s, o, t) => {
    s.tone(o, t, 'triangle', 392, 392, 0.05, 0.22);
    s.tone(o, t + 0.05, 'triangle', 587, 587, 0.09, 0.22);
  },
  throw: (s, o, t) => whoosh(s, o, t, 350, 900, 0.17, 0.42),
  empty: (s, o, t) => s.tone(o, t, 'triangle', 700, 500, 0.03, 0.2),
  thud: (s, o, t) => {
    s.tone(o, t, 'sine', 120, 55, 0.07, 0.42);
    s.noise(o, t, 'lowpass', 600, 220, 0.04, 0.22);
  },
  respawn: (s, o, t) => s.tone(o, t, 'triangle', 196, 440, 0.25, 0.26),
  ui: (s, o, t) => s.tone(o, t, 'triangle', 520, 520, 0.04, 0.18),
  pad: (s, o, t) => {
    s.tone(o, t, 'sine', 110, 520, 0.28, 0.42);
    whoosh(s, o, t, 300, 1400, 0.3, 0.3);
  },
  tele: (s, o, t) => {
    s.tone(o, t, 'sine', 700, 220, 0.3, 0.35);
    s.tone(o, t + 0.04, 'triangle', 350, 900, 0.22, 0.2);
  },
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private voiceMaster!: GainNode;
  private noiseBuf!: AudioBuffer;
  private volume = 0.7;

  /** Must be called from a user gesture (browser autoplay rules). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Master tone: roll off the top, lift the bottom, then limit.
    const top = ctx.createBiquadFilter();
    top.type = 'lowpass';
    top.frequency.value = MASTER_CUTOFF;
    top.Q.value = 0.5;
    const bottom = ctx.createBiquadFilter();
    bottom.type = 'lowshelf';
    bottom.frequency.value = 180;
    bottom.gain.value = 3;
    const comp = ctx.createDynamicsCompressor(); // keeps shotgun + explosion from clipping
    this.master.connect(top).connect(bottom).connect(comp).connect(ctx.destination);
    // Voices skip the game's tone shaping (its bass lift and top cut would make a
    // thin voice sound dull and low); they only share the volume, plus a limiter.
    this.voiceMaster = ctx.createGain();
    this.voiceMaster.gain.value = this.volume;
    const vcomp = ctx.createDynamicsCompressor();
    this.voiceMaster.connect(vcomp).connect(ctx.destination);

    // Soft noise: white noise run through a one-pole low-pass while it is
    // generated, so even an unfiltered burst has no hiss in it.
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last += ((Math.random() * 2 - 1) - last) * 0.45; // audio only, not gameplay
      data[i] = last * 1.7;
    }
  }

  /** Voice chat plugs into the same context, on its own clean output. Null until unlock(). */
  get context(): AudioContext | null { return this.ctx; }
  get output(): AudioNode { return this.voiceMaster; }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.value = this.voiceMaster.gain.value = v;
  }

  setListener(pos: Vec3, yaw: number, pitch: number): void {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else {
      l.setPosition(pos.x, pos.y, pos.z); // older Firefox
      l.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /** pos = null plays it "in your head" (own actions, UI); otherwise positional. */
  play(id: SoundId, pos: Vec3 | null = null, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    let dest: AudioNode = this.master;
    if (pos) {
      const pn = ctx.createPanner();
      pn.panningModel = 'equalpower';
      pn.distanceModel = 'inverse';
      // Full volume within HEAR_NEAR metres, then fading gently: across a whole
      // map (about 50 m) a shot is still at a quarter of its volume.
      pn.refDistance = HEAR_NEAR;
      pn.rolloffFactor = HEAR_FALLOFF;
      pn.positionX.value = pos.x; pn.positionY.value = pos.y; pn.positionZ.value = pos.z;
      pn.connect(this.master);
      dest = pn;
    }
    const g = ctx.createGain();
    g.gain.value = gain * (SOUND_VOLUME[id] ?? 1);
    g.connect(dest);
    SOUNDS[id](this, g, ctx.currentTime);
  }

  /**
   * Render a sound into an offline buffer (development: listen to a sound
   * without playing a match). Uses the same synthesis as play().
   */
  static async render(id: SoundId, seconds: number, sampleRate = 44100): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
    const s = Object.create(Sfx.prototype) as Sfx;
    const self = s as unknown as { ctx: BaseAudioContext; noiseBuf: AudioBuffer };
    self.ctx = ctx;
    self.noiseBuf = ctx.createBuffer(1, sampleRate, sampleRate);
    const data = self.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) { last += ((Math.random() * 2 - 1) - last) * 0.45; data[i] = last * 1.7; }
    const g = ctx.createGain();
    g.connect(ctx.destination);
    SOUNDS[id](s, g, 0);
    return ctx.startRendering();
  }

  /**
   * Volume envelope: a 4 ms fade-in (no click), then an exponential decay.
   * `held`: no decay at all, full volume for the whole `dur` (for sounds that end on a gate).
   */
  private envelope(g: GainNode, t: number, dur: number, vol: number, held = false): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    if (!held) g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(dur, 0.012));
  }

  /** Oscillator with a pitch sweep f0 -> f1 and a decaying envelope. */
  tone(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, held = false): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.envelope(g, t, dur, vol, held);
    if (type === 'square' || type === 'sawtooth') {
      // Buzzy waveforms keep only their first few harmonics.
      const soft = ctx.createBiquadFilter();
      soft.type = 'lowpass';
      soft.frequency.value = Math.min(3200, Math.max(400, Math.max(f0, f1) * 4));
      osc.connect(soft).connect(g).connect(out);
    } else {
      osc.connect(g).connect(out);
    }
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  /**
   * Saturation: whatever is connected to the returned node gets driven into a
   * soft clipper (tanh) on its way to `out`. More drive = grittier, more
   * aggressive, and louder-sounding at the same peak level.
   */
  drive(out: AudioNode, amount: number): AudioNode {
    const ctx = this.ctx!;
    const shaper = ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n), norm = Math.tanh(amount);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(amount * x) / norm; }
    shaper.curve = curve;
    shaper.oversample = '2x';
    shaper.connect(out);
    return shaper;
  }

  /**
   * A hard gate: everything connected to the returned node plays at full
   * volume until `hold` seconds after `t`, then is cut to silence in 1 ms.
   * For sounds that should stop dead instead of fading.
   */
  gate(out: AudioNode, t: number, hold: number): AudioNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(1, t);
    g.gain.setValueAtTime(1, t + hold);
    g.gain.linearRampToValueAtTime(0, t + hold + 0.001); // 1 ms: a cut, not a fade
    g.connect(out);
    return g;
  }

  /**
   * FM tone: a carrier whose frequency is wobbled by a modulator at `ratio`
   * times the carrier; `index` (start -> end) is how hard. Rich, metallic,
   * moving timbres from two oscillators: the sound of synths and sci-fi.
   */
  fm(out: AudioNode, t: number, f0: number, f1: number, ratio: number, index0: number, index1: number, dur: number, vol: number, held = false): void {
    const ctx = this.ctx!;
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), depth = ctx.createGain(), g = ctx.createGain();
    car.frequency.setValueAtTime(f0, t);
    car.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    mod.frequency.setValueAtTime(f0 * ratio, t);
    mod.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * ratio), t + dur);
    depth.gain.setValueAtTime(f0 * index0, t);
    depth.gain.exponentialRampToValueAtTime(Math.max(1, f1 * index1), t + dur);
    mod.connect(depth).connect(car.frequency);
    this.envelope(g, t, dur, vol, held);
    car.connect(g).connect(out);
    car.start(t); mod.start(t);
    car.stop(t + dur + 0.03); mod.stop(t + dur + 0.03);
  }

  /** Filtered soft noise with a filter sweep f0 -> f1 and a decaying envelope. */
  noise(out: AudioNode, t: number, type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, q = 0.7, held = false): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
    const g = ctx.createGain();
    this.envelope(g, t, dur, vol, held);
    src.connect(flt).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.03);
  }
}
