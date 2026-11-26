# SLABRUSH — notes for Claude

An original browser FPS: blocky, low-poly, procedural. Multiplayer is peer-to-peer over WebRTC
(PeerJS); the host runs the authoritative simulation. Deployed to GitHub Pages. The README has the
full game description; this file is for working on the code.

## Commands

- `npm run dev` — dev server on port 5173 (`dev:lan` for other devices on the network).
- `npm test` — all suites: `simtest`, `nettest`, `gentest`, `weapontest`, `parkourtest`, `maptest`, `propstest`.
  Each is also runnable alone: `npm run test:sim`, `test:net`, `test:gen`, `test:weapons`, `test:parkour`, `test:maps`, `test:props`.
- `npm run build` — type check (`tsc --noEmit`) then Vite build.
- `npm run deploy` — tests, build, push `dist/` to the `gh-pages` branch (`--no-test` skips the tests).
- `npm run add-map` — add a submitted map to the rotation.

Always run `npm test` (and `npx tsc --noEmit -p .`) before committing.

## Architecture

- **Host-authoritative.** The host runs the one `GameSim` at 60 Hz (`src/sim/game.ts`). Clients send
  inputs only. The host sends snapshots at 30 Hz (`src/net/protocol.ts`, `hostSession.ts`).
- **Pure movement.** `pmove(state, input, world, tick)` in `src/sim/pmove.ts` has no side effects. Clients
  run it for prediction and replay unacknowledged inputs. **Any new movement feature must live in
  `pmove`** (or be mirrored in the snapshot fields the client needs), or prediction will rubber-band.
- **Snapshot flags and fields.** Per-player state crosses the network as flag bits (`FLAG_*` in
  `protocol.ts`) and optional fields on the snapshot. Host and client sessions must both read and write
  any new field.
- **Events drive effects.** The sim emits `SimEvent`s (`src/sim/types.ts`); `src/client/app.ts`
  (`handleEvents`) turns them into sounds, bursts and the kill feed. The sim never plays sounds.
- **Session interface.** Four implementations (practice range, map lab, host, client) share one
  `Session` interface (`src/net/session.ts`, `hostSession.ts`, `clientSession.ts`, `parkourSession.ts`).
  The renderer, audio and HUD see only that interface.
- **Map model.** A map is data (`MapDef` in `src/sim/map.ts`): solids (boxes and ramps, optionally
  movers or `deadly`), triggers, spawns, pickups, and scenery (`decor`, `life`, `screens`, `traffic`,
  `holos`, `props`). Only solids, triggers and spawns affect play. Scenery is drawn, never solid.
- **Generated maps are deterministic.** `generateMap(seed, size)` uses only the seeded RNG
  (`src/core/rng.ts`), never `Math.random`. Every peer builds the same map from the same seed.
- **Map lab files.** Hand-made maps are `MapFile`s (`src/maps/mapFile.ts`). Anything from outside
  (import, submission, storage) goes through `cleanMapFile`, which rebuilds the map field by field.
  Extend it whenever the map format grows, with limits in `LIMITS`.
- **Voice** is a separate WebRTC mesh between each pair of players (`src/audio/voice.ts`); the game
  connection only relays the handshake.

## Where things are

```
src/config/   tuning: movement.ts, weapons.ts (weapons, TIER_WEIGHT, LEGENDARY_CHANCE), game.ts (BIKE, BROOM, RULES_*)
src/core/     vec.ts, rng.ts
src/sim/      world.ts (collision), pmove.ts (movement and map mechanics), game.ts (rules, weapons,
              pickups, zone, lag compensation), race.ts (parkour races), match.ts, map.ts, types.ts
src/maps/     generator.ts, themes.ts, parkour.ts (courses), parkourPilot.ts (test autopilot),
              editor.ts + mapFile.ts (map lab), props.ts (decoration catalogue), custom/ (rotation maps)
src/net/      protocol.ts, transport.ts, peerTransport.ts, peerDirectory.ts, roomDirectory.ts,
              hostSession.ts, clientSession.ts, parkourSession.ts, session.ts
src/render/   gameRenderer.ts, mapMesh.ts, mapExtras.ts, models.ts (weapons, characters),
              textures.ts, viewmodel.ts (first-person hands), life.ts, props.ts, itemThumbs.ts
src/audio/    sfx.ts (all sounds are synthesised with Web Audio), voice.ts, voiceRules.ts, pitchShifter.ts
src/client/   app.ts (main loop), menus.ts, hud.ts, input.ts, settings.ts, myMaps.ts
scripts/      the test suites, addmap.ts, deploy.mjs
```

## Conventions

- **Comments explain why**, in plain sentences, and name the constant or function they describe when
  it matters. Keep that style.
- **Tuning values live in `src/config/`**, not inline. Give a new constant a short comment with its unit.
- **Tests are plain scripts** with `check(name, ok, info)`: no framework. Add checks next to the
  code they cover, and update any count the suite asserts (for example, the weapon total in `weapontest.ts`).
- **Windows checkout.** Line endings are CRLF in the working tree (`core.autocrlf` is on). Scripts
  that edit files must keep CRLF (see `scripts/addmap.ts`).
- **Text on screen** is uppercase in the HUD and menus; keys are shown as `[KEY]`.

## Standing design decisions

- **Sound:** keep it low-pitched. Sounds are synthesised, not recorded, and no copyrighted clips are used.
- **No trademarked or copyrighted names or art** in the public game. Use original names
  (SKYSWEEPER, SLABRIDER) and original designs.
- **Hands:** the character's hands are the same skin fist blocks everywhere (fists and held
  weapons). Do not change the hand model.
- **Parkour:** falls are deadly. Falling onto deadly ground kills; falls into the void return the player
  to their last checkpoint. Parkour has no rolling-head death camera (`chooseCamera` holds the view).
- **Decorations are scenery.** Map-lab decorations never block movement.
- **Weapon spawns:** no guaranteed weapons. Each spot rolls by tier weight (`TIER_WEIGHT`), and
  legendaries have their own chance (`LEGENDARY_CHANCE`).
- **Vehicles** (SKYSWEEPER, SLABRIDER) are pickups with a fuel or flight charge, not weapons.

## Git and releases

- Commit, merge or push only when asked.
- Work on a `claude/<name>` branch, then commit. Merge into `main` with `--no-ff` when asked.
- "Merge and push" means merge and push, and does not deploy. "Merge, push and deploy" also runs `npm run deploy`.
- Delete a branch only when asked.
- Commit messages end with the `Co-Authored-By` line that the session's instructions give.
- Never commit `weapon-tier-list.png` (an untracked reference image) or any `.env` or credentials file.
