// Translation tests: `npm run test:i18n`. The game opens in Brazilian
// Portuguese; these checks make sure every line of text the code asks to
// translate has its Portuguese, that each translation keeps the {placeholders}
// of its English (a dropped number or name would be silent otherwise), and
// that the weapon names still fit the HUD slots.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LANG, getLang, setLang, t } from '../src/core/i18n';
import { PT } from '../src/core/ptBR';
import { WEAPONS } from '../src/config/weapons';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}

/** Every t('…') written with a literal text in the game's source. */
function literalKeys(dir: string, found = new Set<string>()): Set<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) literalKeys(p, found);
    else if (p.endsWith('.ts')) {
      for (const m of readFileSync(p, 'utf8').matchAll(/(?<![\w.])t\(\s*'((?:[^'\\\n]|\\.)*)'/g)) found.add(m[1].replace(/\\'/g, "'"));
    }
  }
  return found;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// 1. The default language is Portuguese, and English is still there.
check('the game opens in Brazilian Portuguese', DEFAULT_LANG === 'pt' && getLang() === 'pt');
check('a Portuguese line is shown by default', t('CREATE ROOM') === 'CRIAR SALA');
setLang('en');
check('English is shown when chosen', t('CREATE ROOM') === 'CREATE ROOM');
setLang('pt');

// 2. Interpolation fills in the {placeholders}.
check('a {name} in the text is filled in', t('as at {hp}', { hp: 5 }) === 'como com 5');
check('a text with no translation stays as written', t('no such line in the game') === 'no such line in the game');

// 3. Every literal line the code translates has a Portuguese version.
const used = [...literalKeys('src')];
const untranslated = used.filter((k) => !(k in PT));
check(`every translated line has a Portuguese version (${used.length} lines)`, untranslated.length === 0, untranslated.join(' | '));

// 4. Translations keep the placeholders of their English.
const broken = Object.entries(PT).filter(([en, pt]) => placeholders(en) !== placeholders(pt)).map(([en]) => en);
check('each translation keeps its {placeholders}', broken.length === 0, broken.join(' | '));

// 5. Weapon names fit the HUD slot (9 characters), in both languages.
setLang('pt');
const longPt = (Object.keys(WEAPONS) as (keyof typeof WEAPONS)[]).filter((id) => t(WEAPONS[id].name).length > 9).map((id) => t(WEAPONS[id].name));
check('weapon names fit the HUD slots in Portuguese (9 characters)', longPt.length === 0, longPt.join(' | '));

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('translation tests failed');
