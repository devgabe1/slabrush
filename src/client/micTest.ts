// Settings helpers for the microphone: which input devices exist, and a live
// level meter for the chosen one, so a player can see their pick works.

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

/** A level meter on one microphone. Nothing is played back. */
export class MicMeter {
  level = 0; // 0..1, smoothed
  error = '';
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
      this.ctx.createMediaStreamSource(stream).connect(this.an);
      this.error = '';
    } catch (e) {
      if (gen !== this.gen) return;
      const name = (e as { name?: string })?.name;
      this.error = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'not found'
        : name === 'NotReadableError' ? 'in use by another app' : 'not allowed';
    }
  }

  /** Call every frame while visible. */
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
    this.level = 0;
  }
}
