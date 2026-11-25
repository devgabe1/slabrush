// Map lab tests: `npm run test:maps`. The editor, the map file check (every
// file from outside goes through it), submission codes, and a hand-made map
// played: a parkour course run to the finish, a battle map with its spawns.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DT, RULES_PRACTICE } from '../src/config/game';
import { MapEditor, type Aim } from '../src/maps/editor';
import { LIMITS, cleanMapFile, courseFromFile, decodeMap, encodeMap, type MapFile } from '../src/maps/mapFile';
import { ParkourSession } from '../src/net/parkourSession';
import { GameSim } from '../src/sim/game';
import { addToRotation, readSubmission } from './addmap';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const up = { x: 0, y: 1, z: 0 };
const on = (x: number, y: number, z: number, yaw = 0, solid = 0): Aim => ({ point: { x, y, z }, normal: up, solid, yaw });

// ------------------------------------------------------------ the editor
const side = (x: number, y: number, z: number, nx: number, nz: number, solid: number, yaw = 0): Aim => ({ point: { x, y, z }, normal: { x: nx, y: 0, z: nz }, solid, yaw });
{
  const ed = new MapEditor(MapEditor.blank('battle', 'T')); // (its floor: x and z -12..12, top at 0)
  check('a new battle map starts with a floor, nothing else', ed.map.solids.length === 1 && !ed.map.spawns.length && ed.problem() !== '');
  ed.tool = 'block'; ed.shape = 0;
  ed.place(on(0.3, 0, 0.2));
  const b = ed.map.solids[1];
  check('a block on top of another sits on its grid (in steps of its own size)', b.min.y === 0 && b.max.y === 1 && b.min.x === 0 && b.max.x === 4 && b.min.z === 0, JSON.stringify(b.min));
  ed.place(side(4, 0.2, 3.1, 1, 0, 1));
  const next = ed.map.solids[2];
  check('against its side, the next one joins it: flush top, in line, no gap', next.min.x === 4 && next.max.x === 8 && next.max.y === 1 && next.min.z === 0 && next.max.z === 4, JSON.stringify(next.min));
  // a run of ramps: the first against the block's side rises towards it; aimed at a ramp, the next continues it
  ed.tool = 'ramp'; ed.size = [4, 1, 4];
  ed.place(side(0, 0.5, 2, -1, 0, 1));
  const r1 = ed.map.solids[3];
  check('a ramp against a block rises towards it, from its foot to its top', r1.type === 'ramp' && r1.high === '+x' && r1.max.x === 0 && r1.max.y === 1 && r1.min.y === 0, JSON.stringify([r1.min, r1.high]));
  ed.place(side(6, 1.5, 2, 0, 0, 2)); // (a ramp from the far block up and away)
  ed.place({ point: { x: -2, y: 0.5, z: 2 }, normal: { x: -0.7, y: 0.7, z: 0 }, solid: 3, yaw: 0 }); // aimed at the first ramp's slope
  const r2 = ed.map.solids[5];
  check('aimed at a ramp, the next ramp carries on from its top, same slope and direction', r2.type === 'ramp' && r2.high === r1.high && r2.min.x === r1.max.x && r2.min.y === r1.max.y && r2.max.z - r2.min.z === r1.max.z - r1.min.z, JSON.stringify([r2.min, r2.max]));
  ed.tool = 'block';
  ed.place({ point: { x: 2, y: 1.5, z: 2 }, normal: { x: -0.7, y: 0.7, z: 0 }, solid: 5, yaw: 0 });
  const landing = ed.map.solids[6];
  check('...and the block tool puts a landing at its top', landing.min.x === r2.max.x && landing.max.y === r2.max.y);
  ed.tool = 'spawn'; ed.place(on(5.3, 0, 5.8, 1)); ed.place(on(-5, 0, -5));
  check('spawn points snap to the middle of a square', ed.map.spawns[0].pos.x === 5.5 && ed.map.spawns[0].pos.z === 5.5 && ed.map.spawns.length === 2 && ed.problem() === '' && ed.map.spawns[0].yaw === 1);
  ed.place(side(4, 0.5, 0.2, 1, 0, 1)); // (its +x face)
  check('aimed at the side of a block, a spawn point goes on top of it, at that edge', ed.map.spawns[2]?.pos.y === 1 && ed.map.spawns[2].pos.x === 3.5);
  check('nothing to stand on (a ramp, the open): no spawn point', !ed.place(on(0, 1, 0, 0, 3)) && !ed.place(on(0, 1, 0, 0, -1)));
  ed.remove(on(5.5, 0, 5.5));
  check('remove takes the spawn point aimed at, not the floor under it', ed.map.spawns.length === 2 && ed.map.solids.length === 7);
  ed.remove(on(2, 1, 2, 0, 1));
  check('...and a block when there is nothing smaller there', ed.map.solids.length === 6);
  ed.undo(); ed.undo();
  check('undo brings them back', ed.map.solids.length === 7 && ed.map.spawns.length === 3);
  // copy a block (middle click), turn it, make it taller; what a right click would take is named
  const wall = new MapEditor(MapEditor.blank('battle', 'T'));
  wall.shape = 8; wall.cycle('mat', 2); wall.place(on(0, 0, 0));
  wall.shape = 0; wall.mat = 0;
  wall.pick({ point: { x: 0, y: 2, z: 0 }, normal: { x: 0, y: 0, z: 1 }, solid: 1, yaw: 0 });
  check('middle click copies a block: its size and material', wall.size.join() === '8,4,1' && wall.mats()[wall.mat] === wall.map.solids[1].mat && wall.shapeName === 'wall');
  wall.rotate(); wall.taller(1);
  check('R turns it, Shift+wheel makes it taller', wall.size.join() === '1,4.5,8' && wall.shapeName === 'custom');
  const t = wall.target({ point: { x: 0, y: 2, z: 0 }, normal: { x: 0, y: 0, z: 1 }, solid: 1, yaw: 0 });
  check('what a right click would remove is named (and outlined)', t?.what === 'block' && t.index === 1 && t.label.startsWith('BLOCK 8×4×1'), t?.label);
  const pk = new MapEditor(MapEditor.blank('parkour', 'T'));
  pk.tool = 'start'; pk.place(on(0, 0, 0));
  pk.tool = 'block'; pk.place(side(0, -0.5, -4, 0, -1, 0)); pk.place(side(0, -0.5, -8, 0, -1, 1));
  pk.tool = 'checkpoint'; pk.place(on(1, 0, -6, 0, 1)); pk.place(on(1, 0, -10, 0, 2));
  pk.remove(on(1, 0.5, -5));
  check('checkpoints are numbered in order, and renumbered when one goes', pk.map.triggers.filter((t) => t.type === 'checkpoint').map((t) => (t.type === 'checkpoint' ? t.index : 0)).join() === '1');
  check('a parkour map needs a finish', pk.problem().includes('FINISH'));
}

// ------------------------------------------------------------ zones, spikes, weapon spots
{
  const ed = new MapEditor(MapEditor.blank('battle', 'T'));
  ed.select('spikes'); ed.size = [4, 1, 4];
  ed.place(on(1, 0, 1));
  const spikes = ed.map.solids.filter((x) => x.mat === 'iron' && x.surface === 'deadly');
  check('spikes: a bed of iron spikes over the footprint, deadly', spikes.length === 32 && spikes.every((x) => x.min.y >= 0 && x.max.y <= 0.9) && !!ed.map.palette.mats.iron, `${spikes.length} pieces`);
  const t = ed.target(on(0.55, 0.9, 0.55, 0, ed.map.solids.indexOf(spikes[1])));
  check('right click takes the whole bed at once', t?.indices?.length === 32 && ed.remove(on(0.55, 0.9, 0.55, 0, ed.map.solids.indexOf(spikes[1]))) && ed.map.solids.length === 1);
  ed.select('lowgrav');
  check('a zone tool starts room-sized', ed.size.join() === '8,6,8');
  ed.place(on(4, 0, 4)); ed.select('dark'); ed.place(on(-4, 0, -4));
  ed.select('weapon'); ed.place(on(2, 0, 2)); ed.weapon = 'hornet'; ed.place(on(-2, 0, -2));
  ed.select('spawn'); ed.place(on(6, 0, 6)); ed.place(on(-6, 0, -6));
  const f = cleanMapFile(JSON.parse(JSON.stringify(ed.file)));
  check('low gravity and dark zones are kept by the file check', f.map.triggers.some((x) => x.type === 'lowgrav' && x.scale === 0.35) && f.map.triggers.some((x) => x.type === 'dark'));
  check('weapon spots: a chosen weapon, or random', f.map.pickups.map((p) => p.weapon).join() === 'random,hornet');
  const bad = JSON.parse(JSON.stringify(ed.file)); bad.map.pickups[0].weapon = 'fists';
  check('...but never fists', throws(() => cleanMapFile(bad)));
  const g = new GameSim(f.map, 3, RULES_PRACTICE);
  check('a random spot fills with a real weapon', g.pickups.length === 2 && g.pickups.every((p) => p.weapon.type !== ('random' as string) && !!p.weapon.type), g.pickups.map((p) => p.weapon.type).join());
}

// ------------------------------------------------------------ the file check
const good = (): MapFile => {
  const ed = new MapEditor(MapEditor.blank('parkour', 'T'));
  ed.tool = 'start'; ed.place(on(0, 0, 0));
  ed.tool = 'block'; ed.shape = 0; ed.place(side(0, -0.5, -4, 0, -1, 0)); ed.place(side(0, -0.5, -8, 0, -1, 1)); // two platforms beyond it, joined
  ed.tool = 'finish'; ed.place(on(1, 0, -10, 0, 2));
  ed.file.name = 'Test Run';
  return ed.file;
};
{
  const f = good();
  const back = cleanMapFile(JSON.parse(JSON.stringify(f)));
  check('a map survives being saved and checked', JSON.stringify(back.map.solids) === JSON.stringify(f.map.solids) && back.map.triggers.length === f.map.triggers.length);
  const bad = (change: (o: any) => void) => { const o = JSON.parse(JSON.stringify(f)); change(o); return throws(() => cleanMapFile(o)); };
  check('junk is refused', throws(() => cleanMapFile('hello')) && throws(() => cleanMapFile(null)) && bad((o) => { o.format = 'x'; }));
  check('an unknown material, shape or trigger is refused', bad((o) => { o.map.solids[0].mat = 'unobtainium'; }) && bad((o) => { o.map.solids[0].type = 'sphere'; }) && bad((o) => { o.map.triggers[0].type = 'teleporter'; }));
  check('numbers that are not numbers, or far out, are refused', bad((o) => { o.map.solids[0].min.x = 'NaN'; }) && bad((o) => { o.map.solids[0].max.y = 1e9; }) && bad((o) => { o.map.solids[0].min.x = o.map.solids[0].max.x; }));
  check('too many blocks is refused', bad((o) => { o.map.solids = Array.from({ length: LIMITS.solids + 1 }, () => o.map.solids[0]); }));
  check('a parkour map with no finish is refused (unless it is a draft)', bad((o) => { o.map.triggers = o.map.triggers.filter((t: any) => t.type !== 'finish'); })
    && (() => { const o = JSON.parse(JSON.stringify(f)); o.map.triggers = []; return !throws(() => cleanMapFile(o, false)); })());
  const evil = cleanMapFile({ ...JSON.parse(JSON.stringify(f)), name: '<img src=x onerror=alert(1)>', author: '"><script>' , extra: 1 });
  check('names are cleaned, extra fields dropped', !/[<>"]/.test(evil.name + evil.author) && !('extra' in evil));
  const weird = JSON.parse(JSON.stringify(f)); weird.map.solids[0].mover = { dx: 1e9 }; weird.map.decor = [1, 2]; weird.map.solids[0].push = { x: 99, y: 0, z: 0 };
  const w = cleanMapFile(weird);
  check('only what the editor makes is kept (no movers, belts or decor slipped in)', !w.map.solids[0].mover && !w.map.solids[0].push && !w.map.decor);
}

// ------------------------------------------------------------ submissions
{
  const f = good();
  const code = await encodeMap(f);
  const back = await decodeMap(code);
  check('a map squeezed into a code comes back the same', back.id === f.id && JSON.stringify(back.map.solids) === JSON.stringify(f.map.solids), `${code.length} characters`);
  const fromIssue = await readSubmission(`A parkour map made in the map lab.\n\n\`\`\`slabrush-map\n${code}\n\`\`\`\n`);
  check('add-map reads a submission (the issue text) and a downloaded file', fromIssue.id === f.id && (await readSubmission(JSON.stringify(f))).id === f.id);
  check('a broken code is refused', await decodeMap('AAAA').then(() => false, () => true));
  const dir = mkdtempSync(join(tmpdir(), 'maps-'));
  writeFileSync(`${dir}/index.ts`, readFileSync('src/maps/custom/index.ts', 'utf8'));
  addToRotation(back, dir);
  const index = readFileSync(`${dir}/index.ts`, 'utf8');
  const entry = readFileSync(`${dir}/${back.id}.ts`, 'utf8');
  const name = 'map_' + back.id.replace(/-/g, '_');
  check('add-map writes the map and lists it in the rotation', index.includes(`import ${name} from './${back.id}';`) && index.includes(`  ${name},\n`) && entry.includes('export default {'));
  check('...once', throws(() => addToRotation(back, dir)));
}

// ------------------------------------------------------------ played
{
  // a parkour map run as a course: off the start, onto the finish
  const c = courseFromFile(cleanMapFile(good()));
  const s = new ParkourSession(c, 'T');
  const sim = (s as unknown as { sim: GameSim }).sim;
  for (let i = 0; i < 3 / DT && s.run.phase !== 'finished'; i++) {
    sim.setInput(1, { seq: i, buttons: 0, moveF: 1, moveR: 0, pitch: 0, yaw: 0 }); // straight ahead (-z), to the finish
    s.step();
  }
  check('a hand-made parkour map plays as a course, start to finish', s.run.phase === 'finished', `${s.run.phase}, at z ${s.player.pos.z.toFixed(1)}`);
  // a battle map: players come in on its spawn points
  const ed = new MapEditor(MapEditor.blank('battle', 'T'));
  ed.tool = 'spawn'; ed.place(on(6, 0, 6)); ed.place(on(-6, 0, -6));
  const m = cleanMapFile(ed.file).map;
  const g = new GameSim(m, 1, RULES_PRACTICE);
  const a = g.addPlayer(1, 'A', 0xffffff, null, m.spawns[0]), b = g.addPlayer(2, 'B', 0xffffff, null, m.spawns[1]);
  for (let i = 0; i < 30; i++) g.step();
  check('a hand-made battle map plays: players stand on its spawn points', a.alive && b.alive && Math.abs(a.pos.x - m.spawns[0].pos.x) < 0.1 && a.grounded && b.grounded);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('map tests failed');
