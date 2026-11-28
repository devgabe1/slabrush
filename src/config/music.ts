// Soundtrack tuning. The music is composed while it plays (src/audio/composer.ts)
// and synthesised like every other sound (src/audio/music.ts): no audio files.

export const MUSIC = {
  /** Default music volume, 0..1, on top of the master volume. */
  volume: 0.5,
  /** Tempo range of a battle song, in quarter notes per minute. */
  matchBpm: [104, 148] as const,
  /** Tempo range of a menu song: slower, mostly ambient. */
  menuBpm: [72, 96] as const,
  /** Seconds of near silence between two songs, so one never runs into the next like a loop. */
  gap: [6, 18] as const,
  /** A battle song stops adding sections once it is this long, in seconds. */
  matchLength: [150, 270] as const,
  /** A menu song's length, in seconds. */
  menuLength: [110, 200] as const,
  /** Seconds a song takes to fade out when the mood changes (menu to match and back). */
  fade: 1.4,
  /**
   * Lowest guitar string of each tuning a song may use, as a MIDI note: drop D,
   * drop C#, drop C and a seven-string B. Low on purpose (keep it low-pitched).
   */
  tunings: [38, 37, 36, 35] as const,
  /** How hard the rhythm guitars are driven into the distortion (pre-gain). */
  rhythmDrive: 22,
  /** The lead guitar's drive: less than the rhythm, so its melody stays readable. */
  leadDrive: 9,
  /** Seconds of reverb tail. */
  reverb: 2.6,
};
