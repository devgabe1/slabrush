# SLABRUSH

An original browser FPS: fast Quake/Source-style movement, disposable pickup weapons, last one standing.
Peer-to-peer multiplayer with room codes — no server of your own to run.
Every match map is generated from a seed. Everything (models, textures, sounds) is made in code. No external assets.

**Status: all 5 phases done.** Core movement and combat, P2P multiplayer with the full round/map/match
structure, the seeded procedural map generator, 35 weapons, and the polish pass. What has and has not
been verified is listed honestly at the end.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev
```

Open http://localhost:5173.

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server with hot reload |
| `npm run build` | type-check + production build into `dist/` |
| `npm run preview` | serve the production build locally |
| `npm test` | all headless tests (simulation + netcode + generator + weapons) |
| `npm run test:sim` / `test:net` / `test:gen` / `test:weapons` | one suite only (`test:weapons` also prints the balance table) |

## Playing with friends

1. Everyone opens the same URL (your deployed site, see below).
2. One player clicks **CREATE ROOM** and shares the 5-letter code.
3. The others click **JOIN WITH CODE**.
4. The host picks the room size (2–6) and clicks **START MATCH**.

Rules: free-for-all, no respawns. The last player alive wins the round. Winning 2 rounds on a map
"takes" it and the game moves to a newly generated map. First to take 6 maps wins the match. If a round
drags on, a sudden-death zone closes in from 50 seconds; standing outside it hurts, and eventually
nowhere is safe.

Things to know:

- **The host is the server.** If the host closes the tab, the match ends for everyone with a message.
  The host can alt-tab; the game keeps simulating in the background.
- Players can only join while the room is in the lobby.
- When the match starts, non-host players must click **PLAY** once (browsers need a click to capture the mouse).
- If someone cannot connect (strict corporate/university NAT), add a TURN server under
  **Settings → TURN SERVER** on *both* that player's and the host's machine, then recreate the room.
  Free public STUN servers are used by default; there is no free public TURN.

### Proximity voice chat

Voice is on by default as **push to talk** (hold `T`; rebindable, and it works in the lobby too). The
browser asks for the microphone when you create or join a room; refuse it and you can still listen.
**Settings → Voice chat** switches to open mic or turns voice off, and **Voice volume** sets other
players' voices.

- **In the lobby and between rounds** everyone hears everyone, clean.
- **During a round** you hear the living from where they stand: full volume within 2.5 m, fading
  to silence at 28 m, panned in 3D.
- **The less health someone has, the thinner their voice.** As health drops the bass is cut away,
  the top closes in and a nasal mid-range bump comes up: a full voice at 100 HP, a tinny radio at
  10. It changes smoothly as they take damage.
- **The dead** can talk among themselves; the living cannot hear them. While you spectate you hear
  the living from the camera's position.
- The lobby roster and the in-game HUD (above your health) show who is talking. In game the HUD
  says **MIC LIVE** while your microphone is going out.

Voice audio travels directly between players over WebRTC (a full mesh, at most five connections
each); only the small handshake messages go through the host. It uses the same STUN/TURN servers as
the game, so a player who needs TURN to join needs it for voice too. The numbers (`near`, `far` and
the health curve) live in `VOICE` in `src/audio/voiceRules.ts`.

### Testing alone

Open two tabs at `http://localhost:5173/?local`. In `?local` mode rooms connect between tabs of the same
browser (no internet, no WebRTC). Add `&lag=80` to simulate 80 ms of one-way latency. A host can also
**START SOLO** to run around a match map alone.

## Character

Main menu → **CHARACTER**. Pick a face, a torso and a pair of legs with the arrows, or hit
**RANDOMIZE**; a walking, turning preview stands next to the panel. On your first visit you are given
a random one. Looks are cosmetic only: every character has the same hit box, and your colour is still
assigned by the room so players stay easy to tell apart.

| Slot | Options |
| --- | --- |
| Face | Cyclops, Googly, Visor, TV Head, Pumpkin, Skull, Traffic Cone, Bucket, Toaster, Frog, Alien, Smiley |
| Torso | Slab, Barrel, Tuxedo, Hazard Vest, Armour, Crate, Backpack, Ribcage, Muscle, Trash Can, Jetpack, Cape |
| Legs | Stubs, Stilts, Boots, Springs, Peg Leg, Robot, Shorts, Treads, Chicken, Wheels, Flippers, Bell Bottoms |

That is 1,728 combinations. Your look is sent to the host when you create or join a room, so set it
before that; everyone in the match sees it. Names live in `src/config/looks.ts`, the models in
`src/render/models.ts` (same order): to add an option, add a name and a builder.

## Settings

Main menu or pause menu → **SETTINGS**. Everything is saved in the browser.

| Setting | Notes |
| --- | --- |
| Mouse sensitivity, field of view, volume | |
| Voice chat, voice volume | push to talk (default), open mic or off; see *Proximity voice chat* |
| Render resolution | internal resolution, 25%–100%; lower is chunkier and faster |
| Retro filter | dithered colour (default), dither + scanlines, or off |
| Crosshair | cross, dot or circle |
| Screen shake | 0 turns it off |
| Fullscreen | toggle |
| Keybinds | click a binding, then press a key or mouse button |
| TURN server | optional, for players behind strict NAT |

## Map lab (generator debug mode)

Main menu → **MAP LAB**. Type a seed (a number, or any word — it is hashed; empty = random) and you are
dropped above the generated map in free-fly.

| Key | Action |
| --- | --- |
| `N` / `B` | next / previous seed |
| `R` | random seed |
| `V` | toggle fly / walk (walk uses the real physics: test every pad, platform and door) |
| `W A S D` + mouse | fly |
| `Space` / `C` | up / down |
| `Shift` | fly fast |

The top-left line shows the seed, archetype, how many attempts validation needed, and counts of
brushes, weapons, pads, portals and movers. Green beacons mark the six spawn points.

## Default controls (all rebindable in Settings)

| Key | Action |
| --- | --- |
| `W A S D` | move |
| `Space` | jump — hold to bunny hop (every hop adds speed); press again next to a wall to wall jump (2 per airtime) |
| `Left Shift` | crouch — while moving fast it becomes a slide; slopes speed it up |
| `C` | slow walk |
| `LMB` | fire / punch (with an empty gun: throw it). Dual wielding: fires the left weapon |
| `RMB` | dual wielding: fires the right weapon |
| `G` | throw the held weapon (damages and slows whoever it hits) |
| `E` | pick up an empty weapon, or swap when both hands are full |
| `1` `2` `Q` wheel | switch weapon |
| `T` | push to talk (proximity voice) |

Crouch is on Shift rather than Ctrl because `Ctrl+W` closes the browser tab.

### How movement works

- **Bunny hopping.** Hold jump. Each time you land and immediately jump again you keep all your
  speed and gain 0.8 m/s, up to 12 m/s (1.5× run speed). No timing needed.
- **Air control.** The movement keys steer you in mid-air. Your trajectory turns towards the key
  you hold at 240° per second without losing speed: A or D swings you sideways, W makes you follow
  the crosshair, W+A goes diagonally. Below run speed the keys also accelerate you, so a standing
  jump can go somewhere. Holding the key opposite to your movement brakes. Steering is switched off
  for 0.7 s after a jump pad so a held key cannot ruin the launch.
- **Air strafing.** Hold a strafe key and turn the mouse the same way while airborne to gain speed
  beyond the hop cap. This is the high-skill layer; nothing requires it.
- **Slide.** Crouch while fast. Slides keep speed, gain it downhill, and chain into hops.
- **Wall jump.** Jump again next to a wall, twice per airtime.

All of it is tuned in `src/config/movement.ts` (`airTurnRate`, `airControlAccel`, `airBrake`, `hopBoost`, `hopSpeedCap`,
`hopWindow`, `airAccel`, `airWishSpeedCap`, and the slide and wall-jump values).

## Weapons

You spawn with your fists. Weapons lie on the map; walk over one to take it (two slots). Every weapon
has a fixed number of uses and no reserve — when it is empty, throw it at someone. All numbers live in
`src/config/weapons.ts`. The practice range has every weapon on a two-row rack behind the spawn.

### Dual wielding

Weapons are one-handed or two-handed (`hands` in the data file). Carry two one-handed weapons and
you hold both at once: the slot-1 weapon in your left hand, fired with the first fire button, and
the slot-2 weapon in your right hand, fired with the second. Each has its own cooldown, recoil and
muzzle flash, so you can fire both together. If either slot holds a two-handed weapon, nothing
changes from before: one weapon in your hands, the other on your back, switch with `Q`.

One-handed (16): ZAPPER, RIVET, PEPPER, MAGNATE, SWAPPER, HORNET, CHATTER, TOASTER, ICEBOX, REELER,
STAPLER, GAMBLER, PINEAPPLE, FISH, POTATO, SHIV, plus the five traps (below). Everything else is two-handed.

While dual wielding, `G` throws the weapon in the selected slot (`1`, `2` or `Q` choose which), and
pulling the trigger on an empty gun throws that one.

### Traps

A class of its own (`category: 'trap'` in the data file): one-handed items you toss a couple of
metres. They stick where they land, arm after about a second, and wait. None of them recognise
their owner, except the sentry. Being one-handed, a trap can sit in one hand with a gun in the other.

| Trap | Uses | What it does |
| --- | --- | --- |
| CLINGER | 2 | proximity mine; sticks to floors, walls, ceilings and moving platforms |
| SNAPPER | 2 | bear trap: 30 damage and the victim cannot walk or jump for 2.5 s (they can still shoot) |
| POPPER | 2 | spring plate: flings the victim about 8 m into the air, unharmed; lethal next to a void |
| SENTRY | 1 | small gun that shoots anyone but its owner within 17 m and in view, for 30 s; kills count for the owner |
| STINKER | 2 | gas canister: opens when someone walks past and fills a 4 m radius for 7 s, 22 damage per second |

Traps disappear after 90 seconds if nothing sets them off, and a toast tells you what you walked into.

| Weapon | Type | Uses | What it is for |
| --- | --- | --- | --- |
| RIVET | pistol | 12 | precise sidearm, 2× headshots |
| PEPPER | burst pistol | 21 | three rounds per pull |
| MAGNATE | revolver | 6 | heavy rounds; a headshot kills |
| CHATTER | SMG | 36 | sprays, runs dry fast |
| HORNET | machine pistol | 60 | furious and inaccurate, close range only |
| LEDGER | rifle | 24 | accurate at any distance |
| SLAB | pump shotgun | 6 | one-shot kill up close |
| TWINS | double barrel | 2 | two huge shots; the recoil throws you backwards (aim down to jump) |
| NEEDLE | sniper | 4 | perfectly accurate, a headshot kills, slow |
| BOUNCER | ricochet rifle | 10 | bounces off walls 3 times, +35% damage per bounce |
| POSTMAN | rocket launcher | 3 | splash and knockback; rocket jumps |
| LOBBER | grenade launcher | 4 | bouncing grenades on a 1.5 s fuse, instant on a direct hit |
| PINEAPPLE | hand grenades | 2 | big blast on a 2.1 s fuse; bounce it round a corner |
| CLINGER | proximity mines | 2 | stick to anything (even moving platforms), arm in 1 s, spare nobody |
| SHIV | knife | 20 | fast; triple damage from behind; 80 damage when thrown |
| SLUGGER | bat | 12 | long reach, sends people flying |
| ZAPPER | arc beam | 70 | no spread or falloff, 13 m range |
| GUST | air cannon | 5 | almost no damage, enormous shove; also propels you |
| SWAPPER | swap gun | 3 | hit someone and you trade places |
| **Heavy hitters** | | | |
| KINGPIN | minigun | 150 | 0.7 s spin-up, then the highest sustained damage in the game |
| VERDICT | railgun | 3 | 100 damage, passes through every player in line |
| BIG ONE | giant rocket | 1 | slow, 11 m blast, 260 damage at the centre; it will kill you too |
| PINATA | cluster launcher | 3 | the grenade bursts into six bouncing bomblets |
| BANHAMMER | giant hammer | 3 | one swing kills; slow |
| **New tricks** | | | |
| TOASTER | flamethrower | 90 | short cone of fire, no aim needed, 8.5 m reach |
| ICEBOX | freeze ray | 30 | light damage; whoever it touches moves at under half speed |
| REELER | harpoon | 5 | yanks the target towards you |
| STAPLER | bolt thrower | 6 | 65-damage bolts that fly in an arc, no splash |
| **Memes** | | | |
| GAMBLER | lucky pistol | 7 | every shot rolls its damage between 1 and 140 |
| FISH | a fish | 30 | 3 damage, huge knockback, leaves the target dazed |
| POTATO | hot potato | 2 | sticks to whoever it hits and explodes after 3 s, unless they touch someone else first, who then has it |

Map placement uses three tiers (`tier` in the data file): every spawn gets a basic *gun* nearby; power
weapons (POSTMAN, LOBBER, NEEDLE, KINGPIN, VERDICT, BIG ONE, PINATA, BANHAMMER) go on jump-pad slabs and in spots far from every spawn; everything
else fills the rest. Which weapons appear is rolled per map from the seed.

Balance at 6 m against a stationary 100 hp target, chest shots (from `npm run test:weapons`):

| | Time to kill | Damage per pickup |
| --- | --- | --- |
| RIVET / PEPPER / CHATTER / HORNET | 0.67 / 0.93 / 0.60 / 0.70 s | 288 / 294 / 396 / 420 |
| LEDGER / MAGNATE / BOUNCER / ZAPPER | 0.58 / 1.07 / 1.00 / 1.07 s | 432 / 276 / 280 / 420 |
| SLAB / TWINS | 0.87 / 0.27 s | 444 / 108 |
| NEEDLE / POSTMAN / LOBBER | 1.30 / 0.15 / 0.22 s | 340 / 345 / 408 |
| SHIV / SLUGGER (at 1.8 m) | 0.57 / 1.20 s | 680 / 540 |
| KINGPIN (incl. spin-up) / VERDICT / BANHAMMER | 1.28 s / instant / instant | 1200 / 300 / 600 |
| BIG ONE / PINATA | 0.42 / 0.30 s | 254 / 536 |
| TOASTER / ICEBOX / STAPLER / GAMBLER | 1.53 / 1.47 / 0.80 / 0.93 s | 393 / 270 / 390 / 396 |

These are first-pass numbers from arithmetic, not from play. They assume perfect aim, so they flatter
the weapons that are hard to aim (NEEDLE, MAGNATE) and understate the easy ones (ZAPPER, shotguns).

### Sound

Positional sounds (other players' shots, steps, explosions) play at full volume within 12 m and are
still at about a quarter of that across a whole map; other players' gunfire is also mixed 1.5× louder
than your own. `HEAR_NEAR` and `HEAR_FALLOFF` in `src/audio/sfx.ts` set how far sound carries.


Every sound is synthesized in `src/audio/sfx.ts`. It has been voiced three times: the first set was
shrill, the second (everything under a 3.8 kHz low-pass) was muffled, and the current one sits in
between, leaning warm. Everything passes through a master low-pass at 6.5 kHz with a mild bass lift.
Guns are built from one `gun(brightness, length, volume, thump pitch)` recipe: a low noise body, a
sub thump, a short knock, and a small quiet snap around 2.6 kHz so they cut through.

Three constants at the top of the file set the overall character: `MASTER_CUTOFF` (6500),
`BRIGHT` (1.4) and `SNAP` (0.22). Raise them for a sharper mix, lower them for a duller one.

## Deploy to GitHub Pages

The build is a fully static site with relative paths (`base: './'`), so it works from any sub-path.
GitHub Pages serves over HTTPS, which WebRTC and pointer lock need.

**Option A — automatic (recommended).** A workflow is included at `.github/workflows/deploy.yml`.

1. Push this project to a GitHub repository (branch `main`).
2. Repository **Settings → Pages → Source: GitHub Actions**.
3. Every push to `main` builds and publishes. The URL appears in the workflow run.

**Option B — manual.** Run `npm run build` and upload the contents of `dist/` to any static host
(Netlify drop, Cloudflare Pages, a `gh-pages` branch).

## Tuning

| File | Contents |
| --- | --- |
| `src/config/movement.ts` | every movement constant: accelerations, friction, gravity, jump, slide, wall jump, air strafing |
| `src/config/weapons.ts` | every weapon: damage, fire rate, ammo, spread, recoil, falloff, projectile and throw stats |
| `src/config/game.ts` | tick rate, player size and hit boxes, `MATCH` (rounds per map, maps to win, delays), `RULES_MATCH` (sudden-death zone), `NET` (snapshot rate, interpolation delay, lag-compensation limit) |
| `src/maps/generator.ts` | grid size, level height, archetypes, how often each mechanic appears |
| `src/maps/themes.ts` | colour themes (sky, fog, lights, texture colours) |

## The map generator

`generateMap(seed)` in `src/maps/generator.ts`. The host picks a seed and sends it; every peer runs the
same code and gets the same map. It uses only the seeded RNG (`src/core/rng.ts`), never `Math.random`.

The map is designed on a 16×16 grid of 3 m cells (a height field plus extras) and then turned into
collision brushes and triggers. The grid is what makes validation possible: "can a player get from A to
B" becomes a graph search over cells.

1. **Archetype** — one of four layouts:
   - **ARENA**: open floor, raised central plaza with ramps.
   - **TERRACES**: the floor is cut into plateaus at four heights, joined by ramps, stairs, jump pads and elevators.
   - **ROOMS**: walled rooms joined by doorways, some with timed doors; rooms can be dark, icy or low-gravity.
   - **ISLANDS**: floating platforms over the void, joined by bridges, ramps, jumpable gaps, moving platforms, jump pads and teleporters.
2. **Decoration** — cover, pillars, void pits, deadly floor, conveyor belts, ice fields, low-gravity
   pockets, dark patches, teleporter pairs, and floating slabs reachable only by jump pad. Obstacles are
   only placed in a clearing with a free ring around them, so they can never cut the map in two.
3. **Spawns** — six points by farthest-point sampling, at least 12 m apart, facing the centre.
4. **Weapons** — every spawn gets a basic gun a few steps away; power weapons go on jump-pad slabs and on
   the cells whose *nearest* spawn is as far as possible (nobody starts next to the rocket launcher);
   the rest are spread evenly.
5. **Validation** — the map is rejected if any of these fail:
   - from the centre, every walkable cell you can reach must also have a way back (no traps);
   - at least 75% of walkable cells are in that connected core, and all spawns and weapons are in it;
   - spawns are at least 12 m apart and there are at least 9 weapons;
   - no spawn, weapon or teleporter exit is inside geometry, and each one has ground under it;
   - every jump pad's arc is flown with a player-sized box through the real collision world and must
     reach its landing spot unobstructed.
6. **Retry** — on failure the map is regenerated with a seed derived from the original
   (`seed + attempt × constant`), so the result is still a pure function of the seed. After 40 failed
   attempts a plain fallback arena is used (never seen in 600 test seeds; the average is 1.05 attempts).

**Landmarks.** Six hand-designed set pieces that the generator drops into any map with room for
them. They are built from ordinary cells, so validation understands them without special cases, and
they are only placed in a flat clearing with a free ring around it, so they never block the way.

| Landmark | What it is |
| --- | --- |
| Spiral tower | a staircase winding three levels up round a solid core; power weapon on top |
| Ziggurat | a raised square with ramps on its sides and a second tier in the middle; power weapon on top |
| Overpass | ramps up to a bridge two levels above the ground that you can run under; weapon on the bridge |
| Bunker | a dark, roofed concrete box with two doorways and a weapon inside |
| Stunt jump | two kicker ramps facing each other across a strip of deadly floor |
| Trampolines | three jump pads that throw you round a triangle for as long as you stay on |

Arenas get 3–4 landmarks, terraces 2–3, rooms 1–2, islands at most the trampolines. Arenas now roll
whether to have their central plaza, so the big landmarks can take the middle. Maps also carry about
twice as much low cover as before. The map lab's top line lists the landmarks on the current map.

Map mechanics, all part of the deterministic simulation (and of client prediction):

| Mechanic | How it works |
| --- | --- |
| Jump pads | set your velocity to a precomputed arc |
| Teleporters | paired; keep your velocity and view; 0.8 s immunity on arrival |
| Moving platforms, elevators, doors | brushes whose position is a pure function of the tick; they carry riders, push anyone in the way, and crush anyone with nowhere to go |
| Low gravity | 35% gravity inside the volume |
| Conveyors | drag whatever stands on them at 4 m/s |
| Ice | very low friction and acceleration |
| Deadly floor / void | touch the glowing floor or fall out of the world and you die |
| Stairs and ramps | ramps are true slopes (slides gain speed on them); stairs are stepped automatically |
| Dark areas | baked dark surfaces, plus fog and dimmed light while you are inside |

## Architecture (and why)

- **Three.js + Vite + TypeScript.** Three.js is a thin WebGL layer without an engine's opinions;
  Vite produces a static bundle; TypeScript keeps the wire formats honest between host and clients.
- **PeerJS for WebRTC.** Its free public broker only does the initial handshake; all game traffic is
  direct browser-to-browser. The room code is the host's peer id, so nothing is stored anywhere.
- **Host-authoritative.** The host runs the one real `GameSim` at a fixed 60 Hz: movement, hits,
  pickups, scoring. Other players send inputs only.
- **Two channels per player.** Reliable + ordered for lobby, round state and game events; unordered
  for inputs and snapshots. Inputs are sent with the last 3 commands repeated to ride out loss.
- **Client-side prediction.** `pmove` is a pure function of (state, input, world, tick). A client runs
  it on its own input at once; when the host's snapshot arrives it rewinds to the acknowledged state
  and replays the unacknowledged inputs — each at the tick the host will run it, which is what makes
  moving platforms predictable. Small corrections are blended out instead of snapping.
- **Interpolation.** Other players, pickups and rockets are drawn 100 ms in the past, between two
  snapshots (30 per second).
- **Lag compensation.** Each input carries the server tick the client was looking at. For hitscan and
  melee the host rewinds everyone else's hit boxes to that tick (max ~330 ms).
- **Client-clocked players.** The host advances each remote player by exactly the inputs that
  player sent: none if nothing has arrived yet (they wait a tick), two or four per tick to work off
  a backlog. It never drops inputs and never invents them, because either makes the host disagree
  with the client's prediction, which the player sees as being teleported.
- **Custom collision, Quake style.** Convex brushes (boxes and ramps), player AABB swept through them.
  Deterministic, cannot tunnel, exact normals for sliding and stepping.
- **Voice is a separate WebRTC mesh.** Game traffic stays host-centred, but routing six voices
  through the host would double their latency and load its uplink, so each pair of players opens
  its own audio connection. The handshake rides on the game connection (`vsig` messages that the
  host relays and stamps with the real sender). Everything about how a voice sounds (position,
  distance, the health filter, dead or alive) is decided by the listener each frame, from the same
  interpolated world it draws; snapshots carry every player's health for that.
- **The app is session-agnostic.** `Session` has four implementations (practice, map lab, host,
  client); the renderer, audio and HUD only see that interface.

```
src/
  config/     movement.ts, weapons.ts, game.ts        <- tuning lives here
  core/       vec.ts, rng.ts
  sim/        world.ts (collision, movers)  pmove.ts (movement + map mechanics)
              game.ts (rules, weapons, pickups, zone, lag comp)  match.ts, map.ts, types.ts
  maps/       generator.ts (seeded maps)  themes.ts  testMap.ts (practice range)
  net/        protocol.ts  transport.ts  peerTransport.ts  hostSession.ts  clientSession.ts  session.ts
  render/     gameRenderer.ts, mapMesh.ts, mapExtras.ts (movers/triggers), textures.ts, models.ts, viewmodel.ts, effects.ts
  audio/      sfx.ts (Web Audio synthesis)  voice.ts (WebRTC proximity voice)  voiceRules.ts (who hears whom, health tone)
  client/     app.ts (main loop), input.ts, hud.ts, menus.ts, settings.ts
scripts/      simtest.ts, nettest.ts, gentest.ts
```

## Done

**Phase 1 — core.** Movement (air strafing, bunny hop, slide, wall jump, crouch, walk, stairs, ramps);
five weapons with pickups, two slots, throwing and no reserve ammo; practice range with dummies;
procedural textures, viewmodel, characters, synthesized positional audio, HUD, settings.

**Phase 2 — multiplayer.** Rooms with codes, lobby, 2–6 players; host-authoritative netcode with
prediction, interpolation and lag compensation; rounds → maps → match with scoreboard and banners;
sudden-death zone; host-left handling; background-tab hosting; TURN setting.

**Phase 3 — maps.**

- Seeded generator with four archetypes and six colour themes, identical on every peer.
- All listed mechanics: jump pads, teleporters, moving platforms, elevators, timed doors, low gravity,
  deadly floor and void, stairs and ramps, conveyors, ice, dark areas, cover and walls.
- Validation with deterministic retry; balanced weapon placement.
- Map lab with seed entry, free-fly, walk mode, seed stepping and spawn beacons.
- Prediction extended to every mechanic (inputs are replayed at the host's tick).

**Phase 4 — weapons.**

- 31 weapons plus fists (19 in the first batch, 12 added after play feedback), all defined in one data file, each with its own code-built model, its own
  synthesized sound, its own recoil and tracer.
- New behaviours in the simulation: bursts, wall ricochets, recoil that moves the shooter, bouncing
  and fused explosives, sticky proximity mines (which ride moving platforms), position swapping,
  backstabs, melee wear, weapons consumed on last use.
- Tiered, seeded weapon placement in generated maps; a full weapon rack in the practice range.
- Balance pass with a generated table.

**Phase 5 — polish.**

- Retro look: optional final pass with ordered dithering to reduced colour depth, vignette and
  scanlines, on top of the low internal resolution and nearest-neighbour textures.
- Gradient sky dome with a sun; baked vertex lighting (per-slab tone, walls darkening towards their
  base, dim undersides); blob shadows under characters.
- Effects: landing and slide dust, conveyor arrows that move at belt speed, per-weapon tracers and
  muzzle flash colours, jump-pad and teleporter bursts.
- Character customization: 12 faces × 12 torsos × 12 legs, with a live preview and a randomize
  button, synced to every player in the match.
- Name tags above every character (hidden by walls, sized to stay readable at distance).
- Combat feedback: damage direction wedges, low-health pulse, "ELIMINATED" toast, hitmarkers, killfeed.
- Spectator camera: once you are out you watch through a surviving player's eyes; fire cycles.
- Victory sequence: at match end every camera circles the celebrating winner over a final scoreboard
  (maps, rounds, kills, deaths). The same scoreboard appears between maps.
- Menus: a freshly generated map orbits behind the menu, new settings, fullscreen toggle.

## How it was verified

- `npm test`, four suites:
  - **Simulation (23 checks):** movement (including air steering, air braking and hop speed gain),
    collision, weapons, determinism.
  - **Netcode (46 checks):** proximity voice (see below); a guest's look reaching the host and the match, and a bogus look from
    the network being replaced; and a regression test for the teleport bug (a client stalls for a third
    of a second while running; the old host logic corrected the player by 1.88 m, the new one by 0); and a real host and client session over an in-memory link — prediction,
    interpolation, lag compensation, zone, the full round → map → match → lobby flow, joins and
    leaves — now running on generated maps.
  - **Generator (25 checks):** all six landmarks appear, and open maps get at least two of them
    in 322 of 325 cases; and each mechanic in a hand-made map through the real simulation (pad,
    teleporter, low gravity, conveyor, deadly floor, platform ride, elevator ride and crush, door
    lift); prediction replay on a moving platform is bit-exact; 600 seeds with no fallback, all four
    archetypes and all nine mechanic families present, spawns ≥ 12 m apart, nothing inside geometry
    across a full mover cycle; 60 seeds regenerate identically; **every jump pad in 250 generated maps
    (358 pads) is flown by the real movement code and lands its player**.
  - **Weapons (77 checks):** all 36 character options building a complete model; and every trap (placing, waiting, triggering, rooting, launching, the
    sentry sparing its owner and crediting kills, the gas cloud's damage and duration); and dual wield (each button fires its own hand, both together, no dual
    wield with a two-handed weapon, an empty hand throwing while the other fires); and every weapon has a model and a unique name; burst count; one-shot
    headshots; TWINS recoil jump; BOUNCER hitting round a corner with the bonus; SWAPPER; GUST shove
    and range; SHIV backstab, wear and throw; SLUGGER knockback; ZAPPER range; LOBBER direct hit vs
    fuse; PINEAPPLE consumption; CLINGER sticking, waiting, triggering, hurting its owner and riding
    a platform; KINGPIN spin-up; VERDICT piercing two players; BIG ONE flight time and blast; PINATA
    bomblet count; BANHAMMER; FISH; ICEBOX slow; REELER pull; GAMBLER damage range; TOASTER reach;
    STAPLER arc and no blast; POTATO sticking, passing by touch and exploding on its new owner;
    every damage weapon can kill with one pickup.
- Proximity voice, in the net suite: the handshake relayed host → client, client → client and
  client → host; malformed signals dropped and senders impossible to fake; other players' health
  reaching clients; the health → tone curve; the hearing rules; distance falloff. In a browser (three
  `?local` tabs with Chromium's fake microphone): the full mesh connecting, audio arriving at the
  other tabs, push to talk lighting the lobby roster, a 12 HP speaker heard through an 860–3300 Hz
  band against 90–7500 Hz at full health, falloff at 15 m and silence at 40 m, the living not hearing
  the dead while the dead hear the living, and the HUD talk indicator.
- In a browser (Phase 5): the menu backdrop, the retro filter and sky in a generated map, and a
  two-tab `?local` match showing the spectator camera, the victory orbit with the celebrating winner,
  and the final scoreboard on both tabs.
- In a browser: all 31 weapons fired in the practice range with no errors; all 51 sounds synthesized
  without errors (both positional and non-positional).
- In a browser: the map lab on all four archetypes (fly and walk); a two-tab `?local` match on a
  generated map with the guest's predicted position matching the host exactly.
- Earlier phases: two tabs through the real PeerJS broker and WebRTC.

## Not verified / known issues

- **Reachability is checked on the cell graph, not by a bot walking the real physics** (except jump
  pads, which are). The graph rules are conservative, but an odd case could exist where the graph says
  "reachable" and a real player finds it awkward. The map lab's walk mode is the tool for spotting
  those; send me the seed.
- **Only tested on one machine.** Real NAT traversal, latency and packet loss are untested, as is 3+ players.
- **Mouse look was never driven by a real mouse in testing** (the embedded test browser refuses pointer lock).
- Other players riding a moving platform can look slightly offset from it on your screen: platforms
  are drawn at your own predicted time, other players 100 ms in the past.
- Timed doors rise from the floor; ride one and you end up on top of the wall. Intended as a trick,
  but it does let you leave a room over the top.
- Map layouts are functional rather than ornate: mostly boxes, ramps and slabs.
- The victory and spectator cameras do not avoid walls; they can clip through geometry.
- The practice range does not include the new mechanics (use the map lab's walk mode).
- **Nobody could listen to the sound set during development.** It is tuned by the numbers and checked
  to run without errors; whether it sounds right is for your ears. The three constants in the Sound
  section move the whole mix brighter or duller.
- **Movement feel was tuned by numbers, not by hand.** Air steering is now strong: `airTurnRate`
  (4.2 rad/s) is the knob if it is too much or too little. Because the keys pull your velocity towards
  the held direction, classic air-strafe speed gain is harder than before; chained hops are now the
  main way to build speed.
- **The teleport fix addresses one confirmed cause** (the host discarding or inventing a player's
  inputs after a hiccup). If you still get moved for no reason, note whether you were the host or a
  guest and what was happening; a SWAPPER hit now says so on screen, and map teleporters are the
  glowing columns.
- A look cannot be changed once you are in a room; leave, change it, and rejoin.
- Character options were checked on the customization screen and on the practice dummies; I did not
  look at all 36 one by one, so an odd-looking part may have slipped through.
- Traps were not play-tested for balance. They stay where they are for up to 90 s, so a small map
  can fill up with them.
- Dual-wielded pairs were not balanced against two-handed weapons. Two MAGNATEs are strong, and so
  is a ZAPPER or TOASTER in each hand.
- Hearing other players was fixed by making positional sound carry much further; I could not listen
  to confirm it across two machines.
- Landmarks were checked in the map lab from above and by the validation rules, not walked by hand.
- **Weapons were not play-tested by a person.** Behaviour is covered by tests; feel and balance are not.
- Weapon-driven movement (TWINS and GUST recoil, rocket jumps, SWAPPER) is applied by the host, so
  on a client it arrives as a correction after your ping instead of instantly.
- The new weapons were not run in a networked match in the browser (the netcode tests cover the
  snapshot path, and explosive projectiles carry their type so clients draw the right model).
- A stuck mine is drawn upright whatever surface it is on. NEEDLE has no scope zoom.
- Your own shots are not predicted (they lag by your ping); rockets, grenades and thrown weapons are not lag
  compensated; no host migration or mid-match join.
- **Voice was never heard by a person, or tried across two machines.** The fake microphone is a
  beep, and the test tabs share one browser. The thinning curve is tuned by the numbers; `VOICE` in
  `src/audio/voiceRules.ts` has the knobs. Voice does not go muffled behind walls, and a guest can
  in principle ignore the hearing rules in their own browser (the host only relays the handshake).
- The free PeerJS broker is a shared public service: if it is down, rooms cannot be created or joined.
- After `Esc`, browsers block re-capturing the mouse for about a second: click PLAY/RESUME again.
- Movement numbers are first-pass. The JS bundle is ~760 kB.

## If you keep going

Ideas that were out of scope or deliberately left, roughly in order of value:

1. Predict your own shots on non-host players (sound, recoil and tracer immediately instead of after
   your ping). This is the largest remaining netcode gap.
2. A play-test balance pass on weapons and movement constants.
3. A physics-walking bot to validate generated maps beyond the cell graph.
4. Scope zoom for NEEDLE; surface-aligned mines; more architectural variety in the generator.
