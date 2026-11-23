// Proximity voice: who hears whom, from where, and what health does to a voice.
// Pure functions (no Web Audio), so the headless tests can check them.

import { PLAYER } from '../config/game';
import type { MatchPhase } from '../sim/match';

export const VOICE = {
  /** Metres within which a voice is at full volume. */
  near: 2.5,
  /** Metres at which a voice has faded to silence (linear in between). */
  far: 28,
  /**
   * Health raises the voice. At full health it is your normal voice; as
   * health drops, the pitch goes up (smoothly, as damage comes in) until at
   * 0 HP it is a full octave higher: the helium voice, very high but still
   * easy to understand. A gentle low cut thins it a little more. This is done
   * by the SPEAKER's own game, on their microphone, before it is sent, so
   * every listener hears the same thing and it follows the speaker's real health.
   */
  maxSemitones: 12, // pitch at 0 HP, in semitones above normal (12 = one octave)
  /** Curve on (1 - health): below 1 the rise is heard early in a fight, not only at the end. */
  curve: 0.85,
  lowCut: [80, 260] as const, // Hz: [full health, zero health]; gentle, never eats the vowels
  /** Seconds for the voice to glide to a new pitch after damage. */
  glide: 0.12,
  /**
   * Death voice. For `seconds` after you die your voice plays on like a tape
   * winding down: it starts at normal speed, then gets slower and deeper
   * (together) faster and faster, ending at `endRate` of normal speed (0.25 =
   * a quarter speed, two octaves down). `ease` shapes the slowdown: 2 keeps
   * the first half clear (still 81% speed halfway through) and saves the
   * dramatic part for the end. Everyone near your body still hears it. Then it fades out and
   * stays silent for `silenceAfter` seconds before your normal (ghost) voice
   * returns, which only the dead can hear. Listeners keep a dead speaker
   * audible for `heardFor` seconds after they see the death: a little longer
   * than the tape, because the death reaches them slightly later than the audio.
   */
  death: { seconds: 4, endRate: 0.25, ease: 2, fadeOut: 0.18, silenceAfter: 1.0, heardFor: 4.2 },
};

/** Playback speed of the death voice `t` seconds after dying (1 = normal). */
export function deathRate(t: number): number {
  const d = VOICE.death;
  const k = Math.max(0, Math.min(1, t / d.seconds));
  return 1 - (1 - d.endRate) * Math.pow(k, d.ease);
}

export interface VoiceShift {
  semitones: number;
  lowCut: number;
}

/** How a speaker with this much health should sound. */
export function voiceShift(health: number): VoiceShift {
  const h = Math.max(0, Math.min(1, health / PLAYER.maxHealth));
  const t = Math.pow(1 - h, VOICE.curve);
  return {
    semitones: VOICE.maxSemitones * t,
    lowCut: VOICE.lowCut[0] * Math.pow(VOICE.lowCut[1] / VOICE.lowCut[0], t),
  };
}

export const NORMAL_VOICE: VoiceShift = voiceShift(PLAYER.maxHealth);

/**
 * What the speaker's game applies to its own outgoing voice. Health only
 * counts while you are alive in a round: in the lobby, between rounds and
 * as a ghost you sound like yourself.
 */
export function ownVoice(phase: MatchPhase, me: { alive: boolean; health: number } | undefined): VoiceShift {
  if (!me || !me.alive || (phase !== 'countdown' && phase !== 'playing')) return NORMAL_VOICE;
  return voiceShift(me.health);
}

/**
 * How one player hears another.
 *   positional - from the speaker's head, fading with distance
 *   flat       - in your head at full quality
 *   mute       - not at all
 * Rules: in the lobby and between rounds (round, map and match end) everyone
 * hears everyone. During a round (countdown and play) the living are heard by
 * proximity; the dead can talk among themselves but the living cannot hear them,
 * except for the death voice in the first seconds after someone dies.
 * In a parkour race (`everywhere`) the course is long and runners spread out:
 * everyone hears everyone, wherever they are on it, at full volume.
 */
export function hearing(
  phase: MatchPhase,
  speaker: { alive: boolean } | undefined,
  listener: { alive: boolean } | undefined,
  /** The speaker died moments ago: their last words still come from where they fell. */
  dying = false,
  everywhere = false,
): 'positional' | 'flat' | 'mute' {
  if (phase !== 'countdown' && phase !== 'playing') return 'flat';
  if (everywhere) return speaker ? 'flat' : 'mute';
  if (!speaker) return 'mute'; // left the match
  if (speaker.alive || dying) return 'positional';
  return listener && !listener.alive ? 'flat' : 'mute';
}

/** Same falloff as the Web Audio panner (linear model): 1 within `near`, 0 from `far`. */
export function voiceFalloff(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance - VOICE.near) / (VOICE.far - VOICE.near)));
}
