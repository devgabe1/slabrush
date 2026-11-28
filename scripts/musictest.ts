// Soundtrack tests: `npm run test:music`. The composer (src/audio/composer.ts)
// is read song by song, without sound: every song must end, keep its notes
// inside its bars and its instruments' ranges, be heavy on guitar in battle,
// and never turn into a loop (the whole point of composing it live).
import { Composer, type Bar, type Mood } from '../src/audio/composer';
import { MUSIC } from '../src/config/music';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}

function song(seed: number, mood: Mood): { c: Composer; bars: Bar[] } {
  const c = new Composer(seed, mood);
  const bars: Bar[] = [];
  for (let b = c.nextBar(); b && bars.length < 2000; b = c.nextBar()) bars.push(b);
  return { c, bars };
}

const sig = (b: Bar) => JSON.stringify(b.notes.filter((n) => n.part !== 'hat' && n.part !== 'kick' && n.part !== 'snare' && n.part !== 'tom'));
const SEEDS = Array.from({ length: 40 }, (_, i) => (i * 2654435761) >>> 0);

for (const mood of ['match', 'menu'] as const) {
  const [lo, hi] = mood === 'match' ? MUSIC.matchLength : MUSIC.menuLength;
  let ended = 0, inBars = 0, inRange = 0, lengthOk = 0, noRuns = 0, varied = 0, total = 0;
  let worstRun = 0, worstVaried = 1;
  for (const seed of SEEDS) {
    const { c, bars } = song(seed, mood);
    total++;
    if (bars.length > 0 && bars.length < 2000 && c.nextBar() === null) ended++;
    const secs = bars.reduce((n, b) => n + b.steps * b.stepSec, 0);
    if (secs >= lo * 0.8 && secs <= hi * 1.5) lengthOk++;
    if (bars.every((b) => b.notes.every((n) => n.step >= 0 && n.step < b.steps && n.len > 0 && n.vel > 0 && n.vel <= 1))) inBars++;
    // Instruments stay in their ranges: nothing under the lowest string, the lead no higher than about A5.
    const ok = bars.every((b) => b.notes.every((n) =>
      n.part === 'rhythm' ? n.midi.every((m) => m >= c.root && m <= c.root + 24)
      : n.part === 'bass' ? n.midi[0] >= c.root - 12 && n.midi[0] < c.root
      : n.part === 'lead' ? n.midi[0] >= c.root + 24 && n.midi[0] <= 84
      : true));
    if (ok) inRange++;
    // Not a loop: the same bar never comes more than four times in a row, and most of the song is not repeats.
    let run = 1, longest = 1;
    for (let i = 1; i < bars.length; i++) { run = sig(bars[i]) === sig(bars[i - 1]) ? run + 1 : 1; longest = Math.max(longest, run); }
    worstRun = Math.max(worstRun, longest);
    if (longest <= 4) noRuns++;
    const distinct = new Set(bars.map(sig)).size / bars.length;
    worstVaried = Math.min(worstVaried, distinct);
    if (distinct >= 0.35) varied++;
  }
  check(`${mood}: every song ends`, ended === total, `${ended}/${total}`);
  check(`${mood}: songs last about as long as MUSIC says`, lengthOk === total, `${lengthOk}/${total}`);
  check(`${mood}: every note is inside its bar, with a loudness in 0..1`, inBars === total);
  check(`${mood}: instruments stay in their ranges`, inRange === total, `${inRange}/${total}`);
  check(`${mood}: no bar repeats more than four times in a row`, noRuns === total, `longest run ${worstRun}`);
  check(`${mood}: at least a third of each song's bars are unlike any other`, varied === total, `lowest ${(worstVaried * 100).toFixed(0)}%`);
}

// Battle songs are guitar music: chugs, ringing chords, a lead, and solos.
{
  let heavy = 0, withLead = 0, solos = 0, oddMeters = 0;
  for (const seed of SEEDS) {
    const { c, bars } = song(seed, 'match');
    const notes = bars.flatMap((b) => b.notes);
    if (notes.some((n) => n.part === 'rhythm' && n.mute) && notes.some((n) => n.part === 'rhythm' && !n.mute)) heavy++;
    if (notes.some((n) => n.part === 'lead')) withLead++;
    if (c.form.some((s) => s.kind === 'solo')) solos++;
    if (c.steps !== 16) oddMeters++;
  }
  check('match: every song has palm-muted chugs and open power chords', heavy === SEEDS.length, `${heavy}/${SEEDS.length}`);
  check('match: every song has a lead guitar', withLead === SEEDS.length);
  check('match: most songs have a solo', solos >= SEEDS.length * 0.6, `${solos}/${SEEDS.length}`);
  check('match: some songs are in odd meters (7/8, 3/4)', oddMeters > 0 && oddMeters < SEEDS.length, `${oddMeters}/${SEEDS.length}`);
}

// Menu songs are the calm ones: no chugging riffs.
{
  const chugs = SEEDS.filter((s) => song(s, 'menu').bars.some((b) => b.notes.some((n) => n.part === 'rhythm' && n.mute))).length;
  check('menu: no palm-muted riffs in the menu songs', chugs === 0, `${chugs} with chugs`);
}

// One song after another: each is new (key, tempo, meter or mode change), and a seed always gives the same song.
{
  let same = 0;
  for (let i = 1; i < SEEDS.length; i++) {
    const a = new Composer(SEEDS[i - 1], 'match'), b = new Composer(SEEDS[i], 'match');
    if (a.bpm === b.bpm && a.root === b.root && a.modeName === b.modeName && a.steps === b.steps) same++;
  }
  check('consecutive songs differ', same === 0, `${same} alike`);
  const x = song(1234, 'match').bars.map(sig).join('|'), y = song(1234, 'match').bars.map(sig).join('|');
  check('the same seed writes the same song', x === y);
  const keys = new Set(SEEDS.map((s) => { const c = new Composer(s, 'match'); return `${c.root}|${c.modeName}`; }));
  check('songs use many keys and modes', keys.size >= 10, `${keys.size} combinations`);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall music checks passed');
