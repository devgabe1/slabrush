// The HECKLER's megaphone: a voice through a cheap PA horn (narrow, honky,
// distorted) with a big stadium echo that keeps repeating after each phrase.
// Used for everyone who hears a heckler (voice.ts, per remote voice), for the
// heckler hearing themselves (voice.ts, their own microphone) and offline in
// the practice range (micTest.ts).
//
//   input -> high-pass -> low-pass -> honk peak -> drive -> gate -+-> dry --------------> limiter -> out
//                                                                +-> echo send -> two delays (290 / 470 ms),
//                                                                    fed back through a band-limited loop -> wet -> limiter -> out
//
// The gate is the on/off switch (0 = off). It sits BEFORE the echo, so when
// it closes the echo still rings out its tail, as a real PA would.

export const MEGA = {
  echoA: 0.29, // seconds: the first repeat
  echoB: 0.47, // a second, later repeat, so the echo sounds like a big space, not a metronome
  feedback: 0.5, // how much of each repeat comes back again (about six audible repeats)
  wet: 0.8, // echo level, relative to the dry voice
  dry: 1.1, // the megaphone voice itself, a little louder than ordinary voice chat
};

export interface Megaphone {
  /** Connect a voice here. */
  input: AudioNode;
  /** 0 = off, 1 = on (multiplies the dry level); ramp it rather than jump. */
  gate: GainNode;
  disconnect(): void;
}

export function megaphone(ctx: BaseAudioContext, out: AudioNode): Megaphone {
  const lowCut = ctx.createBiquadFilter();
  lowCut.type = 'highpass'; lowCut.frequency.value = 450; lowCut.Q.value = 0.9;
  const highCut = ctx.createBiquadFilter();
  highCut.type = 'lowpass'; highCut.frequency.value = 3200; highCut.Q.value = 0.9;
  const honk = ctx.createBiquadFilter();
  honk.type = 'peaking'; honk.frequency.value = 1500; honk.Q.value = 1.2; honk.gain.value = 9;
  const crunch = ctx.createWaveShaper();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(4 * x) / Math.tanh(4); }
  crunch.curve = curve;
  crunch.oversample = '2x';
  const gate = ctx.createGain();
  gate.gain.value = 0;
  const dry = ctx.createGain();
  dry.gain.value = MEGA.dry;

  // The echo: two delay lines, the first fed back through a band-limited loop
  // (each repeat a little duller and thinner, like sound bouncing off concrete).
  const send = ctx.createGain();
  const dA = ctx.createDelay(1), dB = ctx.createDelay(1);
  dA.delayTime.value = MEGA.echoA;
  dB.delayTime.value = MEGA.echoB;
  const loopLow = ctx.createBiquadFilter();
  loopLow.type = 'lowpass'; loopLow.frequency.value = 2600;
  const loopHigh = ctx.createBiquadFilter();
  loopHigh.type = 'highpass'; loopHigh.frequency.value = 300;
  const fb = ctx.createGain();
  fb.gain.value = MEGA.feedback;
  const wet = ctx.createGain();
  wet.gain.value = MEGA.wet * MEGA.dry;

  // A limiter last: the voice and its repeats pile up, and should get loud without clipping.
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -10; limit.knee.value = 6; limit.ratio.value = 12;
  limit.attack.value = 0.003; limit.release.value = 0.15;
  limit.connect(out);

  lowCut.connect(highCut).connect(honk).connect(crunch).connect(gate);
  gate.connect(dry).connect(limit);
  gate.connect(send);
  send.connect(dA);
  send.connect(dB);
  dA.connect(loopLow);
  dB.connect(loopLow);
  loopLow.connect(loopHigh).connect(fb).connect(dA); // the loop: stable, since every pass loses half
  loopHigh.connect(wet).connect(limit);

  return {
    input: lowCut,
    gate,
    disconnect: () => { for (const node of [lowCut, gate, dry, wet, fb, limit]) node.disconnect(); },
  };
}
