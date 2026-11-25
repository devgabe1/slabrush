// The few Node.js APIs the map scripts (addmap, maptest) use, so the type check
// passes without adding @types/node to the project. shortcut: hand-written
// signatures; switch to @types/node if scripts start needing much more of Node.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
}
declare module 'node:os' { export function tmpdir(): string; }
declare module 'node:path' { export function join(...parts: string[]): string; }
declare const process: { argv: string[]; exit(code: number): never };
