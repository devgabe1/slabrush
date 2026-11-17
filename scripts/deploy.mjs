// Publish the game to GitHub Pages from this computer: `npm run deploy`.
//
// Runs the tests, builds the game, and pushes the contents of dist/ to the
// `gh-pages` branch of the `origin` remote. GitHub's own Pages build then
// publishes that branch as it is (Settings -> Pages -> Deploy from a branch ->
// gh-pages / (root)).
//
// This is the manual alternative to .github/workflows/deploy.yml, for when
// the workflow cannot run (for example while an account's Actions are blocked).
// The gh-pages branch only ever holds the latest build: each deploy replaces it.
//
//   npm run deploy               test, build, publish
//   npm run deploy -- --no-test  skip the tests

import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd });
const read = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

const root = read('git rev-parse --show-toplevel');
const dist = join(root, 'dist');
const remote = read('git remote get-url origin');
const source = read('git rev-parse --short HEAD');
const dirty = read('git status --porcelain') !== '';

if (!process.argv.includes('--no-test')) run('npm test', root);
run('npm run build', root);

// GitHub Pages runs Jekyll on a branch unless told not to; the game needs its files served as they are.
writeFileSync(join(dist, '.nojekyll'), '');

// A throwaway repository inside dist/, holding one commit with the build.
const git = join(dist, '.git');
if (existsSync(git)) rmSync(git, { recursive: true, force: true });
try {
  run('git init -q -b gh-pages', dist);
  run('git -c core.autocrlf=false add -A', dist); // the build is stored exactly as built (no line-ending warnings on Windows)
  const name = read('git config user.name', root), email = read('git config user.email', root);
  const msg = `Build of ${source}${dirty ? ' (plus uncommitted changes)' : ''}`;
  run(`git -c user.name="${name}" -c user.email="${email}" commit -q -m "${msg}"`, dist);
  // Force: the branch is only ever the latest build, never edited by hand.
  run(`git push -f "${remote}" gh-pages`, dist);
} finally {
  rmSync(git, { recursive: true, force: true });
}

console.log(`\nPublished ${source}${dirty ? ' (with uncommitted changes)' : ''} to the gh-pages branch.`);
console.log('GitHub Pages picks it up in a minute or two (Settings -> Pages -> Deploy from a branch -> gh-pages / root).');
