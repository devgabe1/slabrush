import { cleanMapFile, type MapFile } from '../mapFile';

// Maps made in the map lab and accepted into the rotation. Add one with
//   npm run add-map -- <the .json file, or the code from a submission>
// which checks it, writes it next to this file and lists it below.
// Battle maps join the battle rotation, parkour maps the list of courses.
// (Each file is checked again here, as it loads.)
// add-map: imports
const SOURCES: unknown[] = [
  // add-map: sources
];

export const CUSTOM_MAPS: MapFile[] = SOURCES.map((f) => cleanMapFile(f));
