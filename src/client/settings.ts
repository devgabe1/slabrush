// User settings, persisted in localStorage.
import type { VoiceMode } from '../audio/voice';
import { cleanLook, randomLook, type Look } from '../config/looks';
import { keyboardLockSupported } from './fullscreen';

/**
 * Shift is crouch / slide. Ctrl is a plain crouch (never slides), bound by
 * default where the browser lets a fullscreen game capture Ctrl+W (Chrome,
 * Edge, Opera: see fullscreen.ts), with fullscreen-when-playing on so that
 * capture is active. Elsewhere (Firefox, Safari) Ctrl+W would close the tab
 * mid-crouch, so it starts unbound there (bind it in Settings if you like).
 */
const CTRL_DUCK = keyboardLockSupported;

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'crouch' | 'duck' | 'walk'
  | 'fire' | 'fire2' | 'throw' | 'use' | 'slot1' | 'slot2' | 'swap' | 'talk' | 'scores';

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right',
  jump: 'Jump / wall jump', crouch: 'Crouch / slide', duck: 'Crouch only (never slides)', walk: 'Slow walk',
  fire: 'Fire / punch', fire2: 'Aim / scope (fires the right-hand weapon when dual wielding)', throw: 'Throw weapon', use: 'Pick up / swap',
  slot1: 'Weapon 1', slot2: 'Weapon 2', swap: 'Switch weapon',
  talk: 'Push to talk (voice)',
  scores: 'Scoreboard (hold)',
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
  keysRev?: number; // settings migration marker (crouch keys)
  /** Microphone deviceId ('' = the system default). */
  micDevice: string;
  /** Go fullscreen when a match / practice starts (captures Ctrl+W & co. where supported). */
  autoFullscreen: 'off' | 'on';
  keys: Record<Action, string>; // KeyboardEvent.code, or Mouse0/Mouse1/Mouse2
  /** Phase 2: optional TURN server for restrictive NATs. */
  turn: { url: string; username: string; credential: string };
  /** The last choice when creating a room: listed under JOIN ROOM, or joined by code only. */
  roomVisibility: 'public' | 'private';
}

export const DEFAULT_SETTINGS: Settings = {
  nickname: 'PLAYER',
  look: [0, 0, 0],
  roomVisibility: 'public',
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
  autoFullscreen: CTRL_DUCK ? 'on' : 'off',
  keys: {
    forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
    jump: 'Space',
    crouch: 'ShiftLeft',
    duck: CTRL_DUCK ? 'ControlLeft' : '',
    walk: 'KeyC',
    fire: 'Mouse0', fire2: 'Mouse2', throw: 'KeyG', use: 'KeyE',
    slot1: 'Digit1', slot2: 'Digit2', swap: 'KeyQ',
    talk: 'KeyT',
    scores: 'Tab',
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
    // Crouch / slide briefly moved to Ctrl (keysRev 2). It belongs on Shift,
    // with Ctrl as its own crouch-only key: move it back once.
    if ((raw.keysRev ?? 0) < 3) {
      if (raw.keys?.crouch === 'ControlLeft') raw.keys.crouch = 'ShiftLeft';
      raw.keysRev = 3;
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
  if (!code) return 'NONE';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Control/, 'Ctrl').replace('Left', ' L').replace('Right', ' R').toUpperCase();
}
