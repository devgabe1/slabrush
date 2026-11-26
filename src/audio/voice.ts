import type { Vec3 } from '../core/vec';
import type { VoiceLink, VoiceSignal } from '../net/protocol';
import type { MatchPhase } from '../sim/match';
import type { Player } from '../sim/types';
import { megaphone, type Megaphone } from './megaphone';
import { PITCH_SHIFTER, loadPitchShifter, scheduleDeathVoice } from './pitchShifter';
import { VOICE, hearing, ownVoice, voiceFalloff } from './voiceRules';
import { t } from '../core/i18n';

// Proximity voice chat.
//
// Audio goes directly between players over WebRTC (a full mesh: with at most
// six players that is at most five connections each). The game connection
// carries only the handshake: the host relays offers, answers and ICE
// candidates between players (see VoiceLink). This works the same over
// PeerJS and over the ?local BroadcastChannel transport.
//
// What health does to a voice is applied by the SPEAKER, to their own
// microphone, before it is sent: their game always knows their real health,
// so every listener hears the same thing (see voiceRules.ts):
//
//   mic -> low cut -> pitch shifter / death tape (worklet) -> death gate -> sent to everyone
//
// Where a voice comes FROM is decided by each listener, every frame: the
// speaker's head position, distance, dead or alive. A remote voice runs through
//
//   source -+-> pos gain -> panner -+-> volume -> voice out
//           +-> flat gain ----------+
//
// "pos" and "flat" are crossfaded so a voice can move from in-your-head (lobby)
// to in-the-world (round) without clicks.

export type VoiceMode = 'off' | 'ptt' | 'open';
export type MicState = 'off' | 'asking' | 'on' | 'blocked' | 'nodevice' | 'busy' | 'insecure' | 'unsupported';

/** What to tell the player about their microphone, or '' when all is well. */
export function micProblem(state: MicState): string {
  switch (state) {
    case 'asking': return t('allow the microphone to talk');
    case 'blocked': return t('microphone permission denied: allow it in the address bar, then rejoin');
    case 'nodevice': return t('no microphone found: plug one in');
    case 'busy': return t('microphone is in use by another app');
    case 'insecure': return t('microphones need https:// or localhost: this page is plain http');
    case 'unsupported': return t('this browser cannot use a microphone here');
    default: return '';
  }
}

const SMOOTH = 0.06;
/** How loud we hear our own HECKLER (others hear it at 1). */
const SELF_MEGAPHONE = 0.6; // seconds: time constant for every parameter change (no zipper noise)
const TALK_LEVEL = 0.015; // RMS above which someone counts as talking (for the indicators)
const TALK_HOLD = 0.35; // seconds the indicator stays lit after the last loud moment (speech has gaps)
/** Voice loudness (RMS) mapped to how far a mouth opens: closed below QUIET, wide open at LOUD. */
const MOUTH_QUIET = 0.012;
const MOUTH_LOUD = 0.1;
export const mouthOpenFor = (rms: number): number => Math.max(0, Math.min(1, (rms - MOUTH_QUIET) / (MOUTH_LOUD - MOUTH_QUIET)));
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
  wasAlive: boolean | null; // last seen state, to notice the moment they die
  diedAt: number; // audio clock time we saw them die, -Infinity if not recently
  audible: number; // 0..1, how loud they are to us right now (for the HUD)
  level: number; // 0..1, their voice's loudness this frame (drives their character's mouth)
}

interface Graph {
  el: HTMLAudioElement;
  src: MediaStreamAudioSourceNode;
  pos: GainNode;
  flat: GainNode;
  mega: GainNode; // HECKLER: the voice through a megaphone, in everyone's head, loud
  panner: PannerNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}

export class VoiceChat {
  mode: VoiceMode;
  micState: MicState = 'off';
  /** True while our microphone is actually going out. */
  transmitting = false;
  /** Our own voice through the megaphone, heard by us while our HECKLER is on. */
  private monitor: Megaphone | null = null;
  /** Raw level (RMS) of our microphone this frame, whether or not it is going out (0 without one). */
  micRms = 0;
  private micLoud = -1;
  private micLevel = 0;
  private clock = 0;

  private remotes = new Map<number, Remote>();
  private retryAt = new Map<number, number>();
  private mic: MediaStream | null = null;
  private micAnalyser: { node: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private out: GainNode | null = null;
  /** The processed microphone (low cut + pitch shift); null until the worklet is loaded, raw mic is sent meanwhile. */
  private fx: {
    src: MediaStreamAudioSourceNode; cut: BiquadFilterNode; shift: AudioWorkletNode; gate: GainNode;
    dest: MediaStreamAudioDestinationNode; track: MediaStreamTrack;
  } | null = null;
  private fxLoading = false;
  /** Semitones our own voice is currently raised by (for the HUD / tests). */
  pitch = 0;
  /** Audio clock time our death voice ends, while it plays. */
  dyingUntil = -Infinity;
  private meWasAlive: boolean | null = null;
  private volume = 1;
  /** Chosen input device ('' = the system default). */
  private deviceId = '';
  /** True when the chosen device was not found and the default is used instead. */
  usingFallback = false;
  private micGen = 0; // bumped on every (re)start, so a slow older request cannot win
  private disposed = false;

  constructor(
    private link: VoiceLink,
    private localId: () => number,
    private ctx: () => AudioContext | null,
    private dest: () => AudioNode,
    private ice: RTCIceServer[],
    mode: VoiceMode,
    deviceId = '',
  ) {
    this.mode = mode;
    this.deviceId = deviceId;
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

  /** Switch microphones; live, without leaving the room. '' = system default. */
  setDevice(id: string): void {
    if (id === this.deviceId) return;
    this.deviceId = id;
    if (this.mode === 'off') return;
    this.stopMic();
    void this.startMic();
  }

  setVolume(v: number): void {
    this.volume = v;
    const ctx = this.ctx();
    if (this.out && ctx) this.out.gain.setTargetAtTime(v, ctx.currentTime, SMOOTH);
  }

  /** Push-to-talk / open mic is decided by the app; this just opens or closes the gate. */
  setTransmit(on: boolean): void {
    const raw = this.mic?.getAudioTracks()[0];
    // The death voice plays out even if push to talk is released: it is already on its way.
    const live = (on || this.clock < this.dyingUntil) && this.mode !== 'off' && !!raw;
    if (this.fx) {
      if (raw) raw.enabled = true; // feeds the processing; the processed track is the gate
      this.fx.track.enabled = live;
    } else if (raw) raw.enabled = live;
    this.transmitting = live;
  }

  /** The track everyone receives: processed when ready, else the raw microphone. */
  private sendTrack(): MediaStreamTrack | null {
    if (!this.mic) return null;
    return this.fx?.track ?? this.mic.getAudioTracks()[0] ?? null;
  }

  /** Builds mic -> low cut -> pitch shifter -> outgoing track, once the audio context exists. */
  private buildFx(ctx: AudioContext): void {
    if (this.fx || this.fxLoading || !this.mic || !ctx.audioWorklet) return;
    this.fxLoading = true;
    const mic = this.mic;
    loadPitchShifter(ctx).then(() => {
      this.fxLoading = false;
      if (this.disposed || this.mic !== mic) return;
      const src = ctx.createMediaStreamSource(mic);
      const cut = ctx.createBiquadFilter();
      cut.type = 'highpass';
      cut.frequency.value = VOICE.lowCut[0];
      const shift = new AudioWorkletNode(ctx, PITCH_SHIFTER, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const gate = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      src.connect(cut).connect(shift).connect(gate).connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      track.enabled = this.transmitting;
      mic.getAudioTracks()[0].enabled = true;
      this.fx = { src, cut, shift, gate, dest, track };
      // HECKLER: we hear ourselves through the megaphone too (exactly what everyone hears: pitch and all).
      this.monitor = megaphone(ctx, this.output(ctx));
      gate.connect(this.monitor.input);
      for (const r of this.remotes.values()) this.attachMic(r);
    }, () => { this.fxLoading = false; /* no worklets: the raw voice is sent, unshifted */ });
  }

  private dropFx(): void {
    this.monitor?.disconnect();
    this.monitor = null;
    if (!this.fx) return;
    this.fx.src.disconnect();
    this.fx.shift.disconnect();
    this.fx.track.stop();
    this.fx = null;
  }

  /**
   * How wide this player's mouth should be open right now (0..1), from the
   * loudness of their voice. Works at any distance (you can see someone talk
   * across the map), but a voice we are not allowed to hear does not move it.
   */
  mouth(id: number): number {
    if (id === this.localId()) return this.transmitting ? this.micLevel : 0;
    return this.remotes.get(id)?.level ?? 0;
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
    const gen = ++this.micGen;
    const audio = (deviceId: string): MediaTrackConstraints => ({
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    });
    try {
      let stream: MediaStream;
      this.usingFallback = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audio(this.deviceId) });
      } catch (e) {
        // The chosen microphone is unplugged (or its id changed): use the default rather than nothing.
        const name = (e as { name?: string })?.name;
        if (!this.deviceId || (name !== 'NotFoundError' && name !== 'OverconstrainedError')) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: audio('') });
        this.usingFallback = true;
      }
      if (gen !== this.micGen || this.disposed || this.mode === 'off') {
        stream.getTracks().forEach((t) => t.stop());
        if (gen === this.micGen) this.micState = 'off';
        return;
      }
      this.mic = stream;
      this.micState = 'on';
      const track = stream.getAudioTracks()[0];
      track.enabled = false; // closed until the app says otherwise
      for (const r of this.remotes.values()) this.attachMic(r);
    } catch (e) {
      if (gen !== this.micGen) return; // a newer request is in charge
      // You can still listen either way.
      const name = (e as { name?: string })?.name;
      this.micState = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'nodevice'
        : name === 'NotReadableError' || name === 'AbortError' ? 'busy'
        : name === 'SecurityError' ? 'insecure' : 'blocked';
    }
  }

  private watchingDevices = false;
  private onDeviceChange = (): void => {
    if (this.disposed || this.mode === 'off') return;
    // Nothing working yet, or the chosen microphone came back: (re)start.
    if (this.micState === 'nodevice' || this.micState === 'busy' || (this.usingFallback && this.micState === 'on')) {
      this.stopMic();
      void this.startMic();
    }
  };

  private stopMic(): void {
    this.micGen++; // any request still in flight is now stale
    this.dropFx();
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
    if (t && r.pc.connectionState !== 'closed') void t.sender.replaceTrack(this.sendTrack()).catch(() => {});
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
    const r: Remote = { id, pc, pendingIce: [], haveRemote: false, started: performance.now(), stream: null, graph: null, lastLoud: -1, wasAlive: null, diedAt: -Infinity, audible: 0, level: 0 };
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
      r.graph.mega.disconnect(); // the megaphone's gate: its echo tail is cut off with the voice
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
    src.connect(pos).connect(panner).connect(out);
    src.connect(flat).connect(out);
    const mp = megaphone(ctx, out); // HECKLER: the megaphone with its echo, off until they shout
    src.connect(mp.input);
    const mega = mp.gate;
    src.connect(analyser);
    r.graph = { el, src, pos, flat, mega, panner, analyser, buf: new Float32Array(analyser.fftSize) };
  }

  private rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /**
   * Every frame: keep the mesh in step with the room, place every voice, and
   * set our own outgoing voice from our health. `listener` is where our ears are (the camera).
   */
  /** `everywhere`: a parkour race, where every voice reaches everyone (see hearing()). */
  update(roster: number[], phase: MatchPhase, players: (id: number) => Player | undefined, listener: Vec3, everywhere = false): void {
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
      if (speaker) {
        if (r.wasAlive === true && !speaker.alive) r.diedAt = now; // just died: last words
        if (speaker.alive) r.diedAt = -Infinity;
        r.wasAlive = speaker.alive;
      }
      const dying = !!speaker && !speaker.alive && now - r.diedAt < VOICE.death.heardFor;
      // Shouting through a HECKLER: everyone on the map hears it, in their head, through the megaphone.
      const shouting = !!speaker && speaker.alive && speaker.shoutT > 0;
      const how = this.mode === 'off' ? 'mute' : shouting ? 'mega' : hearing(phase, speaker, me, dying, everywhere);
      let audible = 0;
      if (how === 'positional' && speaker) {
        const head = speaker.pos.y + (speaker.crouched ? 0.95 : 1.62);
        if (g.panner.positionX) {
          g.panner.positionX.setTargetAtTime(speaker.pos.x, now, 0.02);
          g.panner.positionY.setTargetAtTime(head, now, 0.02);
          g.panner.positionZ.setTargetAtTime(speaker.pos.z, now, 0.02);
        } else g.panner.setPosition(speaker.pos.x, head, speaker.pos.z);
        audible = voiceFalloff(Math.hypot(speaker.pos.x - listener.x, head - listener.y, speaker.pos.z - listener.z));
      } else if (how === 'flat' || how === 'mega') audible = 1;
      g.pos.gain.setTargetAtTime(how === 'positional' ? 1 : 0, now, SMOOTH);
      g.flat.gain.setTargetAtTime(how === 'flat' ? 1 : 0, now, SMOOTH);
      g.mega.gain.setTargetAtTime(how === 'mega' ? 1 : 0, now, 0.02);
      r.audible = audible;
      const rms = this.rms(g.analyser, g.buf);
      if (rms > TALK_LEVEL) r.lastLoud = now;
      r.level = how === 'mute' ? 0 : mouthOpenFor(rms);
    }

    // Our own voice: raised and thinned by our own health, gliding as damage comes in.
    this.buildFx(ctx);
    // Our own HECKLER: hear ourselves through the megaphone and its echo, a little
    // quieter than others hear us (a mic and speakers can howl: headphones are best).
    if (this.monitor) this.monitor.gate.gain.setTargetAtTime(me && me.alive && me.shoutT > 0 && this.transmitting ? SELF_MEGAPHONE : 0, now, 0.02);
    const mine = ownVoice(phase, me);
    if (me && this.fx) {
      if (this.meWasAlive === true && !me.alive && phase !== 'lobby') this.startDeathVoice(now);
      if (me.alive && this.dyingUntil > now) this.stopDeathVoice(now); // a new round started
      this.meWasAlive = me.alive;
    }
    this.pitch = mine.semitones;
    if (this.fx) {
      this.fx.shift.parameters.get('ratio')!.setTargetAtTime(Math.pow(2, mine.semitones / 12), now, VOICE.glide);
      this.fx.cut.frequency.setTargetAtTime(mine.lowCut, now, VOICE.glide);
    }

    // Our own level, so the indicator can show that the microphone really picks you up.
    if (this.mic && !this.micAnalyser) {
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      const src = ctx.createMediaStreamSource(this.mic);
      src.connect(node); // measured only, never played back
      this.micAnalyser = { node, src, buf: new Float32Array(node.fftSize) };
    }
    this.micRms = this.micAnalyser ? this.rms(this.micAnalyser.node, this.micAnalyser.buf) : 0;
    const micRms = this.transmitting ? this.micRms : 0;
    if (micRms > TALK_LEVEL) this.micLoud = now;
    this.micLevel = mouthOpenFor(micRms);
  }

  /**
   * We just died: our voice winds down like a tape (slower and deeper), fades
   * out at the end, and stays silent a moment so the living never catch the
   * first words of our ghost voice. All scheduled on the audio clock.
   */
  private startDeathVoice(now: number): void {
    this.dyingUntil = scheduleDeathVoice(this.fx!.shift, this.fx!.gate, now);
  }


  private stopDeathVoice(now: number): void {
    const fx = this.fx!;
    fx.shift.parameters.get('tape')!.cancelScheduledValues(now);
    fx.shift.parameters.get('tape')!.setValueAtTime(0, now);
    fx.gate.gain.cancelScheduledValues(now);
    fx.gate.gain.setValueAtTime(1, now);
    this.dyingUntil = -Infinity;
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
