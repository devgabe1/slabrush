import type { Vec3 } from '../core/vec';
import type { VoiceLink, VoiceSignal } from '../net/protocol';
import type { MatchPhase } from '../sim/match';
import type { Player } from '../sim/types';
import { CLEAN_TONE, VOICE, hearing, voiceFalloff, voiceTone, type VoiceTone } from './voiceRules';

// Proximity voice chat.
//
// Audio goes directly between players over WebRTC (a full mesh: with at most
// six players that is at most five connections each). The game connection
// carries only the handshake: the host relays offers, answers and ICE
// candidates between players (see VoiceLink). This works the same over
// PeerJS and over the ?local BroadcastChannel transport.
//
// Everything about how a voice SOUNDS is decided by the listener, every frame:
// where the speaker's head is, whether they are alive, and their health (see
// voiceRules.ts). A remote voice runs through
//
//   source -> highpass x2 -> lowpass -> presence peak -> tone gain -+-> pos gain -> panner -+-> volume -> voice out
//                                                             +-> flat gain ----------+
//
// "pos" and "flat" are crossfaded so a voice can move from in-your-head (lobby)
// to in-the-world (round) without clicks.

export type VoiceMode = 'off' | 'ptt' | 'open';
export type MicState = 'off' | 'asking' | 'on' | 'blocked' | 'nodevice' | 'busy' | 'insecure' | 'unsupported';

/** What to tell the player about their microphone, or '' when all is well. */
export function micProblem(state: MicState): string {
  switch (state) {
    case 'asking': return 'allow the microphone to talk';
    case 'blocked': return 'microphone permission denied: allow it in the address bar, then rejoin';
    case 'nodevice': return 'no microphone found: plug one in';
    case 'busy': return 'microphone is in use by another app';
    case 'insecure': return 'microphones need https:// or localhost: this page is plain http';
    case 'unsupported': return 'this browser cannot use a microphone here';
    default: return '';
  }
}

const SMOOTH = 0.06; // seconds: time constant for every parameter change (no zipper noise)
const TALK_LEVEL = 0.015; // RMS above which someone counts as talking (for the indicators)
const TALK_HOLD = 0.35; // seconds the indicator stays lit after the last loud moment (speech has gaps)
const RETRY_MS = 4000;
const CONNECT_TIMEOUT_MS = 15000; // a handshake that has not connected by then is started over

interface Remote {
  id: number;
  pc: RTCPeerConnection;
  /** ICE candidates that arrived before the remote description. */
  pendingIce: RTCIceCandidateInit[];
  haveRemote: boolean;
  started: number;
  stream: MediaStream | null;
  graph: Graph | null;
  lastLoud: number; // audio clock time the speaker was last above TALK_LEVEL
  audible: number; // 0..1, how loud they are to us right now (for the HUD)
}

interface Graph {
  el: HTMLAudioElement;
  src: MediaStreamAudioSourceNode;
  hp: BiquadFilterNode;
  hp2: BiquadFilterNode;
  lp: BiquadFilterNode;
  peak: BiquadFilterNode;
  tone: GainNode;
  pos: GainNode;
  flat: GainNode;
  panner: PannerNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

export class VoiceChat {
  mode: VoiceMode;
  micState: MicState = 'off';
  /** True while our microphone is actually going out. */
  transmitting = false;
  private micLoud = -1;
  private clock = 0;

  private remotes = new Map<number, Remote>();
  private retryAt = new Map<number, number>();
  private mic: MediaStream | null = null;
  private micAnalyser: { node: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private out: GainNode | null = null;
  private volume = 1;
  private disposed = false;

  constructor(
    private link: VoiceLink,
    private localId: () => number,
    private ctx: () => AudioContext | null,
    private dest: () => AudioNode,
    private ice: RTCIceServer[],
    mode: VoiceMode,
  ) {
    this.mode = mode;
    link.onSignal = (from, d) => void this.onSignal(from, d);
    if (mode !== 'off') void this.startMic();
  }

  // ---------------------------------------------------------------- settings
  setMode(mode: VoiceMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'off') this.stopMic();
    else if (this.micState === 'off') void this.startMic();
  }

  setVolume(v: number): void {
    this.volume = v;
    const ctx = this.ctx();
    if (this.out && ctx) this.out.gain.setTargetAtTime(v, ctx.currentTime, SMOOTH);
  }

  /** Push-to-talk / open mic is decided by the app; this just opens or closes the gate. */
  setTransmit(on: boolean): void {
    const track = this.mic?.getAudioTracks()[0];
    const live = on && this.mode !== 'off' && !!track;
    if (track) track.enabled = live;
    this.transmitting = live;
  }

  /** Is this player audibly talking to us right now? */
  isTalking(id: number): boolean {
    if (id === this.localId()) return this.transmitting && this.clock - this.micLoud < TALK_HOLD;
    const r = this.remotes.get(id);
    return !!r && this.clock - r.lastLoud < TALK_HOLD && r.audible > 0.05;
  }

  // -------------------------------------------------------------- microphone
  private async startMic(): Promise<void> {
    // Browsers hide navigator.mediaDevices entirely outside a secure context,
    // e.g. the game opened as http://192.168.x.x from another machine.
    if (!window.isSecureContext) { this.micState = 'insecure'; return; }
    if (!navigator.mediaDevices?.getUserMedia) { this.micState = 'unsupported'; return; }
    if (!this.watchingDevices) {
      // A microphone plugged in (or freed) later is picked up without rejoining.
      this.watchingDevices = true;
      navigator.mediaDevices.addEventListener?.('devicechange', this.onDeviceChange);
    }
    this.micState = 'asking';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.disposed || this.mode === 'off') { stream.getTracks().forEach((t) => t.stop()); this.micState = 'off'; return; }
      this.mic = stream;
      this.micState = 'on';
      const track = stream.getAudioTracks()[0];
      track.enabled = false; // closed until the app says otherwise
      for (const r of this.remotes.values()) this.attachMic(r);
    } catch (e) {
      // You can still listen either way.
      const name = (e as { name?: string })?.name;
      this.micState = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nodevice'
        : name === 'NotReadableError' || name === 'AbortError' ? 'busy'
        : name === 'SecurityError' ? 'insecure' : 'blocked';
    }
  }

  private watchingDevices = false;
  private onDeviceChange = (): void => {
    if (!this.disposed && this.mode !== 'off' && (this.micState === 'nodevice' || this.micState === 'busy')) void this.startMic();
  };

  private stopMic(): void {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micAnalyser?.src.disconnect();
    this.micAnalyser = null;
    this.micState = 'off';
    this.transmitting = false;
    for (const r of this.remotes.values()) this.attachMic(r);
  }

  private attachMic(r: Remote): void {
    const t = r.pc.getTransceivers()[0];
    if (t && r.pc.connectionState !== 'closed') void t.sender.replaceTrack(this.mic?.getAudioTracks()[0] ?? null).catch(() => {});
  }

  // ------------------------------------------------------------- connections
  /** Create, keep and drop connections so there is exactly one per other player in the room. */
  private sync(ids: number[]): void {
    const me = this.localId();
    const wanted = new Set(ids.filter((id) => id !== me));
    const now = performance.now();
    for (const [id, r] of this.remotes) {
      if (!wanted.has(id)) this.close(r);
      else if (r.pc.connectionState !== 'connected' && now - r.started > CONNECT_TIMEOUT_MS) this.fail(r); // lost handshake
    }
    for (const id of wanted) {
      // The lower id always makes the offer, so two players never offer to each other at once.
      if (me < id && !this.remotes.has(id) && now >= (this.retryAt.get(id) ?? 0)) void this.offer(id);
    }
  }

  private create(id: number): Remote {
    const pc = new RTCPeerConnection({ iceServers: this.ice });
    const r: Remote = { id, pc, pendingIce: [], haveRemote: false, started: performance.now(), stream: null, graph: null, lastLoud: -1, audible: 0 };
    this.remotes.set(id, r);
    pc.onicecandidate = (e) => { if (e.candidate) this.link.send(id, { k: 'ice', c: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      r.stream = e.streams[0] ?? new MediaStream([e.track]);
      this.buildGraph(r);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.remotes.get(id) === r) {
        this.close(r);
        this.retryAt.set(id, performance.now() + RETRY_MS); // the offering side tries again
      }
    };
    return r;
  }

  private async offer(id: number): Promise<void> {
    const r = this.create(id);
    try {
      // One audio transceiver, negotiated send+receive up front. Turning the
      // microphone on or off later is a replaceTrack, with no renegotiation.
      r.pc.addTransceiver('audio', { direction: 'sendrecv' });
      this.attachMic(r);
      const offer = await r.pc.createOffer();
      await r.pc.setLocalDescription(offer);
      this.link.send(id, { k: 'offer', sdp: offer.sdp ?? '' });
    } catch {
      this.fail(r);
    }
  }

  private async onSignal(from: number, d: VoiceSignal): Promise<void> {
    if (this.disposed || from === this.localId()) return;
    let r = this.remotes.get(from);
    try {
      if (d.k === 'offer') {
        if (from > this.localId()) return; // offers only ever come from the lower id
        if (r) this.close(r); // they restarted: start over
        r = this.create(from);
        await r.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        const t = r.pc.getTransceivers()[0];
        if (t) t.direction = 'sendrecv'; // otherwise the answer would only receive
        this.attachMic(r);
        await this.flushIce(r);
        const answer = await r.pc.createAnswer();
        await r.pc.setLocalDescription(answer);
        this.link.send(from, { k: 'answer', sdp: answer.sdp ?? '' });
      } else if (d.k === 'answer') {
        if (!r || r.pc.signalingState !== 'have-local-offer') return;
        await r.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await this.flushIce(r);
      } else if (d.k === 'ice' && r) {
        if (r.haveRemote) await r.pc.addIceCandidate(d.c);
        else r.pendingIce.push(d.c);
      }
    } catch {
      if (r) this.fail(r);
    }
  }

  private async flushIce(r: Remote): Promise<void> {
    r.haveRemote = true;
    for (const c of r.pendingIce.splice(0)) await r.pc.addIceCandidate(c).catch(() => {});
  }

  private fail(r: Remote): void {
    if (this.remotes.get(r.id) !== r) return;
    this.close(r);
    this.retryAt.set(r.id, performance.now() + RETRY_MS);
  }

  private close(r: Remote): void {
    if (this.remotes.get(r.id) === r) this.remotes.delete(r.id);
    r.pc.onicecandidate = r.pc.ontrack = r.pc.onconnectionstatechange = null;
    r.pc.close();
    if (r.graph) {
      r.graph.src.disconnect();
      r.graph.pos.disconnect();
      r.graph.flat.disconnect();
      r.graph.el.srcObject = null;
    }
    r.graph = null;
  }

  // ------------------------------------------------------------------- audio
  private output(ctx: AudioContext): GainNode {
    if (!this.out) {
      this.out = ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(this.dest());
    }
    return this.out;
  }

  private buildGraph(r: Remote): void {
    const ctx = this.ctx();
    if (!ctx || !r.stream || r.graph) return;
    // Chrome only feeds a remote WebRTC stream into Web Audio while a media
    // element is also playing it; the element itself stays muted.
    const el = new Audio();
    el.muted = true;
    el.srcObject = r.stream;
    void el.play().catch(() => {});

    const src = ctx.createMediaStreamSource(r.stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.Q.value = Math.SQRT1_2;
    const hp2 = ctx.createBiquadFilter(); // second stage: 24 dB/octave, so the body really goes
    hp2.type = 'highpass';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = VOICE.presenceHz;
    peak.Q.value = VOICE.presenceQ;
    const tone = ctx.createGain();
    const pos = ctx.createGain();
    const flat = ctx.createGain();
    pos.gain.value = flat.gain.value = 0;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = VOICE.near;
    panner.maxDistance = VOICE.far;
    panner.rolloffFactor = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    const out = this.output(ctx);
    src.connect(hp).connect(hp2).connect(lp).connect(peak).connect(tone);
    tone.connect(pos).connect(panner).connect(out);
    tone.connect(flat).connect(out);
    src.connect(analyser);
    r.graph = { el, src, hp, hp2, lp, peak, tone, pos, flat, panner, analyser, buf: new Float32Array(analyser.fftSize) };
    this.applyTone(r.graph, CLEAN_TONE, ctx.currentTime, true);
  }

  private applyTone(g: Graph, t: VoiceTone, now: number, instant = false): void {
    const set = (p: AudioParam, v: number) => (instant ? (p.value = v) : p.setTargetAtTime(v, now, SMOOTH));
    set(g.hp.frequency, t.highpass);
    set(g.hp2.frequency, t.highpass);
    set(g.hp2.Q, t.highpassQ); // the first stage stays flat (Q 0.7); the resonance is on the second
    set(g.lp.frequency, t.lowpass);
    set(g.peak.gain, t.presence);
    set(g.tone.gain, t.gain);
  }

  private rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /**
   * Every frame: keep the mesh in step with the room, then place and colour
   * every voice. `listener` is where our ears are (the camera).
   */
  update(roster: number[], phase: MatchPhase, players: (id: number) => Player | undefined, listener: Vec3): void {
    if (this.disposed) return;
    this.sync(roster);
    const ctx = this.ctx();
    if (!ctx) return;
    const now = (this.clock = ctx.currentTime);
    const me = players(this.localId());

    for (const r of this.remotes.values()) {
      if (!r.graph) this.buildGraph(r);
      const g = r.graph;
      if (!g) continue;
      const speaker = players(r.id);
      const how = this.mode === 'off' ? 'mute' : hearing(phase, speaker, me);
      let audible = 0;
      if (how === 'positional' && speaker) {
        const head = speaker.pos.y + (speaker.crouched ? 0.95 : 1.62);
        if (g.panner.positionX) {
          g.panner.positionX.setTargetAtTime(speaker.pos.x, now, 0.02);
          g.panner.positionY.setTargetAtTime(head, now, 0.02);
          g.panner.positionZ.setTargetAtTime(speaker.pos.z, now, 0.02);
        } else g.panner.setPosition(speaker.pos.x, head, speaker.pos.z);
        this.applyTone(g, voiceTone(speaker.health), now);
        audible = voiceFalloff(Math.hypot(speaker.pos.x - listener.x, head - listener.y, speaker.pos.z - listener.z));
      } else if (how === 'flat') {
        this.applyTone(g, CLEAN_TONE, now);
        audible = 1;
      }
      g.pos.gain.setTargetAtTime(how === 'positional' ? 1 : 0, now, SMOOTH);
      g.flat.gain.setTargetAtTime(how === 'flat' ? 1 : 0, now, SMOOTH);
      r.audible = audible;
      if (this.rms(g.analyser, g.buf) > TALK_LEVEL) r.lastLoud = now;
    }

    // Our own level, so the indicator can show that the microphone really picks you up.
    if (this.mic && !this.micAnalyser) {
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      const src = ctx.createMediaStreamSource(this.mic);
      src.connect(node); // measured only, never played back
      this.micAnalyser = { node, src, buf: new Float32Array(node.fftSize) };
    }
    if (this.micAnalyser && this.transmitting && this.rms(this.micAnalyser.node, this.micAnalyser.buf) > TALK_LEVEL) this.micLoud = now;
  }

  dispose(): void {
    this.disposed = true;
    this.link.onSignal = () => {};
    if (this.watchingDevices) navigator.mediaDevices.removeEventListener?.('devicechange', this.onDeviceChange);
    for (const r of [...this.remotes.values()]) this.close(r);
    this.stopMic();
    this.out?.disconnect();
    this.out = null;
  }
}
