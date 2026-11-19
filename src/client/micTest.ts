import { PLAYER } from '../config/game';
// Settings helpers for the microphone: which input devices exist, a live
// level meter for the chosen one, and a loopback test that plays your voice
// back to you through the same processing other players hear (health pitch,
// death voice), so you can check your microphone and hear how you sound.

import { megaphone, type Megaphone } from '../audio/megaphone';
import { PITCH_SHIFTER, loadPitchShifter, scheduleDeathVoice } from '../audio/pitchShifter';
import { VOICE, voiceShift } from '../audio/voiceRules';

export interface MicDevice {
  id: string;
  label: string;
}

/**
 * Audio inputs, in the browser's order. Browsers hide device names until the
 * page has had microphone permission once; `named` says whether we got them.
 */
export async function listMics(): Promise<{ devices: MicDevice[]; named: boolean }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { devices: [], named: false };
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return {
    devices: inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    named: inputs.some((d) => !!d.label),
  };
}

/** Ask for the microphone once, only so the browser reveals device names. */
export async function revealMicNames(): Promise<boolean> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/** A level meter on one microphone, with an optional loopback to your own ears. */
export class MicMeter {
  level = 0; // 0..1, smoothed
  error = '';
  /** Playing your voice back to you. */
  loopback = false;
  /** Health the loopback is voiced at (full health = your normal voice). */
  health = PLAYER.maxHealth;
  /** Audio clock time a death voice preview ends, while it plays. */
  dyingUntil = 0;
  private fx: { cut: BiquadFilterNode; shift: AudioWorkletNode; gate: GainNode; out: GainNode } | null = null;
  /** HECKLER offline (practice range): our voice through the megaphone and its echo. */
  private mega: Megaphone | null = null;
  private megaOut: GainNode | null = null;
  private volume = 1;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private an: AnalyserNode | null = null;
  private buf = new Float32Array(512);
  private gen = 0;

  async start(deviceId: string): Promise<void> {
    this.stop();
    const gen = ++this.gen;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
      if (gen !== this.gen) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      this.ctx = new AudioContext();
      this.an = this.ctx.createAnalyser();
      this.an.fftSize = 512;
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.an);
      this.error = '';
      // Loopback chain, same as voice chat: low cut -> pitch shifter / death tape -> gate.
      const ctx = this.ctx;
      try {
        await loadPitchShifter(ctx);
        if (gen !== this.gen) return;
        const cut = ctx.createBiquadFilter();
        cut.type = 'highpass';
        const shift = new AudioWorkletNode(ctx, PITCH_SHIFTER, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const gate = ctx.createGain();
        const out = ctx.createGain();
        out.gain.value = 0;
        src.connect(cut).connect(shift).connect(gate).connect(out).connect(ctx.destination);
        this.fx = { cut, shift, gate, out };
        this.megaOut = ctx.createGain();
        this.megaOut.connect(ctx.destination);
        this.mega = megaphone(ctx, this.megaOut);
        gate.connect(this.mega.input);
        this.apply();
      } catch {
        /* no worklets: the meter still works, loopback does not */
      }
    } catch (e) {
      if (gen !== this.gen) return;
      const name = (e as { name?: string })?.name;
      this.error = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'not found'
        : name === 'NotReadableError' ? 'in use by another app' : 'not allowed';
    }
  }

  get canLoopback(): boolean { return !!this.fx; }

  /** HECKLER offline: hear yourself through the megaphone while `on`, at `volume`. */
  setMegaphone(on: boolean, volume: number): void {
    if (!this.mega || !this.megaOut || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.megaOut.gain.setTargetAtTime(volume, now, 0.03);
    this.mega.gate.gain.setTargetAtTime(on ? 0.6 : 0, now, 0.02);
  }

  setLoopback(on: boolean, volume: number): void {
    this.loopback = on;
    this.volume = volume;
    this.apply();
  }

  setHealth(hp: number): void {
    this.health = hp;
    this.apply();
  }

  /** Play the next 4 seconds of your voice as the death voice. */
  previewDeath(): void {
    if (!this.fx || !this.ctx) return;
    if (!this.loopback) this.setLoopback(true, this.volume);
    const now = this.ctx.currentTime;
    this.fx.shift.parameters.get('ratio')!.setValueAtTime(1, now);
    this.dyingUntil = scheduleDeathVoice(this.fx.shift, this.fx.gate, now);
    // Back to the chosen health once it is over (after the silence that follows it).
    const back = this.dyingUntil + VOICE.death.silenceAfter;
    setTimeout(() => this.apply(), (back - now) * 1000 + 50);
  }

  private apply(): void {
    if (!this.fx || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.fx.out.gain.setTargetAtTime(this.loopback ? this.volume : 0, now, 0.03);
    if (now < this.dyingUntil + VOICE.death.silenceAfter) return; // let a death preview finish
    const v = voiceShift(this.health);
    this.fx.shift.parameters.get('ratio')!.setTargetAtTime(Math.pow(2, v.semitones / 12), now, VOICE.glide);
    this.fx.cut.frequency.setTargetAtTime(v.lowCut, now, VOICE.glide);
  }

  /** Call every frame while visible. */
  /** Unsmoothed loudness (RMS) right now; 0 when the meter is not running. */
  rms(): number {
    if (!this.an) return 0;
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const x of this.buf) sum += x * x;
    return Math.sqrt(sum / this.buf.length);
  }

  get running(): boolean {
    return !!this.an;
  }

  sample(): number {
    if (!this.an) return (this.level = 0);
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const x of this.buf) sum += x * x;
    const rms = Math.sqrt(sum / this.buf.length);
    const target = Math.min(1, rms * 8);
    this.level += (target - this.level) * (target > this.level ? 0.5 : 0.08); // fast up, slow down
    return this.level;
  }

  stop(): void {
    this.gen++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.an = null;
    this.fx = null;
    this.mega = null;
    this.megaOut = null;
    this.level = 0;
    this.dyingUntil = 0;
  }
}
