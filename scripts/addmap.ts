// Add a map made in the map lab to the rotation: `npm run add-map -- <file>`.
// <file> is the map's .json (downloaded from the lab), or a text file holding a
// submission (the issue's text, or just the code from it). The map is checked
// like any file from outside, written to src/maps/custom/<id>.ts and listed in
// src/maps/custom/index.ts: battle maps join the battle rotation, parkour
// maps the list of courses.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanMapFile, decodeMap, type MapFile } from '../src/maps/mapFile';

const DIR = 'src/maps/custom';

/** The map in some text: a JSON file, or a submission's code (alone or inside the issue's text). */
export async function readSubmission(text: string): Promise<MapFile> {
  const t = text.trim();
  if (t.startsWith('{')) return cleanMapFile(JSON.parse(t));
  const fenced = /```slabrush-map\s+([A-Za-z0-9_-]+)\s*```/.exec(t);
  return decodeMap(fenced ? fenced[1] : t);
}

/** Write the map into the custom folder and list it. Throws if a map with its id is there already. */
export function addToRotation(f: MapFile, dir = DIR): string {
  const file = `${dir}/${f.id}.ts`, index = `${dir}/index.ts`;
  if (existsSync(file)) throw new Error(`${file} exists already`);
  const name = 'map_' + f.id.replace(/-/g, '_');
  const before = readFileSync(index, 'utf8');
  const nl = before.includes('\r\n') ? '\r\n' : '\n'; // (a Windows checkout has CRLF line endings: keep them)
  const src = before
    .replace(/\/\/ add-map: imports\r?\n/, `// add-map: imports${nl}import ${name} from './${f.id}';${nl}`)
    .replace(/  \/\/ add-map: sources\r?\n/, `  ${name},${nl}  // add-map: sources${nl}`);
  if (src === before) throw new Error(`${index} has no "// add-map:" markers: cannot list the map`);
  writeFileSync(file, `// ${f.kind} map "${f.name}" by ${f.author}, made in the map lab.${nl}export default ${JSON.stringify(f)};${nl}`);
  writeFileSync(index, src);
  return file;
}

if (process.argv[1]?.endsWith('addmap.ts')) {
  const path = process.argv[2];
  if (!path) { console.error('usage: npm run add-map -- <map .json, or a text file with the submission>'); process.exit(1); }
  try {
    const f = await readSubmission(readFileSync(path, 'utf8'));
    console.log(`added ${f.kind} map ${f.name} by ${f.author}: ${addToRotation(f)}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
