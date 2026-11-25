import { cleanMapFile, encodeMap, type MapFile } from '../maps/mapFile';

// The maps a player has made in the map lab: kept in this browser, downloaded
// as files, imported from them, and submitted for the rotation.

const KEY = 'slabrush-maps';
/** Where a map is submitted: a new issue on the game's repository, the map's code in it. */
const SUBMIT_TO = 'https://github.com/devgabe1/slabrush/issues/new';
const MAX_URL = 7500; // (longer links are cut off by browsers or GitHub: then the file is attached by hand)

/** Saved maps, newest first. Drafts too (a map need not be finished to be saved). */
export function loadMaps(): MapFile[] {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(all) ? all.flatMap((f) => { try { return [cleanMapFile(f, false)]; } catch { return []; } }) : [];
  } catch {
    return [];
  }
}

/** Save (or overwrite) a map. False if the browser would not store it. */
export function saveMap(f: MapFile): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify([f, ...loadMaps().filter((m) => m.id !== f.id)]));
    return true;
  } catch {
    return false; // storage full or blocked
  }
}

export function deleteMap(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(loadMaps().filter((m) => m.id !== id))); } catch { /* nothing to lose */ }
}

const slug = (f: MapFile) => f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';

/** Hand the map to the player as a .json file. */
export function downloadMap(f: MapFile): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(f, null, 1)], { type: 'application/json' }));
  a.download = `${slug(f)}.slabrush-map.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A map file the player picked: checked like anything else from outside. Throws with the reason. */
export async function importMap(file: File): Promise<MapFile> {
  if (file.size > 4_000_000) throw new Error('That file is too big to be a map.');
  let json: unknown;
  try { json = JSON.parse(await file.text()); } catch { throw new Error('That file is not a map (not JSON).'); }
  return cleanMapFile(json, false);
}

/**
 * Submit a finished map for the rotation: opens a new issue on the game's
 * repository with the map's code in it. A map too big for a link is
 * downloaded instead, and the issue asks for the file to be attached.
 * Returns what happened, for the player.
 */
export async function submitMap(f: MapFile): Promise<string> {
  const code = await encodeMap(f);
  const title = `Map: ${f.name} (${f.kind}) by ${f.author}`;
  const intro = `A ${f.kind} map made in the map lab, for the rotation.\n\nTo add it: \`npm run add-map -- <code or file>\``;
  let body = `${intro}\n\n\`\`\`slabrush-map\n${code}\n\`\`\`\n`;
  let url = `${SUBMIT_TO}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  let note = 'A page has opened to send it in: sign in to GitHub and press Submit.';
  if (url.length > MAX_URL) {
    downloadMap(f);
    body = `${intro}\n\n(The map is too big for a link: its file, ${slug(f)}.slabrush-map.json, is attached below.)\n`;
    url = `${SUBMIT_TO}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    note = 'The map was downloaded, and a page has opened to send it in: attach the file there, then press Submit.';
  }
  window.open(url, '_blank', 'noopener');
  return note;
}
