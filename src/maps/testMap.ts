import { WEAPONS, type WeaponId } from '../config/weapons';
import { v3 } from '../core/vec';
import { box, ramp, type MapDef, type Solid } from '../sim/map';

// Hand-built practice range for Phase 1. It exists to exercise every movement
// mechanic; Phase 3 replaces it with the seeded generator (same MapDef output).
const RACK = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => id !== 'fists');
const RACK_ROW = Math.ceil(RACK.length / 2);
// The rows stretch from x -17 to no further than x 21 (the turret pedestal is at x 24), closer together as weapons are added.

export function buildTestMap(): MapDef {
  const s: Solid[] = [];

  // --- floor (with a hole to the void at x 18..26, z -26..-18) ---
  s.push(box(-30, -1, -30, 18, 0, 30, 'concrete'));
  s.push(box(18, -1, -18, 30, 0, 2, 'concrete'));
  s.push(box(18, -1, 2, 30, 0, 30, 'tile')); // shooting gallery
  s.push(box(26, -1, -30, 30, 0, -18, 'concrete'));
  s.push(box(18, -1, -30, 26, 0, -26, 'concrete'));

  // --- perimeter walls ---
  s.push(box(-31, -1, -31, -30, 9, 31, 'concreteDark'));
  s.push(box(30, -1, -31, 31, 9, 31, 'concreteDark'));
  s.push(box(-30, -1, -31, 30, 9, -30, 'concreteDark'));
  s.push(box(-30, -1, 30, 30, 9, 31, 'concreteDark'));

  // --- hill: stairs up, long ramp down (slide test) ---
  s.push(box(-28, 0, -28, -20, 5, -20, 'concrete'));
  s.push(ramp(-28, 0, -20, -20, 5, -4, '-z', 'tile'));
  for (let i = 0; i < 20; i++) {
    s.push(box(-10 - 0.5 * (i + 1), 0, -28, -10 - 0.5 * i, 0.25 * (i + 1), -24, 'concreteDark'));
  }

  // --- wall-jump shaft with a ledge only reachable by wall jumping ---
  s.push(box(8, 0, -30, 9, 9, -18, 'concreteDark'));
  s.push(box(12, 0, -30, 13, 9, -18, 'concreteDark'));
  s.push(box(9, 0, -30, 12, 3.2, -26, 'metal'));

  // --- central monument ---
  s.push(box(-2, 0, -2, 2, 11, 2, 'concreteDark'));
  s.push(box(-6, 11, -6, 6, 12.5, 6, 'concrete'));

  // --- kicker ramp (run at it from +z to launch) and cover blocks ---
  s.push(ramp(2, 0, 12, 6, 1.5, 18, '-z', 'metal'));
  s.push(box(-16, 0, 8, -13, 1.2, 9, 'concrete'));
  s.push(box(10, 0, 2, 11, 2.5, 6, 'concrete'));
  s.push(box(-6, 0, -14, -3, 1.5, -13, 'concrete'));

  // --- crouch tunnel (1.3 m high) ---
  s.push(box(-20, 1.3, 10, -16, 2.2, 16, 'concreteDark'));
  s.push(box(-20, 0, 10, -19.7, 1.3, 16, 'concreteDark'));
  s.push(box(-16.3, 0, 10, -16, 1.3, 16, 'concreteDark'));

  // --- floating platforms and an island in the void pit ---
  s.push(box(19, 1.2, -14, 23, 1.6, -10, 'metal'));
  s.push(box(25, 2.6, -10, 29, 3.0, -6, 'metal'));
  s.push(box(20.5, -0.4, -23.5, 23.5, 0, -20.5, 'hazard'));

  // --- turret pedestal, ice patch ---
  s.push(box(24, 0, 24, 28, 2, 28, 'concreteDark'));
  // The turret's yard: walled off from the rest of the range so it only shoots
  // whoever walks in (through the doorway in the south wall), not everyone
  // trying weapons at the rack.
  s.push(box(20, 0, 22, 20.5, 5, 30, 'concreteDark')); // west wall, between the rack and the turret
  s.push(box(20, 0, 22, 22.5, 5, 22.5, 'concreteDark')); // south wall...
  s.push(box(24.5, 0, 22, 30, 5, 22.5, 'concreteDark')); // ...with a doorway at x 22.5-24.5
  s.push(box(-28, 0, 18, -18, 0.05, 28, 'ice', 'ice'));

  // --- distant monoliths (scenery) ---
  s.push(box(-62, -20, -72, -46, 46, -56, 'concreteDark'));
  s.push(box(50, -20, -82, 70, 62, -62, 'concrete'));
  s.push(box(72, -20, 18, 86, 36, 34, 'concreteDark'));
  s.push(box(-92, -20, 8, -72, 52, 28, 'concrete'));
  s.push(box(-20, -20, 70, 14, 28, 84, 'concreteDark'));

  return {
    name: 'PRACTICE RANGE',
    seed: 1337,
    solids: s,
    triggers: [],
    spawns: [{ pos: v3(-8, 0, 22), yaw: 0 }],
    pickups: [
      // the rack: every weapon in the game (legendaries included), in two rows behind the spawn
      ...RACK.map((weapon, i) => ({ pos: v3(-17 + (i % RACK_ROW) * Math.min(2.2, 38 / RACK_ROW), 0, i < RACK_ROW ? 28.5 : 25.5), weapon })),
      { pos: v3(-8, 0, 16), weapon: 'rivet' as WeaponId }, // straight ahead of the spawn
      // and a few rewards for getting somewhere
      { pos: v3(22, 0, -22), weapon: 'postman' as WeaponId },
      { pos: v3(-24, 5, -24), weapon: 'needle' as WeaponId },
      { pos: v3(10.5, 3.2, -28), weapon: 'twins' as WeaponId },
    ],
    bots: [
      { pos: v3(22, 0, 8), yaw: Math.PI / 2, kind: 'static' },
      { pos: v3(26, 0, 14), yaw: Math.PI / 2, kind: 'static' },
      { pos: v3(21, 0, 20), yaw: Math.PI / 2, kind: 'strafe' },
      { pos: v3(26, 2, 26), yaw: Math.PI / 2, kind: 'turret' },
    ],
    killY: -18,
    palette: {
      sky: 0xd6c6a0,
      fogNear: 25,
      fogFar: 150,
      sun: 0xfff0d0,
      ambientSky: 0xe6dcc0,
      ambientGround: 0x5a5048,
      mats: {
        concrete: '#9c968a',
        concreteDark: '#615c56',
        tile: '#b2573c',
        metal: '#4c5761',
        hazard: '#d9a520',
        ice: '#a9d4e2',
        conveyor: '#3a3d42',
        lava: '#ff6a1a',
      },
    },
  };
}
