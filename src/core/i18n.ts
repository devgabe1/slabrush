// Interface language. The game's text is written in English in the code; `t()`
// looks the English up in a dictionary and returns the translation for the
// current language. A string with no entry simply shows in English, so a new
// line of text never breaks the screen, it just waits for its translation.
import { PT } from './ptBR';

export type Lang = 'pt' | 'en';
export const LANGS: readonly Lang[] = ['pt', 'en'];

/** Brazilian Portuguese is the default: the game is made for it first. */
export const DEFAULT_LANG: Lang = 'pt';

let current: Lang = DEFAULT_LANG;

export function getLang(): Lang {
  return current;
}

/** Switch the language and mark the page with it (screen readers and hyphenation read that). */
export function setLang(lang: Lang): void {
  current = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  if (typeof document !== 'undefined') document.documentElement.lang = current === 'pt' ? 'pt-BR' : 'en';
}

/**
 * The text for `en` in the current language. `{name}` in the text is replaced
 * by `vars.name`, so a number or a room code can sit in the middle of a sentence.
 */
export function t(en: string, vars?: Record<string, string | number>): string {
  let s = current === 'pt' ? (PT[en] ?? en) : en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/**
 * A name the generator builds from parts, such as "MEDIUM ARENA 1A2B3C4D": a
 * name with a line of its own is translated whole; otherwise each word is.
 */
export function tName(name: string): string {
  if (current === 'en' || name in PT) return t(name);
  return name.split(' ').map((w) => t(w)).join(' ');
}

/** The name of a language, written in that language (for the picker). */
export const LANG_NAMES: Record<Lang, string> = { pt: 'Português', en: 'English' };
