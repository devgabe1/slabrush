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
   * Health shapes the voice. At full health it is a normal, full voice; as
   * health drops the low end is cut away, the top closes in and a nasal
   * mid-range bump comes up, so a nearly dead player sounds thin and tinny,
   * like a voice through a cheap radio. Every value interpolates between
   * [full health, zero health].
   */
  highpass: [90, 1100] as const, // Hz: the floor of the voice rises (lost body)
  highpassQ: [0.7, 1.6] as const, // a resonant edge makes it tinnier
  lowpass: [7500, 3000] as const, // Hz: the top closes in
  nasalHz: 1700,
  nasal: [0, 7] as const, // dB of mid-range bump
  gain: [1, 0.75] as const, // a weak voice is also a little quieter
  /** Curve on (1 - health): below 1 the thinning is heard early in the fight, not just at the end. */
  curve: 0.8,
};

export interface VoiceTone {
  highpass: number;
  highpassQ: number;
  lowpass: number;
  nasal: number;
  gain: number;
}

const lin = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;
const exp = (r: readonly [number, number], t: number) => r[0] * Math.pow(r[1] / r[0], t); // frequencies: even steps to the ear

/** The filter settings for a speaker with this much health. */
export function voiceTone(health: number): VoiceTone {
  const h = Math.max(0, Math.min(1, health / PLAYER.maxHealth));
  const t = Math.pow(1 - h, VOICE.curve);
  return {
    highpass: exp(VOICE.highpass, t),
    highpassQ: lin(VOICE.highpassQ, t),
    lowpass: exp(VOICE.lowpass, t),
    nasal: lin(VOICE.nasal, t),
    gain: lin(VOICE.gain, t),
  };
}

/** A full, untouched voice (between rounds, in the lobby, the dead talking among themselves). */
export const CLEAN_TONE: VoiceTone = voiceTone(PLAYER.maxHealth);

/**
 * How one player hears another.
 *   positional - from the speaker's head, fading with distance, thinned by their health
 *   flat       - in your head at full quality
 *   mute       - not at all
 * Rules: in the lobby and between rounds (round, map and match end) everyone
 * hears everyone. During a round (countdown and play) the living are heard by
 * proximity; the dead can talk among themselves but the living cannot hear them.
 */
export function hearing(
  phase: MatchPhase,
  speaker: { alive: boolean } | undefined,
  listener: { alive: boolean } | undefined,
): 'positional' | 'flat' | 'mute' {
  if (phase !== 'countdown' && phase !== 'playing') return 'flat';
  if (!speaker) return 'mute'; // left the match
  if (speaker.alive) return 'positional';
  return listener && !listener.alive ? 'flat' : 'mute';
}

/** Same falloff as the Web Audio panner (linear model): 1 within `near`, 0 from `far`. */
export function voiceFalloff(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance - VOICE.near) / (VOICE.far - VOICE.near)));
}
