// Real-time pitch shifter for the outgoing voice, as an AudioWorklet.
//
// Classic two-tap delay-line shifter: the input is written into a ring
// buffer and read back by two taps whose delay sweeps through a 50 ms window
// at (ratio - 1) samples per sample, so they play the signal faster (higher)
// or slower (lower). Each tap fades in and out with a sin² window, half a
// window apart, so their weights always sum to 1 and the jump when a tap
// wraps around is silent. Pitch and formants move together: at +12 semitones
// it is the helium / sped-up-tape voice, high but still easy to understand.
//
// At ratio 1 the shifter is crossfaded out and the dry signal passes through
// untouched (no added delay, no comb filtering).
//
// Tape mode (the 'tape' parameter above 0) is the death voice: from the
// moment it starts, one read head plays the buffer back at that rate (1 =
// normal speed), like a record winding down, so as the rate falls the voice
// gets slower AND deeper together. It falls behind real time as it goes (the
// buffer holds about 2.7 s), and jumps back to live when 'tape' returns to 0
// (the caller silences that moment).

const SOURCE = `
class SlabrushPitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ratio', defaultValue: 1, minValue: 0.5, maxValue: 2.5, automationRate: 'k-rate' },
      { name: 'tape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // 0 = off, else playback rate
    ];
  }
  constructor() {
    super();
    this.size = 131072;
    this.buf = new Float32Array(this.size);
    this.w = 0;
    this.win = Math.round(sampleRate * 0.05);
    this.phase = 0;
    this.wet = 0;
    this.tr = -1; // tape read head (absolute buffer position), -1 = not playing tape
  }
  read(d) {
    let p = this.w - d;
    while (p < 0) p += this.size;
    const i = Math.floor(p), f = p - i;
    const a = this.buf[i % this.size], b = this.buf[(i + 1) % this.size];
    return a + (b - a) * f;
  }
  process(inputs, outputs, params) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0];
    const ratio = params.ratio[0];
    const tape = params.tape[0];
    if (tape <= 0) this.tr = -1;
    else if (this.tr < 0) this.tr = this.w; // start winding down from this very moment
    const target = Math.abs(ratio - 1) > 0.003 ? 1 : 0;
    const step = (ratio - 1) / this.win;
    const win = this.win, size = this.size;
    for (let n = 0; n < out.length; n++) {
      const x = inp ? inp[n] : 0;
      this.buf[this.w] = x;
      this.wet += (target - this.wet) * 0.002;
      let y = x;
      if (this.tr >= 0) {
        const i = Math.floor(this.tr), f = this.tr - i;
        const a = this.buf[i % size], b = this.buf[(i + 1) % size];
        y = a + (b - a) * f;
        this.tr = (this.tr + tape) % size;
      } else if (this.wet > 0.0005) {
        this.phase -= Math.floor(this.phase);
        const fa = this.phase, fb = fa + 0.5 - Math.floor(fa + 0.5);
        const sa = Math.sin(Math.PI * fa), sb = Math.sin(Math.PI * fb);
        const shifted = this.read(1 + win * (1 - fa)) * sa * sa + this.read(1 + win * (1 - fb)) * sb * sb;
        y = x * (1 - this.wet) + shifted * this.wet;
        this.phase += step;
      }
      out[n] = y;
      this.w = (this.w + 1) % size;
    }
    return true;
  }
}
registerProcessor('slabrush-pitch-shift', SlabrushPitchShift);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Loads the processor into this context once; resolves when `new AudioWorkletNode(ctx, PITCH_SHIFTER)` works. */
export function loadPitchShifter(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([SOURCE], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
  }
  return p;
}

export const PITCH_SHIFTER = 'slabrush-pitch-shift';
