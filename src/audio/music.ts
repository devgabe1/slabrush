import { MUSIC } from '../config/music';
import { Composer, type Bar, type Mood, type MusicNote } from './composer';

// The soundtrack's synth: plays the bars the composer writes (composer.ts).
// Synthesised like every other sound, no audio files.
//
// Voicing:
//   - guitars are plucked strings (Karplus-Strong: a burst of noise fed back
//     through a short delay), not oscillators, so they have a real attack and
//     ring. Rhythm guitars sum into one distortion per side, so a power chord
//     distorts as a whole and growls the way a real one does
//   - each rhythm part is played twice, on a left and a right guitar with a few
//     milliseconds and cents between them: the wide double-tracked wall
//   - palm-muted notes go through a low-pass before the distortion: tight, dark chugs
//   - after the distortion, a speaker cabinet: low cut, scooped mids, a bite
//     around 1.7 kHz, and steep low-passes so it never fizzes (keep it low-pitched)
//   - the lead is a sustained oscillator pair with bends and late vibrato, less
//     driven, with a delay and reverb
//   - quiet parts are clean plucked arpeggios and slow detuned-saw pads
// Each song gets its own chain (and its own reverb), so a song fades out as a
// whole while the next one starts.

export type MusicMood = Mood | 'off';

interface Chain {
  gain: GainNode;
  rhythm: { open: GainNode; mute: GainNode; pan: number }[];
  lead: GainNode;
  clean: GainNode;
  pad: GainNode;
  bass: GainNode;
  drums: GainNode;
  /** The drums' noise filters, shared by every hit (a filter per hit would pile up nodes). */
  kit: Record<'click' | 'snare' | 'hat' | 'crash' | 'tom', BiquadFilterNode>;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Music {
  private ctx: BaseAudioContext | null = null;
  private out!: GainNode;
  private volume: number = MUSIC.volume;
  private mood: MusicMood = 'off';
  private song: { composer: Composer; chain: Chain } | null = null;
  /** When the next bar starts, and (between songs) when the next song may start: audio clock seconds. */
  private nextAt = 0;
  private waitUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private plucks = new Map<string, { buf: AudioBuffer; rate: number }>();
  private noiseBuf!: AudioBuffer;
  private impulse!: AudioBuffer;
  private curve!: Float32Array<ArrayBuffer>;
  /** Picks each song's seed. The music is client-side only, so no peer needs to agree with it. */
  private seed = (Math.random() * 0x100000000) >>> 0;

  /** Plug into the game's audio context (after the first click unlocked it) and start the scheduler. */
  attach(ctx: AudioContext): void {
    if (this.ctx) return;
    this.setup(ctx);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.out.connect(comp).connect(ctx.destination);
    this.timer = setInterval(() => this.tick(), 50);
  }

  private setup(ctx: BaseAudioContext): void {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    const sr = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, sr, sr);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1; // audio only, not gameplay
    // Reverb: two channels of noise dying away, darker as they go.
    const len = Math.floor(sr * MUSIC.reverb);
    this.impulse = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = this.impulse.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const k = i / len;
        lp += ((Math.random() * 2 - 1) - lp) * (0.6 - 0.5 * k);
        d[i] = lp * Math.pow(1 - k, 2.2);
      }
    }
    // Distortion: a soft clip, slightly lopsided for the even harmonics of a valve amp.
    this.curve = new Float32Array(2048);
    for (let i = 0; i < this.curve.length; i++) {
      const x = (i / (this.curve.length - 1)) * 2 - 1;
      this.curve[i] = Math.tanh(3 * x + 0.15) - Math.tanh(0.15);
    }
  }

  /** Music volume, 0..1 (already multiplied by the master volume). */
  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Menu music, battle music, or none. A change fades the song out and starts one of the new kind. */
  setMood(m: MusicMood): void {
    if (m === this.mood) return;
    this.mood = m;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.song) this.fadeOut(this.song.chain, ctx.currentTime, MUSIC.fade);
    this.song = null;
    this.waitUntil = ctx.currentTime + 0.4;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Schedule bars a little ahead of the audio clock (further while the tab is hidden and timers are slow). */
  private tick(): void {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const ahead = now + 0.3 + (document.hidden ? 1.6 : 0);
    if (!this.song) {
      if (this.mood === 'off' || now < this.waitUntil) return;
      this.startSong(this.mood, now + 0.1);
    }
    while (this.song && this.nextAt < ahead) {
      const bar = this.song.composer.nextBar();
      if (!bar) {
        // The song is over: let it ring, then a pause before something new.
        const chain = this.song.chain;
        const [lo, hi] = MUSIC.gap;
        this.waitUntil = this.nextAt + lo + Math.random() * (hi - lo);
        setTimeout(() => chain.gain.disconnect(), (this.waitUntil - now) * 1000);
        this.song = null;
        break;
      }
      if (this.nextAt < now) this.nextAt = now + 0.05; // fell behind (a stalled tab): skip ahead, never cram
      this.playBar(this.song.chain, bar, this.nextAt);
      this.nextAt += bar.steps * bar.stepSec;
    }
  }

  private startSong(mood: Mood, at: number): void {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    this.song = { composer: new Composer(this.seed, mood), chain: this.buildChain(this.out, mood) };
    this.nextAt = at;
  }

  private fadeOut(chain: Chain, t: number, sec: number): void {
    chain.gain.gain.cancelScheduledValues(t);
    chain.gain.gain.setValueAtTime(chain.gain.gain.value, t);
    chain.gain.gain.linearRampToValueAtTime(0, t + sec);
    setTimeout(() => chain.gain.disconnect(), (sec + 0.5) * 1000);
  }

  /**
   * Render part of a song offline (development, and to check the mix): the
   * same synthesis as live play, into a stereo buffer.
   */
  static async render(seed: number, mood: Mood, seconds: number, sampleRate = 44100): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
    const m = new Music();
    m.setup(ctx);
    m.out.connect(ctx.destination);
    const chain = m.buildChain(m.out, mood);
    const c = new Composer(seed, mood);
    // Bars are added while it renders, a little ahead, as live play does: all
    // of them up front would keep thousands of nodes waiting in the graph.
    let t = 0.05;
    const feed = (until: number) => {
      for (let bar: Bar | null = null; t < Math.min(until, seconds) && (bar = c.nextBar()); t += bar.steps * bar.stepSec) m.playBar(chain, bar, t);
    };
    feed(2);
    for (let at = 1; at < seconds; at += 1) {
      void ctx.suspend(at).then(() => { feed(at + 2); void ctx.resume(); });
    }
    return ctx.startRendering();
  }

  // ------------------------------------------------------------ the chain

  /** `mood`: menu songs keep the distorted guitars further back, under the clean parts. */
  private buildChain(dest: AudioNode, mood: Mood): Chain {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.connect(dest);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse;
    const revIn = ctx.createGain();
    revIn.gain.value = 0.5;
    revIn.connect(reverb).connect(gain);
    // A dotted-eighth-ish echo for the lead and the clean guitar.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.36;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const delayTone = this.filter('lowpass', 2200);
    const delayIn = ctx.createGain();
    delayIn.connect(delay).connect(delayTone).connect(fb).connect(delay);
    delayTone.connect(gain);
    delayTone.connect(revIn);

    const send = (node: AudioNode, dry: number, rev: number, echo = 0) => {
      const d = ctx.createGain(); d.gain.value = dry; node.connect(d).connect(gain);
      if (rev) { const r = ctx.createGain(); r.gain.value = rev; node.connect(r).connect(revIn); }
      if (echo) { const e = ctx.createGain(); e.gain.value = echo; node.connect(e).connect(delayIn); }
    };

    const rhythm = [-0.85, 0.85].map((pan) => {
      const open = ctx.createGain(), mute = ctx.createGain();
      const amp = this.amp(MUSIC.rhythmDrive);
      open.connect(amp.input);
      mute.connect(this.filter('lowpass', 650, 0.9)).connect(amp.input);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      amp.output.connect(p);
      send(p, mood === 'menu' ? 0.12 : 0.24, 0.06);
      return { open, mute, pan };
    });

    const lead = ctx.createGain();
    const leadAmp = this.amp(MUSIC.leadDrive);
    lead.connect(leadAmp.input);
    send(leadAmp.output, 0.2, 0.22, 0.12);

    const clean = ctx.createGain();
    const cleanTone = this.filter('lowpass', 3200);
    clean.connect(cleanTone);
    send(cleanTone, 1.8, 0.9, 0.35);

    const pad = ctx.createGain();
    const padTone = this.filter('lowpass', 900, 0.7);
    pad.connect(padTone);
    send(padTone, 0.8, 0.8);

    // Bass: a little grit of its own, then only the low end and a touch of growl.
    const bass = ctx.createGain();
    const bassPre = ctx.createGain();
    bassPre.gain.value = 2.5;
    const bassShape = ctx.createWaveShaper();
    bassShape.curve = this.curve;
    const bassTone = this.filter('lowpass', 900, 0.8);
    bass.connect(bassPre).connect(bassShape).connect(bassTone);
    send(bassTone, 0.34, 0);

    const drums = ctx.createGain();
    send(drums, 0.55, 0.12);
    const kit = {
      click: this.filter('lowpass', 2500), snare: this.filter('bandpass', 1900, 0.7), hat: this.filter('highpass', 6500),
      crash: this.filter('highpass', 3800), tom: this.filter('lowpass', 900),
    };
    for (const f of Object.values(kit)) f.connect(drums);
    return { gain, rhythm, lead, clean, pad, bass, drums, kit };
  }

  /** A guitar amplifier: low cut, drive into the clipper, then the speaker cabinet. */
  private amp(drive: number): { input: GainNode; output: AudioNode } {
    const ctx = this.ctx!;
    const input = ctx.createGain();
    const tight = this.filter('highpass', 110, 0.7); // the low end stays tight under distortion
    const pre = ctx.createGain();
    pre.gain.value = drive;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.curve;
    shaper.oversample = '4x';
    const scoop = this.filter('peaking', 480, 1, -5);
    const bite = this.filter('peaking', 1700, 1.2, 3);
    const cab1 = this.filter('lowpass', 4200, 0.9);
    const cab2 = this.filter('lowpass', 5500, 0.6);
    const low = this.filter('highpass', 80, 0.7);
    input.connect(tight).connect(pre).connect(shaper).connect(low).connect(scoop).connect(bite).connect(cab1).connect(cab2);
    return { input, output: cab2 };
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7, gain = 0): BiquadFilterNode {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  }

  // ------------------------------------------------------------ the notes

  private playBar(chain: Chain, bar: Bar, t0: number): void {
    for (const n of bar.notes) {
      const t = t0 + n.step * bar.stepSec;
      const dur = n.len * bar.stepSec;
      switch (n.part) {
        case 'rhythm': this.rhythm(chain, n, t, dur); break;
        case 'lead': this.lead(chain.lead, n, t, dur); break;
        case 'clean': this.pluckNote(chain.clean, n.midi[0], t, dur + 0.6, n.vel * 0.8, 0.5, 0); break;
        case 'pad': this.pad(chain.pad, n, t, dur); break;
        case 'bass': this.bass(chain.bass, n, t, dur); break;
        default: this.drum(chain, n, t, dur);
      }
    }
  }

  private rhythm(chain: Chain, n: MusicNote, t: number, dur: number): void {
    const held = n.mute ? Math.min(dur, 0.13) : dur;
    chain.rhythm.forEach((side, i) => {
      // The second guitar is a separate take: a few milliseconds late, a few cents off, its own string noise.
      const late = i === 0 ? 0 : 0.004 + Math.random() * 0.008;
      for (const m of n.midi) {
        this.pluckNote(n.mute ? side.mute : side.open, m, t + late, held, n.vel * (n.mute ? 0.9 : 0.6), n.mute ? 0.35 : 0.6, i, (i ? 4 : -3) + Math.random() * 3);
      }
    });
  }

  /** One plucked string, played for `dur` seconds then damped. */
  private pluckNote(dest: AudioNode, midi: number, t: number, dur: number, vel: number, bright: number, variant: number, cents = 0): void {
    const ctx = this.ctx!;
    const p = this.pluck(midi, variant, bright);
    const src = ctx.createBufferSource();
    src.buffer = p.buf;
    src.playbackRate.value = p.rate;
    src.detune.value = cents;
    const g = ctx.createGain();
    const end = t + Math.min(dur, p.buf.duration / p.rate);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.002);
    g.gain.setValueAtTime(vel, Math.max(t + 0.003, end - 0.03));
    g.gain.linearRampToValueAtTime(0, end + 0.02);
    src.connect(g).connect(dest);
    src.start(t);
    src.stop(end + 0.05);
  }

  /**
   * A Karplus-Strong string: noise (softened by `bright`) circulating through a
   * one-period delay with an averaging filter. Made once per note and kept; the
   * playback rate corrects the period's rounding so it stays in tune.
   */
  private pluck(midi: number, variant: number, bright: number): { buf: AudioBuffer; rate: number } {
    const key = `${midi}|${variant}|${bright}`;
    const hit = this.plucks.get(key);
    if (hit) return hit;
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const f = mtof(midi);
    const N = Math.max(2, Math.round(sr / f - 0.5));
    const len = Math.floor(sr * (midi < 52 ? 2.6 : 1.8));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < N; i++) { lp += ((Math.random() * 2 - 1) - lp) * bright; d[i] = lp; }
    const loss = midi < 52 ? 0.9985 : 0.997;
    for (let i = N; i < len; i++) d[i] = loss * 0.5 * (d[i - N] + (i - N - 1 >= 0 ? d[i - N - 1] : 0));
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < len; i++) d[i] *= 0.6 / peak;
    const out = { buf, rate: (f * (N + 0.5)) / sr };
    this.plucks.set(key, out);
    return out;
  }

  private lead(dest: AudioNode, n: MusicNote, t: number, dur: number): void {
    const ctx = this.ctx!;
    const f = mtof(n.midi[0]);
    const g = ctx.createGain();
    const end = t + dur;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(n.vel * 0.5, t + 0.012);
    g.gain.setValueAtTime(n.vel * 0.5, Math.max(t + 0.013, end - 0.02));
    g.gain.linearRampToValueAtTime(0, end + 0.08);
    g.connect(dest);
    // Vibrato only on held notes, and only after they have sounded a moment.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.6;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    if (dur > 0.35) {
      depth.gain.setValueAtTime(0, t + 0.22);
      depth.gain.linearRampToValueAtTime(f * 0.012, t + 0.5);
    }
    lfo.connect(depth);
    for (const [type, cents] of [['sawtooth', -6], ['square', 7]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = cents;
      const start = n.bend ? f * Math.pow(2, -n.bend / 12) : f;
      o.frequency.setValueAtTime(start, t);
      if (n.bend) o.frequency.exponentialRampToValueAtTime(f, t + Math.min(0.14, dur * 0.5));
      depth.connect(o.frequency);
      o.connect(g);
      o.start(t);
      o.stop(end + 0.1);
    }
    lfo.start(t);
    lfo.stop(end + 0.1);
  }

  private pad(dest: AudioNode, n: MusicNote, t: number, dur: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const end = t + dur;
    const v = n.vel * 0.12;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + Math.min(0.8, dur * 0.4));
    g.gain.setValueAtTime(v, end);
    g.gain.linearRampToValueAtTime(0, end + 1.2);
    g.connect(dest);
    for (const m of n.midi) {
      for (const cents of [-9, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = cents;
        o.connect(g);
        o.start(t);
        o.stop(end + 1.3);
      }
    }
  }

  private bass(dest: AudioNode, n: MusicNote, t: number, dur: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const end = t + dur;
    const v = n.vel * 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + 0.005);
    g.gain.setValueAtTime(v * 0.8, Math.max(t + 0.006, end - 0.02));
    g.gain.linearRampToValueAtTime(0, end + 0.03);
    g.connect(dest);
    for (const type of ['sine', 'sawtooth'] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(n.midi[0]);
      const lv = ctx.createGain();
      lv.gain.value = type === 'sine' ? 1 : 0.35;
      o.connect(lv).connect(g);
      o.start(t);
      o.stop(end + 0.05);
    }
  }

  private drum(chain: Chain, n: MusicNote, t: number, dur: number): void {
    const v = n.vel, dest = chain.drums, kit = chain.kit;
    switch (n.part) {
      case 'kick':
        this.sweep(dest, 'sine', 130, 44, t, 0.32, v * 0.9);
        this.noise(kit.click, t, 0.012, v * 0.25);
        break;
      case 'snare':
        this.sweep(dest, 'triangle', 210, 165, t, 0.11, v * 0.4);
        this.noise(kit.snare, t, 0.2, v * 0.55);
        break;
      case 'hat':
        this.noise(kit.hat, t, n.len > 1 ? 0.22 : 0.04, v * 0.18);
        break;
      case 'crash':
        this.noise(kit.crash, t, Math.max(1.4, Math.min(dur, 2.2)), v * 0.2);
        break;
      case 'tom': {
        const f = mtof(n.midi[0] ?? 45);
        this.sweep(dest, 'sine', f * 1.5, f, t, 0.38, v * 0.7);
        this.noise(kit.tom, t, 0.05, v * 0.2);
        break;
      }
    }
  }

  private sweep(dest: AudioNode, type: OscillatorType, f0: number, f1: number, t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dest: AudioNode, t: number, dur: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(g).connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}
