import type { Palette } from '../sim/map';

// Colour themes. Each generated map rolls one: sky/fog colour, light colours
// and the base colour of every procedural texture.
export const THEMES: Palette[] = [
  { // dusk concrete
    sky: 0xd6c6a0, fogNear: 22, fogFar: 130, sun: 0xfff0d0, ambientSky: 0xe6dcc0, ambientGround: 0x5a5048,
    mats: { concrete: '#9c968a', concreteDark: '#615c56', tile: '#b2573c', metal: '#4c5761', hazard: '#d9a520', ice: '#a9d4e2', conveyor: '#3a3d42', lava: '#ff6a1a' },
  },
  { // cold morning
    sky: 0xa9bcc4, fogNear: 20, fogFar: 120, sun: 0xe8f4ff, ambientSky: 0xc8d8e0, ambientGround: 0x3e4a52,
    mats: { concrete: '#8a9499', concreteDark: '#4d575c', tile: '#3f6f8a', metal: '#5b5348', hazard: '#d9a520', ice: '#c4e6f0', conveyor: '#33383d', lava: '#ff5a2a' },
  },
  { // toxic
    sky: 0xb7c48a, fogNear: 18, fogFar: 110, sun: 0xf4ffd0, ambientSky: 0xd0dca0, ambientGround: 0x444a30,
    mats: { concrete: '#8f927c', concreteDark: '#54573f', tile: '#7a8a3a', metal: '#3f4a44', hazard: '#d95a20', ice: '#b4e0c8', conveyor: '#34382c', lava: '#c8ff2a' },
  },
  { // red night
    sky: 0x5a3038, fogNear: 16, fogFar: 100, sun: 0xffb090, ambientSky: 0xb07068, ambientGround: 0x2a1c22,
    mats: { concrete: '#8a7474', concreteDark: '#4a3a3e', tile: '#a03a3a', metal: '#3a3f4c', hazard: '#d9a520', ice: '#9ab4d0', conveyor: '#2e2a30', lava: '#ff7a1a' },
  },
  { // bone white
    sky: 0xe8e4dc, fogNear: 24, fogFar: 140, sun: 0xffffff, ambientSky: 0xf0ece4, ambientGround: 0x6a665e,
    mats: { concrete: '#b8b2a6', concreteDark: '#6e6a62', tile: '#2e4a5a', metal: '#55504a', hazard: '#e06a1a', ice: '#bcdce8', conveyor: '#403e3a', lava: '#ff4a1a' },
  },
  { // deep violet
    sky: 0x3a3450, fogNear: 16, fogFar: 105, sun: 0xd0c0ff, ambientSky: 0x9088b8, ambientGround: 0x201c30,
    mats: { concrete: '#7c7890', concreteDark: '#403c54', tile: '#5a3a8a', metal: '#38404c', hazard: '#d9c020', ice: '#a0b8e0', conveyor: '#2a2834', lava: '#ff3a8a' },
  },
];
