// Fullscreen + Keyboard Lock: so Ctrl can be crouch without Ctrl+W closing the tab.
//
// Browsers keep shortcuts like Ctrl+W, Ctrl+T and Ctrl+N for themselves, and a
// page cannot cancel them. The Keyboard Lock API (Chrome, Edge, Opera) is the
// one exception, made for games and remote desktops: while the page is
// fullscreen it may ask for keys to come to it instead of the browser. We ask
// for every ordinary key EXCEPT Escape, so Esc still opens the menu and leaves
// fullscreen exactly as before. Other browsers simply do not get this, and the
// "Leave site?" confirmation in app.ts is the safety net there.

interface KeyboardLockApi {
  lock(keys?: string[]): Promise<void>;
  unlock(): void;
}
const keyboard = (): KeyboardLockApi | undefined => (navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard;

/** True where the browser can capture Ctrl+W & co. in fullscreen. */
export const keyboardLockSupported = typeof navigator !== 'undefined' && typeof keyboard()?.lock === 'function';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => 'Key' + c);
const DIGITS = '0123456789'.split('').map((d) => 'Digit' + d);
/**
 * Everything a player might press in combination with Ctrl/Alt/Meta. Not
 * Escape (menu, leave fullscreen), and not F-keys (F5 reload, F11, F12 stay the browser's).
 */
const LOCK_KEYS = [
  ...LETTERS, ...DIGITS,
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'Space', 'Tab', 'Enter', 'Backspace', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete',
];

/** Whether browser shortcuts are being captured right now. */
export let keyboardLocked = false;

/** Lock the keys whenever the page goes fullscreen, release them when it leaves. Call once. */
export function watchFullscreen(onChange: () => void = () => {}): void {
  document.addEventListener('fullscreenchange', () => {
    const kb = keyboard();
    if (document.fullscreenElement && kb) {
      kb.lock(LOCK_KEYS).then(() => { keyboardLocked = true; onChange(); }, () => { keyboardLocked = false; onChange(); });
    } else {
      kb?.unlock();
      keyboardLocked = false;
      onChange();
    }
  });
}

/** Go fullscreen (needs a recent click). Resolves either way. */
export function enterFullscreen(): Promise<void> {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return Promise.resolve();
  return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

export function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void enterFullscreen();
}
