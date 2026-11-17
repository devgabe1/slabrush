// User settings, persisted in localStorage.
import type { VoiceMode } from '../audio/voice';
import { cleanLook, randomLook, type Look } from '../config/looks';
import { keyboardLockSupported } from './fullscreen';

/**
 * Crouch is on Ctrl where the browser lets a fullscreen game capture Ctrl+W
 * (Chrome, Edge, Opera: see fullscreen.ts), with fullscreen-when-playing on so
 * that capture is active. Elsewhere (Firefox, Safari) Ctrl+W would close the
 * tab mid-crouch, so those browsers default to Shift.
 */
const CTRL_CROUCH = keyboardLockSupported;

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'walk'
  | 'fire' | 'fire2' | 'throw' | 'use' | 'slot1' | 'slot2' | 'swap' | 'talk';

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right',
  jump: 'Jump / wall jump', crouch: 'Crouch / slide', walk: 'Slow walk',
  fire: 'Fire / punch', fire2: 'Aim / scope (fires the right-hand weapon when dual wielding)', throw: 'Throw weapon', use: 'Pick up / swap',
  slot1: 'Weapon 1', slot2: 'Weapon 2', swap: 'Switch weapon',
  talk: 'Push to talk (voice)',
};

export interface Settings {
  nickname: string;
  look: Look; // character: [face, torso, legs]
  sensitivity: number;
  fov: number;
  renderScale: number; // internal resolution multiplier (lower = chunkier pixels)
  volume: number;
  retro: 'off' | 'dither' | 'crt'; // final-pass filter
  shake: number; // screen shake multiplier, 0 = none
  crosshair: 'cross' | 'dot' | 'circle';
  /** Proximity voice chat: off, push-to-talk, or always-open microphone. */
  voice: VoiceMode;
  voiceVolume: number; // other players' voices, on top of the master volume
  voiceRev?: number; // settings migration marker
  keysRev?: number; // settings migration marker (crouch moved to Ctrl)
  /** Microphone deviceId ('' = the system default). */
  micDevice: string;
  /** Go fullscreen when a match / practice starts (captures Ctrl+W & co. where supported). */
  autoFullscreen: 'off' | 'on';
  keys: Record<Action, string>; // KeyboardEvent.code, or Mouse0/Mouse1/Mouse2
  /** Phase 2: optional TURN server for restrictive NATs. */
  turn: { url: string; username: string; credential: string };
}

export const DEFAULT_SETTINGS: Settings = {
  nickname: 'PLAYER',
  look: [0, 0, 0],
  sensitivity: 1,
  fov: 100,
  renderScale: 0.5,
  volume: 0.7,
  retro: 'dither',
  shake: 1,
  crosshair: 'cross',
  voice: 'open',
  voiceVolume: 1,
  micDevice: '',
  autoFullscreen: CTRL_CROUCH ? 'on' : 'off',
  keys: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    jump: 'Space',
    crouch: CTRL_CROUCH ? 'ControlLeft' : 'ShiftLeft',
    walk: 'KeyC',
    fire: 'Mouse0', fire2: 'Mouse2', throw: 'KeyG', use: 'KeyE',
    slot1: 'Digit1', slot2: 'Digit2', swap: 'KeyQ',
    talk: 'KeyT',
  },
  turn: { url: '', username: '', credential: '' },
};

const KEY = 'slabrush.settings.v1';

export function loadSettings(): Settings {
  const s: Settings = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // First visit: everyone starts as somebody different.
    raw.look = raw.look ? cleanLook(raw.look) : randomLook();
    // Voice used to default to push to talk, and saved settings carry that
    // along; move everyone to the new open-mic default once.
    if ((raw.voiceRev ?? 0) < 2) { raw.voice = 'open'; raw.voiceRev = 2; }
    // Crouch used to default to Shift. Anyone still on that old default moves
    // to the new one once (and gets fullscreen-when-playing with it, which is
    // what makes Ctrl safe); a key someone chose themselves is left alone.
    if ((raw.keysRev ?? 0) < 2) {
      if (CTRL_CROUCH && raw.keys?.crouch === 'ShiftLeft') { raw.keys.crouch = 'ControlLeft'; raw.autoFullscreen = 'on'; }
      raw.keysRev = 2;
    }
    Object.assign(s, raw, {
      keys: { ...s.keys, ...(raw.keys ?? {}) },
      turn: { ...s.turn, ...(raw.turn ?? {}) },
    });
  } catch {
    /* corrupted or unavailable storage: fall back to defaults */
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function keyLabel(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Control/, 'Ctrl').replace('Left', ' L').replace('Right', ' R').toUpperCase();
}
