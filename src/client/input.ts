import { BTN, type InputCmd } from '../sim/types';
import type { Action, Settings } from './settings';

const BUTTON_ACTIONS: [Action, number][] = [
  ['jump', BTN.JUMP], ['crouch', BTN.CROUCH], ['walk', BTN.WALK], ['fire', BTN.FIRE], ['fire2', BTN.FIRE2],
  ['throw', BTN.THROW], ['use', BTN.USE], ['slot1', BTN.SLOT1], ['slot2', BTN.SLOT2], ['swap', BTN.SWAP],
];
const MAX_PITCH = Math.PI / 2 - 0.02;

/** Keyboard + mouse (pointer lock). Produces one InputCmd per simulation tick. */
export class Input {
  yaw = 0;
  pitch = 0;
  locked = false;
  /** mouse movement since the last frame, for viewmodel sway */
  swayX = 0;
  swayY = 0;
  /** set when the fire key goes down; the app clears it (used to cycle the spectator camera) */
  firePressed = false;
  /** Mouse sensitivity multiplier, set each frame: lower while zoomed in so aim feels the same. */
  zoomScale = 1;
  onLockChange: (locked: boolean) => void = () => {};

  private down = new Set<string>();
  /** keys pressed since the last sample, so a tap shorter than one tick still registers */
  private tapped = new Set<string>();
  private seq = 0;

  constructor(private canvas: HTMLCanvasElement, private settings: Settings) {
    document.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      if (e.code !== 'F5' && e.code !== 'F11' && e.code !== 'F12') e.preventDefault();
      if (!e.repeat) this.press(e.code);
    });
    document.addEventListener('keyup', (e) => this.down.delete(e.code));
    document.addEventListener('mousedown', (e) => { if (this.locked) this.press('Mouse' + e.button); });
    document.addEventListener('mouseup', (e) => this.down.delete('Mouse' + e.button));
    document.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    document.addEventListener('wheel', () => { if (this.locked) this.tapped.add('Wheel'); }, { passive: true });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = 0.0022 * this.settings.sensitivity * this.zoomScale;
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - e.movementY * k));
      this.swayX += e.movementX;
      this.swayY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.clear();
      this.onLockChange(this.locked);
    });
    window.addEventListener('blur', () => this.clear());
  }

  private press(code: string): void {
    this.down.add(code);
    this.tapped.add(code);
    if (code === this.settings.keys.fire) this.firePressed = true;
  }

  private clear(): void {
    this.down.clear();
    this.tapped.clear();
  }

  lock(): void {
    // Browsers reject re-locking for ~1 s after Esc; the pause menu just stays up.
    const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => {});
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  setView(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = pitch;
  }

  /** Recoil: kicks the real aim, like the classics. */
  addRecoil(pitchRad: number, yawRad: number): void {
    this.pitch = Math.min(MAX_PITCH, this.pitch + pitchRad);
    this.yaw += yawRad;
  }

  private held(a: Action): boolean {
    const code = this.settings.keys[a];
    return this.down.has(code) || this.tapped.has(code);
  }

  sample(): InputCmd {
    let buttons = 0;
    for (const [a, bit] of BUTTON_ACTIONS) if (this.held(a)) buttons |= bit;
    if (this.tapped.has('Wheel')) buttons |= BTN.SWAP;
    const cmd: InputCmd = {
      seq: this.seq++,
      buttons,
      moveF: (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0),
      moveR: (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0),
      yaw: this.yaw,
      pitch: this.pitch,
    };
    this.tapped.clear();
    return cmd;
  }
}
