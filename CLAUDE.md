# SLABRUSH — notes for Claude

An original browser FPS: blocky, low-poly, procedural. Multiplayer is peer-to-peer over WebRTC
(PeerJS); the host runs the authoritative simulation. Deployed to GitHub Pages. The README has the
full game description; this file is for working on the code.

## Commands

- `npm run dev` — dev server on port 5173 (`dev:lan` for other devices on the network).
- `npm test` — all suites: `simtest`, `nettest`, `gentest`, `weapontest`, `parkourtest`, `maptest`, `propstest`, `bottest`, `i18ntest`.
  Each is also runnable alone: `npm run test:sim`, `test:net`, `test:gen`, `test:weapons`, `test:parkour`, `test:maps`, `test:props`, `test:bots`, `test:i18n`.
- `npm run test:bots` — the battle bot suite (`scripts/bottest.ts`). It is part of `npm test`, so it runs there too.
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
- **Session interface.** Five implementations (`OfflineSession` for the practice range, `LabSession` for the map lab,
  `HostSession`, `ClientSession`, `ParkourSession`) share one `Session` interface (`src/net/session.ts`, `hostSession.ts`,
  `clientSession.ts`, `parkourSession.ts`).
  The renderer, audio and HUD see only that interface.
- **Map model.** A map is data (`MapDef` in `src/sim/map.ts`): solids (boxes and ramps, optionally
  movers or `deadly`), triggers, spawns, pickups, and scenery (`decor`, `life`, `screens`, `traffic`,
  `holos`, `props`). Only solids, triggers and spawns affect play. Scenery is drawn, never solid.
- **Generated maps are deterministic.** `generateMap(seed, size)` uses only the seeded RNG
  (`src/core/rng.ts`), never `Math.random`. Every peer builds the same map from the same seed.
- **Map lab files.** Hand-made maps are `MapFile`s (`src/maps/mapFile.ts`). Anything from outside
  (import, submission, storage) goes through `cleanMapFile`, which rebuilds the map field by field.
  Extend it whenever the map format grows, with limits in `LIMITS`.
- **Bots** (battle) are roster seats with `bot` set (`RosterPlayer.bot` is the difficulty). Only the host gives
  them a brain (`GameSim.makeBot`); `src/sim/bot.ts` turns it into an `InputCmd` each tick, so bots move and
  shoot through `pmove` and the weapon code like anyone else. Clients just see players. Bots find their way
  with `src/sim/nav.ts`, a walkable grid worked out from the map's solids and triggers (built once per map).
- **Voice** is a separate WebRTC mesh between each pair of players (`src/audio/voice.ts`); the game
  connection only relays the handshake.

## Where things are

- `src/config/` — tuning values: movement, weapons, game rules, bots and character looks.
- `src/core/` — shared vector maths and the seeded random number generator.
- `src/sim/` — the authoritative simulation: rules, movement, collision, weapons, bots and parkour races.
- `src/maps/` — map generation, themes, parkour courses, the map lab, decorations and the rotation maps in `custom/`.
- `src/net/` — multiplayer: sessions, transports and the public room list.
- `src/render/` — everything drawn with Three.js: the world, characters, weapons, effects and thumbnails.
- `src/audio/` — synthesised sound effects, the megaphone and voice chat.
- `src/client/` — the app: main loop, menus, HUD, input and settings.
- `scripts/` — the test suites and the tools that add maps and deploy the game.

**Not to read or search:** `dist/` (build output), `node_modules/` (dependencies) and large assets
such as images and audio.

## Feature map

- **App shell:** `src/main.ts` (entry point); `src/style.css` (page styles); `src/client/app.ts` (`App`, the main loop); `src/client/input.ts` (`Input`); `src/client/settings.ts` (`Settings`, `DEFAULT_SETTINGS`, `ACTION_LABELS`, `loadSettings`, `saveSettings`, `keyLabel`); `src/client/fullscreen.ts` (`watchFullscreen`, `enterFullscreen`, `toggleFullscreen`, `keyboardLocked`).
- **Core and tuning:** `src/core/vec.ts` (`Vec`, `vadd`, `vsub`, `vscale`, `vnorm`, `vdist`); `src/core/rng.ts` (`Rng`, `hashSeed`); `src/config/movement.ts` (`MOVE`); `src/config/looks.ts` (`FACES`, `TORSOS`, `LEGS`, `randomLook`, `cleanLook`).
- **Simulation core:** `src/sim/pmove.ts` (`pmove`); `src/sim/world.ts` (`World`, `Brush`, `Trace`, `moverFraction`, `touchesDeadly`); `src/sim/types.ts` (`InputCmd`, `Player`, `Pickup`, `Projectile`, `Zone`, `SimEvent`, `BTN`, `emptyCmd`).
- **Weapons:** `src/config/weapons.ts` (`WEAPONS`, `WeaponId`, `WeaponDef`, `TIER_WEIGHT`, `LEGENDARY_CHANCE`, `WEAPON_TIERS`, `LEGENDARIES`, `TRAPS`); `src/sim/game.ts` (`GameSim.fire`, `useBeam`, `useJet`, `useKi`); `src/render/models.ts` (`buildWeaponModel`, `buildProjectileModel`); `src/audio/sfx.ts` (`SoundId`, `SOUND_VOLUME`).
- **Vehicles (SKYSWEEPER, SLABRIDER):** `src/config/game.ts` (`BROOM`, `BIKE`); `src/sim/pmove.ts` (`bikeDrive`); `src/sim/game.ts` (`bikeHits`, `dropBike`, `throwOff`, `killByFall`); `src/net/protocol.ts` (`FLAG_BROOM`, `FLAG_BIKE`, `FLAG_WHEELIE`, `FLAG_TUMBLE`, snapshot fields `bm`, `bk`, `tb`); `src/render/models.ts` (`animateBike`); `src/render/viewmodel.ts`; `src/render/gameRenderer.ts` (`bikeViews`).
- **Netcode:** `src/net/protocol.ts` (`SnapPlayer`, `SnapMe`, `Snapshot`, `FLAG_*`, `validVoiceSignal`); `src/net/session.ts` (`Session`, `SimView`, `InputSource`, `OfflineSession`, `LabSession`); `src/net/hostSession.ts` (`HostSession`, `meBlock`, `sendSnapshots`); `src/net/clientSession.ts` (`ClientSession`, `onSnapshot`, `simulate`); `src/net/transport.ts` (`localHost`, `localJoin`, `memoryPair`); `src/net/peerTransport.ts` (`peerHost`, `peerJoin`); rooms: `src/net/roomDirectory.ts` (`servedLocally`, `RoomDirectory`, `announceRoom`) and `src/net/peerDirectory.ts` (`peerDirectory`, `HIDDEN_HANDOFF`).
- **Match rules:** `src/config/game.ts` (`Rules`, `RULES_PRACTICE`, `RULES_MATCH`, `RULES_PARKOUR`); `src/sim/match.ts` (`MatchState`, `MatchPhase`, `GameMode`, `RosterPlayer`, `newMatchState`); `src/sim/game.ts` (`GameSim.step`).
- **Parkour:** `src/maps/parkour.ts` (`Course`, `COURSES`); `src/sim/race.ts` (`RACE`, `fellOff`, `raceCourse`); `src/net/parkourSession.ts` (`ParkourSession`); `src/maps/parkourPilot.ts` (`pilot`, the test autopilot); `src/client/app.ts` (`chooseCamera`).
- **Map generation:** `src/maps/generator.ts` (`generateMap`, `pickMapSize`, `MAP_SIZES`); `src/maps/themes.ts` (`THEMES`); `src/maps/testMap.ts` (`buildTestMap`); `src/maps/custom/index.ts` (`CUSTOM_MAPS`, the rotation maps).
- **Map editor:** `src/maps/editor.ts` (`MapEditor`, `Tool`, `Item`, `Aim`); `src/maps/mapFile.ts` (`MapFile`, `cleanMapFile`, `LIMITS`, `finishMap`); `src/client/myMaps.ts` (`loadMaps`, `saveMap`, `downloadMap`); `src/sim/map.ts` (`MapDef`).
- **Decorations:** `src/maps/props.ts` (`PROPS`, `PropKind`, `PROP_KINDS`, `variantFor`); `src/render/props.ts` (`buildProps`); `src/render/mapExtras.ts` (adds them to the map's group); `src/maps/editor.ts` (the `prop` tool).
- **Rendering:** `src/render/gameRenderer.ts` (`GameRenderer`); `src/render/mapMesh.ts` (`buildMapMesh`, `buildSolidMesh`); `src/render/models.ts` (`buildCharacter`, `buildWeaponModel`, `buildViewArm`); `src/render/viewmodel.ts` (`ViewModel`, the first-person hands and arms); `src/render/textures.ts` (`makeTexture`, `makeMaterials`, `setAnisotropy`); `src/render/life.ts` (`Life`); `src/render/beams.ts` (`Beams`); `src/render/billboards.ts` (`billboardTexture`, `FRAMES`); `src/render/effects.ts` (`Effects`); `src/render/wounds.ts` (`Wounds`, `buildWounds`, `showWounds`, `WOUND_STAGES`); `src/render/retroPass.ts` (`RetroPass`, `RetroMode`).
- **HUD and menus:** `src/client/hud.ts` (`Hud`); `src/client/menus.ts` (`Menus`, `Screen`, `MenuCallbacks`); `src/client/scoreboard.ts`; `src/render/itemThumbs.ts` (`ItemThumbs`); `src/render/lookThumbs.ts` (`LookThumbs`); `src/render/courseThumbs.ts` (`CourseThumbs`); `src/render/headPortraits.ts` (`HeadPortraits`); `src/client/app.ts` (`handleEvents`, for the kill feed).
- **Voice:** `src/audio/voice.ts` (`VoiceChat`, `micProblem`, `mouthOpenFor`); `src/audio/voiceRules.ts` (`VOICE`); `src/net/protocol.ts` (`VoiceSignal`, `VoiceLink`); `src/client/micTest.ts` (`MicMeter`, `listMics`, `revealMicNames`); `src/audio/megaphone.ts` (`megaphone`, `MEGA`); `src/audio/pitchShifter.ts` (`loadPitchShifter`, `scheduleDeathVoice`).
- **Bots:** `src/sim/bot.ts` (`makeBrain`, `botThink`, `botHurt`, `botCanUse`); `src/sim/nav.ts` (`NavGrid`, `navFor`); `src/config/bots.ts` (`BOT_SKILL`, `BOT_LEVELS`); `src/sim/game.ts` (`GameSim.makeBot`); `src/net/hostSession.ts` (`addBot`, `removeBot`).
- **Tools and tests:** `scripts/addmap.ts` (`readSubmission`, `addToRotation`); `scripts/deploy.mjs`; `scripts/node.d.ts` (Node typings for the scripts); the suites `scripts/simtest.ts`, `nettest.ts`, `gentest.ts`, `weapontest.ts`, `parkourtest.ts`, `maptest.ts`, `propstest.ts` and `bottest.ts`, each using `check(name, ok, info)`.

## Recipes

**Adding a weapon**

1. Add its id to `WeaponId` and an entry to `WEAPONS` in `src/config/weapons.ts`. Give it a `tier` (0 to 2) and
   a `category`. Legendaries, traps and vehicles are placed apart from the tiers, and the HUD name must fit in 9 characters.
2. Add a `case` to `buildWeaponModel` in `src/render/models.ts`. The model needs at least two parts and a numeric
   `userData.muzzle`. A projectile weapon also needs `buildProjectileModel`.
3. Add its id to `SoundId` and synthesise its sound in `src/audio/sfx.ts`. TypeScript fails until both exist.
4. If it fires in a way the existing kinds do not cover, add a branch to `GameSim.fire` in `src/sim/game.ts`.
5. Update the weapon total in `scripts/weapontest.ts` (`const TOTAL`), then run `npm run test:weapons`.

**Adding a map field** (the example is `props`, the decorations)

1. Add the optional field to `MapDef` in `src/sim/map.ts`. Keep it optional so existing maps still load.
2. Teach the file format: read it in `cleanMapFile` in `src/maps/mapFile.ts`, as the `props` block does, add a
   limit to `LIMITS`, and add a refusal check to the suite.
3. Let the editor write it in `src/maps/editor.ts`: place, target and remove, so undo works too.
4. Draw it in `src/render/mapExtras.ts` or `src/render/mapMesh.ts`. If it must affect play, make it a solid or a
   trigger instead, since scenery never blocks movement.
5. Add checks next to the code: `scripts/maptest.ts` for the file, `scripts/propstest.ts` for decorations.

**Adding a snapshot field** (the example is `bk`, the SLABRIDER fuel)

1. Add it to `SnapMe` (this player's own state) or `SnapPlayer` (everyone else) in `src/net/protocol.ts`. Make it
   optional and name its unit in a comment.
2. Write it in `src/net/hostSession.ts`. `meBlock` builds `SnapMe`. Spread it in only when it is set, as `bk` is
   (`...(p.bikeT > 0 ? { bk: p.bikeT } : {})`), so an absent field means zero.
3. Read it in `ClientSession.onSnapshot` in `src/net/clientSession.ts`. If the client predicts it, also set it in the
   predicted state, as `pred.bikeT` is.
4. A yes/no state is a flag bit instead: add a `FLAG_*` after `FLAG_TUMBLE` (131072) in `protocol.ts`, set it on the
   host and read it on the client.

## Tests by area

- `npm run test:sim` — `scripts/simtest.ts`: the simulation, `src/sim/`
- `npm run test:net` — `scripts/nettest.ts`: networking, rooms and voice rules, `src/net/`
- `npm run test:gen` — `scripts/gentest.ts`: the map generator, `src/maps/` (generator.ts, themes.ts)
- `npm run test:weapons` — `scripts/weapontest.ts`: weapons and their models, `src/config/` (weapons.ts), `src/render/` (models.ts)
- `npm run test:parkour` — `scripts/parkourtest.ts`: parkour courses and races, `src/maps/` (parkour.ts), `src/sim/` (race.ts)
- `npm run test:maps` — `scripts/maptest.ts`: the map lab and map files, `src/maps/` (editor.ts, mapFile.ts)
- `npm run test:props` — `scripts/propstest.ts`: decorations, `src/maps/` (props.ts), `src/render/` (props.ts)
- `npm run test:bots` — `scripts/bottest.ts`: battle bots, `src/sim/` (bot.ts, nav.ts)
- `npm run test:i18n` — `scripts/i18ntest.ts`: translations, `src/core/` (i18n.ts, ptBR.ts)

## Conventions

- **Comments explain why**, in plain sentences, and name the constant or function they describe when
  it matters. Keep that style.
- **Tuning values live in `src/config/`**, not inline. Give a new constant a short comment with its unit.
- **Tests are plain scripts** with `check(name, ok, info)`: no framework. Add checks next to the
  code they cover, and update any count the suite asserts (for example, the weapon total in `weapontest.ts`).
- **Windows checkout.** Line endings are CRLF in the working tree (`core.autocrlf` is on). Scripts
  that edit files must keep CRLF (see `scripts/addmap.ts`).
- **Text on screen** is uppercase in the HUD and menus; keys are shown as `[KEY]`.
- **Every line of text the player reads goes through `t()`** (`src/core/i18n.ts`). The key is the English
  text as written in the code; its Brazilian Portuguese is the matching line in `src/core/ptBR.ts`. The game
  opens in Portuguese, so a new line without a Portuguese entry shows in English until one is added.
  `{name}` placeholders must survive the translation. `npm run test:i18n` checks all of this. Text
  built from data (weapon, look and course names) is translated where it is shown, not in the data.

## Standing design decisions

- **Sound:** keep it low-pitched. Sounds are synthesised, not recorded, and no copyrighted clips are used.
- **No trademarked or copyrighted names or art** in the public game. Use original names
  (SKYSWEEPER, SLABRIDER) and original designs.
- **Hands:** a character's hands are the ends of its arms, the same in third and first person. The
  first-person view hides the fists' skin blocks (`HIDDEN` in `src/render/viewmodel.ts`) and shows the arm
  instead, so you see your own arms as others see them.
- **Arms** go with the torso: each torso has its own pair (`ARM_BUILDERS` in `src/render/models.ts`), shown in third and
  first person, and every pair carries a small piece in the player's colour named `'team'`. A new torso needs its arms.
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
