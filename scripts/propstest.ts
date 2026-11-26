// Decorations in the map lab: `npm run test:props`. What the catalogue holds,
// where they can be put (floors and walls), taking them away, and the map file
// check that every decoration a file brings goes through.
import { MapEditor, type Aim } from '../src/maps/editor';
import { cleanMapFile, LIMITS } from '../src/maps/mapFile';
import { PROPS, PROP_KINDS, propBlocks, variantFor } from '../src/maps/props';
import { playSolids } from '../src/sim/map';
import { World } from '../src/sim/world';
import * as THREE from 'three';
import { buildProps } from '../src/render/props';
import { setLang } from '../src/core/i18n';

// The checks read the English names of decorations; the game opens in Portuguese (see i18ntest.ts).
setLang('en');

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const throws = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const up = { x: 0, y: 1, z: 0 };

// ------------------------------------------------------------ the catalogue
{
  const count = (s: string) => PROP_KINDS.filter((k) => PROPS[k].size === s).length;
  check('decorations come in small, medium and large sizes, a good many of each', count('small') >= 8 && count('medium') >= 6 && count('large') >= 4,
    `${count('small')} small, ${count('medium')} medium, ${count('large')} large`);
  check('some hang on walls and some stand on floors', PROP_KINDS.some((k) => PROPS[k].mount === 'wall') && PROP_KINDS.some((k) => PROPS[k].mount === 'floor'));
  check('the large ones are tall (over 3 m), the small ones are not', PROP_KINDS.filter((k) => PROPS[k].size === 'large').every((k) => PROPS[k].height >= 3) && PROP_KINDS.filter((k) => PROPS[k].size === 'small').every((k) => PROPS[k].height <= 3));
  const picks = new Set<number>();
  for (let i = 0; i < 60; i++) picks.add(variantFor(i * 1.7, 0, i * 0.9));
  check('the pictures vary from place to place, and always one of the four', picks.size >= 3 && [...picks].every((v) => v >= 0 && v <= 3), `${picks.size} different`);
  check('the same place always gives the same picture', variantFor(3, 0, 5) === variantFor(3, 0, 5));
  const names = PROP_KINDS.map((k) => PROPS[k].name);
  check('no two decorations share a name, nor a name with a block shape (the inventory finds things by name)', new Set(names).size === names.length
    && !names.some((n) => ['PLATFORM', 'BIG PLATFORM', 'FLOOR', 'STEPPING STONE', 'CUBE', 'STEP', 'PILLAR', 'COLUMN', 'WALL', 'BEAM', 'RAMP', 'LONG RAMP'].includes(n)));
}

// ------------------------------------------------------------ putting them down
const kindOf = (ed: MapEditor, label: string) => {
  const e = ed.inventory().find((x) => x.label === label);
  if (!e) throw new Error(`no ${label} in the inventory`);
  e.apply();
};
{
  const ed = new MapEditor(MapEditor.blank('battle', 'T')); // a floor, top at y 0, x and z -12..12
  kindOf(ed, 'STATUE');
  check('a decoration is in the inventory, under its size, and can be taken in hand', ed.tool === 'prop' && ed.held.prop === 'statue');
  const floorAim: Aim = { point: { x: 2, y: 0, z: 3 }, normal: up, solid: 0, yaw: 0.4 };
  check('a floor decoration can be placed on a floor', ed.preview(floorAim) !== null && ed.place(floorAim));
  const st = ed.map.props?.[0];
  check('it stands where you aimed, on the floor, facing the way you looked', !!st && st.kind === 'statue' && st.pos.y === 0 && st.pos.x === 2 && st.yaw === 0.4, JSON.stringify(st));
  check('and it is not one of the map\'s blocks (those stay as made; its collision comes from playSolids)', ed.map.solids.length === 1);
  kindOf(ed, 'PAINTING');
  const wallAim: Aim = { point: { x: 12, y: 1.8, z: 4 }, normal: { x: 1, y: 0, z: 0 }, solid: 0, yaw: 0 };
  check('a painting can be hung on the side of a block', ed.place(wallAim));
  const pa = ed.map.props![1];
  check('it hangs out from the wall, facing away from it', pa.kind === 'painting' && Math.abs(pa.pos.x - 12) < 0.05 && Math.abs(pa.yaw - -Math.PI / 2) < 1e-6, `yaw ${pa.yaw.toFixed(3)}`);
  kindOf(ed, 'STATUE');
  check('a floor decoration will not go on a wall', !ed.place({ ...wallAim, point: { x: 12, y: 0, z: 2 } }) && ed.map.props!.length === 2);
  kindOf(ed, 'PAINTING');
  check('a wall decoration will not go on a floor', !ed.place({ point: { x: 1, y: 0, z: 1 }, normal: up, solid: 0, yaw: 0 }) && ed.map.props!.length === 2);
  kindOf(ed, 'STATUE');
  check('nothing to put a decoration on (in the open) is refused', ed.preview({ point: { x: 0, y: 5, z: 0 }, normal: up, solid: -1, yaw: 0 }) === null);
  // taking them away: right click on one
  const before = ed.map.props!.length;
  const t = ed.target({ point: { x: 2, y: 0, z: 3 }, normal: up, solid: 0, yaw: 0 });
  check('aiming at a decoration names it, rather than the block under it', t?.what === 'prop' && t.label === 'STATUE', t?.label);
  check('right click takes it away', ed.remove({ point: { x: 2, y: 0, z: 3 }, normal: up, solid: 0, yaw: 0 }) && ed.map.props!.length === before - 1);
  check('undo brings it back', ed.undo() && ed.map.props!.length === before);
}

// ------------------------------------------------------------ the map file
{
  const ed = new MapEditor(MapEditor.blank('battle', 'T'));
  kindOf(ed, 'PALM TREE');
  ed.place({ point: { x: -3, y: 0, z: -3 }, normal: up, solid: 0, yaw: 0 });
  kindOf(ed, 'OBELISK');
  ed.place({ point: { x: 4, y: 0, z: -4 }, normal: up, solid: 0, yaw: 0 });
  const file = JSON.parse(JSON.stringify(ed.file));
  const back = cleanMapFile(file, false);
  check('decorations survive saving and loading a map file', back.map.props?.length === 2 && back.map.props[0].kind === 'palm' && back.map.props[1].kind === 'obelisk');
  const bad = (edit: (m: { props: unknown[] }) => void) => { const f = JSON.parse(JSON.stringify(ed.file)); f.map.props ??= []; edit(f.map); return throws(() => cleanMapFile(f, false)); };
  check('a decoration of a kind the editor does not make is refused', bad((m) => { (m.props[0] as { kind: string }).kind = 'dragon'; }));
  check('a decoration with a bad picture is refused', bad((m) => { (m.props[0] as { variant: number }).variant = 9; }));
  check('a decoration off the map (a coordinate out of range) is refused', bad((m) => { (m.props[0] as { pos: { x: number } }).pos.x = 1e9; }));
  check('a decoration with no turn is refused', bad((m) => { delete (m.props[0] as { yaw?: number }).yaw; }));
  check('too many decorations is refused', throws(() => {
    const f = JSON.parse(JSON.stringify(ed.file));
    const one = f.map.props[0];
    f.map.props = Array.from({ length: LIMITS.props + 1 }, () => ({ ...one }));
    cleanMapFile(f, false);
  }));
  check('a map with no decorations is still a map', cleanMapFile(JSON.parse(JSON.stringify(MapEditor.blank('battle', 'T'))), false).map.props === undefined);
}

// ------------------------------------------------------------ the shapes build, and are about the size they say
{
  const egypt: Record<string, number> = {};
  const egyptKinds = ['scarab', 'ankh', 'eyeOfHorus', 'stele', 'canopicJars', 'papyrusReeds', 'lotusBowl', 'ushabti', 'offeringTable',
    'pharaoh', 'anubis', 'papyrusColumn', 'lotusColumn', 'chariot', 'sarcophagus', 'sphinx', 'pylon', 'stepPyramid', 'solarBarque', 'colossus'];
  const bad: string[] = [];
  for (const k of PROP_KINDS) {
    if (k === 'painting' || k === 'mural') continue; // (their pictures are painted on a canvas: in the browser only)
    if (egyptKinds.includes(k)) egypt[PROPS[k].size] = (egypt[PROPS[k].size] ?? 0) + 1;
    const g = buildProps([{ kind: k, pos: { x: 0, y: 0, z: 0 }, yaw: 0, variant: 0 }]).group;
    const box = new THREE.Box3().setFromObject(g);
    const sz = box.getSize(new THREE.Vector3());
    const h = PROPS[k].height;
    const tall = sz.y >= h * 0.6 - 0.2 && sz.y <= h * 1.3 + 0.2;
    const sits = PROPS[k].mount === 'wall' || box.min.y > -0.25;
    if (!tall || !sits || !(sz.x > 0.05 || sz.z > 0.05)) bad.push(`${k} (${sz.y.toFixed(2)} tall, catalogue ${h}, bottom ${box.min.y.toFixed(2)})`);
  }
  check('every decoration builds, stands on the floor (or hangs on its wall), and is about the height it says', bad.length === 0, bad.join('; '));
  check('the Egyptian set: 9 small, 6 medium, 5 large', egypt.small === 9 && egypt.medium === 6 && egypt.large === 5, JSON.stringify(egypt));
}

// ------------------------------------------------------------ what blocks movement
{
  const ed = new MapEditor(MapEditor.blank('battle', 'T'));
  kindOf(ed, 'STATUE');
  ed.place({ point: { x: 2, y: 0, z: 3 }, normal: up, solid: 0, yaw: 0 });
  const statue = ed.map.props![0];
  const solids = playSolids(ed.map);
  const extra = solids.slice(ed.map.solids.length);
  check('a floor decoration blocks movement: the simulation gets a box for it', solids.length === ed.map.solids.length + 1 && extra.length === 1 && extra[0].type === 'box',
    `${solids.length} solids`);
  const d = PROPS.statue;
  check('the box is as wide as the decoration and as tall as it is, standing on the floor',
    !!extra[0] && extra[0].min.y === statue.pos.y && extra[0].max.y === statue.pos.y + d.height
    && extra[0].min.x === statue.pos.x - d.half && extra[0].max.z === statue.pos.z + d.half);
  const world = new World(solids, []);
  const hit = world.traceRay({ x: 0, y: 1, z: 3 }, { x: 4, y: 1, z: 3 });
  check('a player walking into the statue is stopped by it', hit.fraction < 1, `fraction ${hit.fraction.toFixed(3)}`);
  const open = new World(ed.map.solids, []).traceRay({ x: 0, y: 1, z: 3 }, { x: 4, y: 1, z: 3 });
  check('without playSolids the same walk is not stopped (the floor is open)', open.fraction === 1);
  check('a decoration on a wall adds nothing: the wall it hangs on is already solid', (() => {
    const e = new MapEditor(MapEditor.blank('battle', 'T'));
    kindOf(e, 'PAINTING');
    e.place({ point: { x: 12, y: 1.8, z: 4 }, normal: { x: 1, y: 0, z: 0 }, solid: 0, yaw: 0 });
    return playSolids(e.map).length === e.map.solids.length;
  })());
  check('a rug, flat enough to walk over, adds nothing', (() => {
    const e = new MapEditor(MapEditor.blank('battle', 'T'));
    kindOf(e, 'RUG');
    e.place({ point: { x: 2, y: 0, z: 3 }, normal: up, solid: 0, yaw: 0 });
    return playSolids(e.map).length === e.map.solids.length;
  })());
  const blank = MapEditor.blank('battle', 'T').map;
  check('a map with no decorations gives back its own solids, unchanged', playSolids(blank) === blank.solids);
  check('every floor decoration in the catalogue is solid, the wall ones are not', PROP_KINDS.every((k) => propBlocks(k) === (PROPS[k].mount === 'floor' && k !== 'rug')));
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('decoration tests failed');
