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
  | 'pickup' | 'throw' | 'empty' | 'thud' | 'respawn' | 'ui' | 'pad' | 'tele' | 'snap' | 'hiss';

type Synth = (s: Sfx, out: AudioNode, t: number) => void;

// Three knobs for the overall character. Raise them for a sharper mix, lower for a duller one.
const MASTER_CUTOFF = 6500; // Hz, final low-pass (was 3800 when it sounded muffled)
const BRIGHT = 1.4; // multiplier on every gun's blast brightness
const SNAP = 0.22; // loudness of the gunshot snap relative to the shot (0 = none)
const SNAP_HZ = 2600;
// How far positional sounds (other players' shots, steps, explosions) carry.
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
  needle: (s, o, t) => {
    gun(s, o, t, 1400, 0.55, 1.0, 54);
    s.tone(o, t, 'sine', 720, 170, 0.42, 0.14); // the round falling away into the distance
  },
  bouncer: (s, o, t) => {
    s.tone(o, t, 'sine', 180, 540, 0.12, 0.5);
    s.tone(o, t + 0.06, 'triangle', 540, 250, 0.17, 0.32);
    s.noise(o, t, 'lowpass', 1200, 300, 0.06, 0.3);
  },
  verdict: (s, o, t) => {
    s.tone(o, t, 'sine', 95, 42, 0.65, 1.1);
    s.tone(o, t, 'sawtooth', 300, 55, 0.45, 0.5);
    s.noise(o, t, 'lowpass', 2000, 140, 0.55, 0.8);
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

  /** Voice chat plugs into the same context and master chain. Null until unlock(). */
  get context(): AudioContext | null { return this.ctx; }
  get output(): AudioNode { return this.master; }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
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
    g.gain.value = gain;
    g.connect(dest);
    SOUNDS[id](this, g, ctx.currentTime);
  }

  /** Volume envelope: a 4 ms fade-in (no click), then an exponential decay. */
  private envelope(g: GainNode, t: number, dur: number, vol: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(dur, 0.012));
  }

  /** Oscillator with a pitch sweep f0 -> f1 and a decaying envelope. */
  tone(out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.envelope(g, t, dur, vol);
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

  /** Filtered soft noise with a filter sweep f0 -> f1 and a decaying envelope. */
  noise(out: AudioNode, t: number, type: BiquadFilterType, f0: number, f1: number, dur: number, vol: number, q = 0.7): void {
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
    this.envelope(g, t, dur, vol);
    src.connect(flt).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.03);
  }
}
