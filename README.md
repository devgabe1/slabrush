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
| `npm run dev:lan` | dev server over HTTPS for friends on the same network (see *Playing on your local network*) |
| `npm run build` | type-check + production build into `dist/` |
| `npm run preview` | serve the production build locally |
| `npm test` | all headless tests (simulation + netcode + generator + weapons) |
| `npm run test:sim` / `test:net` / `test:gen` / `test:weapons` | one suite only (`test:weapons` also prints the balance table) |

## Playing with friends

1. Everyone opens the same URL (your deployed site, see below).
2. One player clicks **CREATE ROOM**, chooses **PUBLIC** (listed under JOIN ROOM) or **PRIVATE**
   (only with the code), and shares the 5-letter code. The choice is remembered for next time, and the
   host can switch it in the lobby (Visibility) at any time; switching to private takes the room off
   the list within a couple of seconds.
3. The others click **JOIN ROOM** and either click the room under **PUBLIC ROOMS** or type the code
   (private rooms are only reachable with the code).
4. The host picks the room size (2–6) and clicks **START MATCH**.

Rules: free-for-all, no respawns. Everyone has **150 health**; stand still (no movement keys, not
moving) for 3 seconds and it slowly comes back, 5 HP a second, up to full. Moving or getting hurt
stops it and restarts the 3-second wait. The last player alive wins the round. Winning 2 rounds on a map
"takes" it and the game moves to a newly generated map. First to take 6 maps wins the match. If a round
drags on, a sudden-death zone closes in from 50 seconds; standing outside it hurts, and eventually
nowhere is safe. When you die, your head is knocked clean off, away from whoever
killed you, and for a few seconds the camera IS your head: it flies off tumbling with a hard
shake, bounces off walls and floors (each bounce a thud and a smaller shake) and rolls to a stop,
while ELIMINATED slams onto the screen. Everyone else sees your head fly off in one piece.
The body's pieces stay on the ground where they land until the round ends (the practice range
keeps only the newest 14 bodies). Then
you watch the round through a surviving
player's eyes (fire to switch player): you see their hands and weapons, with their shots and
swings, and their health in the corner.

Things to know:

- **The host is the server.** If the host closes the tab, the match ends for everyone with a message.
  The host can alt-tab; the game keeps simulating in the background.
- **Joining a match in progress** works like joining a lobby (the code, or the room in the list,
  marked *in progress · join*). You arrive spectating — *"you play from the next round"* — and play
  from the next round. If the map has fewer spawns than there are players, the latest arrival watches
  until the next map, which is sized for everyone.
- **Reconnecting.** Each player gets a secret seat token when they join. If your connection drops
  mid-match, the game says *CONNECTION LOST — RECONNECTING* and tries to get back in for about half a
  minute; the host holds your seat (name, colour, score) for 60 s, marked *away* in the lobby and on
  the Tab scoreboard. You miss the rest of the round you dropped out of and play from the next. Closed
  the tab or reloaded the page? The main menu offers **REJOIN** (for 10 minutes) and puts you back in
  your seat. If the drop was so brief the host never noticed, you simply carry on playing. If the host
  closed the room, it says so and nobody waits in vain. Leaving through the menu gives your seat up.
- When the match starts, non-host players must click **PLAY** once (browsers need a click to capture the mouse).
- **The host can pause the match:** `Esc` → **PAUSE MATCH**. Everything stops for everyone (players,
  rockets, round timers, the zone; you can still look around) and a **PAUSED** banner says who paused
  it. **RESUME MATCH** in the same menu carries on exactly where it stopped. Inputs sent while paused
  are dropped, so nobody lurches forward on resume. Voice chat keeps working.
- If someone cannot connect (strict corporate/university NAT), add a TURN server under
  **Settings → TURN SERVER** on *both* that player's and the host's machine, then recreate the room.
  Free public STUN servers are used by default; there is no free public TURN.

### Proximity voice chat

Voice is on by default as an **open mic**. The browser asks for the microphone when you create or
join a room; refuse it and you can still listen. **Settings → Voice chat** switches to push to talk
(hold `T`; rebindable, and it works in the lobby too) or turns voice off, and **Voice volume** sets
other players' voices. Use headphones with an open mic: echo cancellation is on, but speakers still
leak.

- **In the lobby and between rounds** everyone hears everyone, clean.
- **During a round** you hear the living from where they stand: full volume within 2.5 m, fading
  to silence at 28 m, panned in 3D.
- **The less health someone has, the higher their voice.** As health drops the pitch rises,
  gliding as damage comes in: about +7 semitones at 50 HP, +11 at 10 HP and a full octave at 0, the
  helium voice, very high but still easy to understand. A gentle low cut thins it a little more.
  Your own game applies this to your microphone before sending it, from your real health, so every
  listener hears the same voice. In the lobby, between rounds and as a ghost you sound like yourself.
- **Scoreboard.** Hold `Tab` in a match to see every player with their head turning beside
  them (its mouth moves when they talk), their maps taken, round pips for the current map, rounds
  won, kills and deaths. Kills and deaths count live during the round; eliminated players are
  marked OUT with a grey head. In the practice range it shows you and the dummies.
- **Talking heads.** Everyone's mouth moves with their real voice, puppet style: the whole head
  flips up from a hinge at the back, showing a red mouth with a tongue and teeth, and snaps shut
  between syllables, so you can see who is talking even across the map. It follows the loudness of
  the voice you would hear (a voice you cannot hear does not move a mouth), and works on every face.
  On the Character screen your character mouths along with your microphone if it is already
  allowed, and says a quick hello whenever you change part. `MOUTH_OPEN` in `src/render/models.ts`
  sets how wide it opens; `MOUTH_QUIET`/`MOUTH_LOUD` in `src/audio/voice.ts` set how loud you must be.
- **Last words.** When someone dies, their voice keeps going for 4 seconds from where they fell,
  but like a tape winding down: it starts at normal speed, so the first words are clear, then gets
  slower and deeper faster and faster, ending at quarter speed, two octaves down. Everyone nearby hears it. Then it fades out, and after a short silence they are a ghost.
- **The dead** can talk among themselves; the living cannot hear them. While you spectate you hear
  the living from the camera's position.
- The lobby roster and the in-game HUD (above your health) show who is talking. In game the HUD
  says **MIC LIVE** while your microphone is going out.

Microphones only work on a secure page: the deployed HTTPS site, or `http://localhost`. Opening the
dev server from another machine as `http://192.168.x.x:5173` gives listening only, and the lobby says
so; use `npm run dev:lan` for that (next section). The lobby line names the exact problem: permission denied, no microphone found, microphone in
use by another app, or a non-secure page. A microphone plugged in later is picked up without rejoining.

Voice audio travels directly between players over WebRTC (a full mesh, at most five connections
each); only the small handshake messages go through the host. It uses the same STUN/TURN servers as
the game, so a player who needs TURN to join needs it for voice too. The numbers (`near`, `far` and
the pitch curve: `maxSemitones`, `curve`, `lowCut`; the death voice: `death`) live in `VOICE` in `src/audio/voiceRules.ts`;
the pitch shifter itself is `src/audio/pitchShifter.ts`.

### Playing on your local network

To host from your own machine for friends on the same Wi-Fi, without deploying:

1. Run `npm run dev:lan`. It prints a `Network:` address such as `https://192.168.1.20:5173/`.
2. Everyone (you included) opens that address. The certificate is self-signed, so the browser
   warns once: click **Advanced → Proceed** (Chrome/Edge) or **Accept the risk** (Firefox).
3. Create and join rooms as usual. Voice works because the page is HTTPS.
4. No codes needed: **JOIN ROOM** lists every public room hosted on this network (host name, players,
   open / full / in progress); click one to join (in progress too: you play from the next round). The list is kept by the dev server everyone
   loaded the game from (`npm run dev`, `dev:lan` or `preview`). Only rooms whose host still has
   the game open are listed: closing it, leaving the room or going private takes the room off at
   once (the list refreshes every second), and a host that vanishes without a word (a crash, a killed
   browser) drops off within 4 s, since hosts announce their room every 1.25 s. A delayed
   announcement can never put a closed room back. Private rooms are never announced, so they never
   appear; the code still works for them. See `src/net/roomDirectory.ts`.

If friends cannot load the page, your firewall is blocking port 5173: allow Node.js on private
networks when Windows asks, or allow the port. Rooms still use the free PeerJS broker for the
handshake, so the machines need internet access too. Deploying to GitHub Pages (below) avoids the
certificate warning and works for friends anywhere.

### Testing alone

Open two tabs at `http://localhost:5173/?local`. In `?local` mode rooms connect between tabs of the same
browser (no internet, no WebRTC). Add `&lag=80` to simulate 80 ms of one-way latency. A host can also
**START SOLO** to run around a match map alone.

## Character

Main menu → **CHARACTER**. Choose a body part with the **FACE / TORSO / LEGS** tabs and every
option for it appears as a picture, worn by your character as it is now; click one to wear it (or
hit **RANDOMIZE**). A walking, turning preview stands next to the panel and changes as you pick.
The pictures are rendered in the browser from the same models (`src/render/lookThumbs.ts`). On your first visit you are given
a random one. Looks are cosmetic only: every character has the same hit box, and your colour is still
assigned by the room so players stay easy to tell apart.

| Slot | Options |
| --- | --- |
| Face | Cyclops, Googly, Visor, Tv Head, Pumpkin, Skull, Traffic Cone, Bucket, Toaster, Frog, Alien, Smiley, Blockhead, Scrapbot, Cat Hood, Astronaut, Disco Ball, Moai, Steve, Creeper, Enderman, Alex, Finn Hat, Mordecai, Rigby, Gumball, Lincoln, Rick, Bender, Corvo, Vault Boy, Hextech, Vivi |
| Torso | Slab, Barrel, Tuxedo, Hazard Vest, Armour, Crate, Backpack, Ribcage, Muscle, Trash Can, Jetpack, Cape, Hoodie, Spacesuit, Scrap Chassis, Pixel Tee, Steve Shirt, Creeper Hide, Diamond Chest, Ender Cloak, Finn Shirt, Mordecai Feather, Gumball Sweater, Lincoln Stripes, Vault Suit, Hextech Armour, Bender Plate, Corvo Coat |
| Legs | Stubs, Stilts, Boots, Springs, Peg Leg, Robot, Shorts, Treads, Chicken, Wheels, Flippers, Bell Bottoms, Pixel Pants, Moon Boots, Roller Skates, Hover, Steve Jeans, Diamond Legs, Creeper Feet, Ender Stilts, Finn Jeans, Mordecai Talons, Gumball Jeans, Lincoln Chucks, Vault Boots, Hextech Greaves, Bender Rollers, Corvo Boots, Vivi Boots |

That is 26,796 combinations. When a list is longer than the panel, the options scroll while the
tabs and buttons stay put.

**Wear and tear.** Every character shows how hurt it is: as health falls, seven wounds open one
by one: a bloody scuff on the chest (below 85% of full health), an arm opened to the bone (70%), a
bare shin bone (57%), ribs through the chest (45%), the skull and teeth through the cheek (33%), the
other arm (22%) and the other shin (12%). Wounds close again as health regenerates, and a new round
heals everyone. The wounds are stuck to whatever outfit you wear:
when a character is built, a ray is cast at each body part and the wound sits on the surface it
hits, so it fits every face, torso and pair of legs. Thresholds are `WOUND_STAGES` in
`src/render/wounds.ts`.

## Settings

Main menu or pause menu → **SETTINGS**. Everything is saved in the browser.

| Setting | Notes |
| --- | --- |
| Mouse sensitivity, field of view, volume | |
| Voice chat, voice volume | open mic (default), push to talk or off; see *Proximity voice chat* |
| Microphone | which input device voice uses (system default unless you pick one), with a live level meter; switches instantly, even mid-match. If the chosen one is unplugged the default is used until it is back |
| Loopback | under the microphone: **LOOPBACK** plays your microphone back to you, voiced exactly as other players hear you; pick a health level (full, half, a quarter, a tenth, or 1 HP) to hear your low-health voice, and **DEATH VOICE** plays the next 4 seconds of your voice as your last words. Use headphones. It switches off when you leave Settings |
| Render resolution | internal resolution, 25%–100%; lower is chunkier and faster |
| Retro filter | dithered colour (default), dither + scanlines, or off |
| Crosshair | cross, dot or circle |
| Screen shake | 0 turns it off |
| Fullscreen | toggle, or **Fullscreen when playing** to go fullscreen on PLAY/START; in Chrome/Edge it also captures `Ctrl+W` & co. |
| Keybinds | click a binding, then press a key or mouse button |
| TURN server | optional, for players behind strict NAT |

## Parkour

Obstacle courses in the sky, against the clock: alone from the main menu, or as a race in a room.

**Solo.** Main menu → **PARKOUR**, pick a course. The clock starts when you leave the start platform
and stops on the finish. Fall and you are back on the last checkpoint you reached, with the clock
still running (before the first checkpoint, back on the start with the clock reset). `R` (rebindable
as *Parkour: restart the run*) starts over at any time; the pause menu has **RESTART RUN** and
**COURSES** too. At each checkpoint you get your split, green when it is ahead of your best run's and
red when it is behind. Best times and their splits are kept in this browser (localStorage).

**Online.** In the lobby the host sets **Mode** to *Parkour: race the courses* and picks a **Course**,
or *All 3, one after the other*. Everyone lines up on the start; after the countdown the clock runs
for everybody at once. Each runner has their own checkpoints (the host keeps them): fall, or get
punched out, and you are back on yours. Once the first runner finishes, the course closes for the
rest 60 seconds later (and after 10 minutes at most). Points by place on each course: 10, 7, 5, 4, 3, 2;
not finishing scores nothing. The standings down the right show where everyone is (checkpoint or
finishing time) and their points; between courses the results come up; after the last one the most
points wins and everyone goes back to the lobby. A finish online counts as a best time too. The
rules are in `RACE` (`src/sim/race.ts`); the host runs the race in `src/net/hostSession.ts`.

Three big courses, each with its own look. They wind: left and right turns at corner checkpoints,
climbs (steps, chimneys, pads, lifts, spirals) and drops (leaps off ledges, cascades of ledges), with a
checkpoint after every section (28 to 30 each, over a kilometre of route).

| Course | | Look | Route |
| --- | --- | --- | --- |
| **BLOCKLANDS** | easy (harder in the underrealm, harder still in the starreach), 53 checkpoints | a blocky voxel world: floating grass islands on stepped earth over a lava sea, blocky trees; terraced mountains rising from the lava all round (grass low down, bare rock above, snow on the peaks, and volcanoes with a crater of lava and a stream of it running down); waterfalls pouring off the islands into the void, flocks of birds circling, butterflies round the trees, blocky animals wandering the islands, clouds drifting by | stones, a mine tunnel, a climb, a slalom, a leap into a valley, stones over lava, fences, a spiral up a giant tree (a bark trunk on its own island, every leafy step on a branch, a broad crown on top), bounce pads, down the cliffs, floating logs, a raft and a lift, a booster leap, up again, another leap, more fences and floating logs, fence posts, then through a gate of dark stone with a curtain of fire in it into the underrealm (a vast crimson cavern over a sea of lava, in a red haze: basalt pillars to the roof, falls of lava, embers floating up, ash drifting), where it gets harder: hops over lava, three basalt walls to run, stones sinking into the lava, narrow beams and a booster, a chimney, floating slabs, a long slalom, sliding blocks and posts; then through a gate of starlight into the starreach (islands of pale moonstone adrift in a dark void full of stars, crystals glowing on them, shards of light drifting by), harder still: crystal posts over the void, four walls to run in a row, stones that drop away into the void, pads and a wall run, floating slabs, an eight-stone slalom, beams and a booster, sliding blocks, more posts, and the dragon's island: a ring of standing stones round the finish, a great silver-blue dragon with glowing eyes and crystal spines circling over it |
| **DUNE TEMPLE** | medium, 35 | sandstone temple ruins floating over the desert at golden hour: a giant jackal-headed guardian statue with gold eyes and collar, holding a staff with a fire on top, pyramids, dunes, palms; braziers burning beside the checkpoints on little floating plinths, vultures wheeling overhead, sand pouring off broken columns, gusts of sand blowing below, camel caravans plodding across the desert; and out in the desert, aliens building a giant pyramid: saucers lift blocks off a stockpile in tractor beams and lower them into place, tier by tier, while a mothership looks on and little green aliens walk the site; when the last block is in, the gold capstone glows in the mothership's beam, then the top tiers are beamed away and the work starts again (every 2½ minutes); and at the end, a great stepped pyramid (Giza-sized) rising from the sand, its gold-banded gateway flanked by fires | broken columns, a wall run along the temple, fallen columns, two long corridors to climb with wall jumps on the move, a leap off the roof, sliding stone blocks, a spiral round the guardian statue, a booster leap, a slalom, bounce pads, sliding slabs, terraces down, two wall runs, a stone raft and a lift, pads and the great wall, another leap, column tops, then in through the pyramid's gateway: a dim, torch-lit tomb of traps (pits of spikes, stone slabs slamming down from the ceiling, narrow beams over spikes, bronze blades shooting out of the walls), round two corners into the treasure room: stones up over the spikes to a dais heaped with gold, chests and urns round a sarcophagus, a mummy shambling to and fro in front of it, and the finish |
| **NEON SPRAWL** | hard, 30 | a neon megacity at night: stepped glass skyscrapers with lit windows, neon outlining every tower, roof and ledge, animated digital billboards facing the course (and on every wall you run along), tall glyph signs, antenna spires with red lights, elevated highways full of moving traffic, flying traffic lanes, giant holograms turning in the sky, a purple haze; floors of dark glossy panels with glowing seams (cyan on the course, magenta on checkpoints) | girders, a slick roof and an anti-gravity field, billboard wall runs, a portal to a spire and a dive, security shutters, a skybridge drop, a billboard alley, hover pads, a hover-platform and a lift, ledges, a vent duct, fire escapes, barriers, a spiral round a tower, two long light wells to climb with wall jumps, a second spire, rooftop vents |

The themes are original takes on familiar styles (a blocky sandbox look, a neon cyberpunk city, ancient
desert ruins) built from this game's own procedural textures: new materials for them (grass, dirt,
stone, planks, leaves, sand, sandstone, lit tower glass and the city's neon-seamed floor panels) are in `src/render/textures.ts`, and glowing
scenery (neon, clouds, flowers) is `decor` on the map, drawn unlit and not solid. The city also has
`screens` (digital billboards: every ad is drawn in code from invented shapes and glyphs, `src/render/billboards.ts`,
and flips to its next slide every few seconds with a glitch), `traffic` (streams of moving lights) and `holos` (holograms). Every theme can add `life` (`src/render/life.ts`): flocks,
swarms, falls of water, lava or sand, flames, walking animals, drifting clouds and blowing sand, all animated from the
clock and never solid. A fall is counted
12 m under your checkpoint (or below the course), so climbing high never means a long fall.

Everything uses the normal movement: bunny hops, crouch slides, wall runs, wall jumps, pads, moving
platforms, ice, conveyors, low gravity and teleporters. The only new piece is the **booster** (cyan
arrows on a platform): it raises your speed its way to what it shows.

The courses are in `src/maps/parkour.ts`, solo runs in `src/net/parkourSession.ts`.
`npm run test:parkour` checks the clock and checkpoints, and an autopilot (`src/maps/parkourPilot.ts`)
runs every course along its route from start to finish without a fall: BLOCKLANDS in 2:56, DUNE
TEMPLE in 2:37, NEON SPRAWL in 3:13 (it only bunny hops where it needs speed, so human times should
beat those). The courses are built section by section (`Builder` in `src/maps/parkour.ts`): each
section is one obstacle, written along its own leg of the course, and `turn()` starts a new leg to
the left or right, so a new course is a list of sections, turns and a theme. Building a course checks
that it never runs into itself, and scenery is kept clear of the route. `npm run test:net` runs a whole online race between a host and a guest:
checkpoints, falls, finishes, points, a course that times out, and the final standings.

## Map lab (generator debug mode)

Main menu → **MAP LAB**. Type a seed (a number, or any word — it is hashed; empty = random), choose how
many **players** to pretend are in the room (2-6, default 4), and you are dropped above the generated
map in free-fly. The map size is picked exactly as a match with that many players would pick it, so
the same seed can give a TINY map for two players and a LARGE one for six.

| Key | Action |
| --- | --- |
| `N` / `B` | next / previous seed |
| `R` | random seed |
| `V` | toggle fly / walk (walk uses the real physics: test every pad, platform and door) |
| `P` | players 2 → 3 → … → 6 → 2: same seed, rebuilt for that room size |
| `W A S D` + mouse | fly |
| `Space` / `C` | up / down |
| `Shift` (the crouch / slide key) | fly fast |

The top-left line shows the seed, the player count and the size it picked (with the number of spawns),
the archetype, how many attempts validation needed, and counts of brushes, weapons, pads, portals and
movers. Green beacons mark the spawn points.

## Default controls (all rebindable in Settings)

| Key | Action |
| --- | --- |
| `W A S D` | move |
| `Space` | jump — hold to bunny hop (every hop adds speed); press again next to a wall to wall jump (2 per airtime) |
| `Left Shift` | crouch — while moving fast it becomes a slide; slopes speed it up |
| `Left Ctrl` | crouch only: stays a crouch even at full speed, never slides (unbound by default in Firefox/Safari) |
| `C` | slow walk |
| `LMB` | fire / punch (with an empty gun: throw it). Dual wielding: fires the left weapon |
| `RMB` | aim down the sights (the NEEDLE looks through its scope); while dual wielding it fires the right weapon instead |
| `G` | throw the held weapon (damages and slows whoever it hits) |
| `E` | pick up an empty weapon, or swap when both hands are full |
| `1` `2` `Q` wheel | switch weapon |
| `T` | push to talk (proximity voice; only when Settings → Voice chat is set to push to talk) |
| `Tab` (hold) | scoreboard: every player's head turning beside their maps, rounds, kills and deaths |

Ctrl is its own key, a plain crouch that never slides; Shift is still crouch / slide. In Chrome,
Edge and Opera, Ctrl is bound by default together with **Settings → Fullscreen when playing** (on
by default there): in fullscreen those browsers let the game capture browser shortcuts (`Ctrl+W`,
`Ctrl+T`, `Ctrl+N`…) through the Keyboard Lock API, so holding Ctrl while pressing W never closes
the tab. Esc is left alone: it still opens the menu and leaves fullscreen. Firefox and Safari
cannot capture those shortcuts, so there the crouch-only key starts unbound (bind it in Settings if
you want it). As a last safety net, closing the tab asks "Leave site?" first while you are in an
online room, or playing anything with a crouch key on Ctrl (`src/client/fullscreen.ts`).

### How movement works

- **Bunny hopping.** Hold jump. Each time you land and immediately jump again you keep all your
  speed and gain 0.8 m/s, up to 12 m/s (1.5× run speed). No timing needed.
- **Air control.** The movement keys steer you in mid-air. Your trajectory turns towards the key
  you hold at 240° per second without losing speed: A or D swings you sideways, W makes you follow
  the crosshair, W+A goes diagonally. Below run speed the keys also accelerate you, so a standing
  jump can go somewhere. Holding the key opposite to your movement brakes. You can steer straight
  away after a jump pad, which is how you reach somewhere from a standing start.
- **Air strafing.** Hold a strafe key and turn the mouse the same way while airborne to gain speed
  beyond the hop cap. This is the high-skill layer; nothing requires it.
- **Slide.** Crouch while fast. Slides keep speed, gain it downhill, and chain into hops.
- **Wall jump.** Jump again next to a wall, twice per airtime.
- **Wall run.** Meet a wall in the air while moving along it at 5 m/s or more and you run along it,
  no key needed: a little lift (a jump into the wall is capped at 3 m/s upwards, so it runs along the
  wall rather than climbing it), then gravity comes back bit by bit, so you trace a gentle arc for up
  to 1.2 s, keeping all your speed along the wall. It ends when the time is up, you slow down, the wall
  ends, you push away from it, or you land; a wall jump throws you off it (that works as ever). Two
  runs per airtime, refilled on landing. Other players see you running on the wall, legs going, body
  tilted away from it with the near hand trailing along it, dust off your feet and a scrape; in first
  person the view tilts away from the wall and, with fists, the near fist goes out flat against it.
  Wall jump out whenever you like; let go of the key, or push away, to drop. It ends when you land.
  A wall run keeps every bit of your speed, whatever angle you met the wall at, and glancing off any
  wall in mid-air only turns you along it (`wallGlance`); only hitting a wall nearly head-on slows you.
- **Climbing a shaft.** Between two walls close together (`shaftWidth`, 3 m) a jump never becomes a wall run:
  it climbs. Each wall jump carries you across to the other wall (the keys do not steer for `wallJumpCarry`,
  0.25 s), so jump, wall jump, wall jump climbs about 3.4 m while you keep running at full speed.

All of it is tuned in `src/config/movement.ts` (`airTurnRate`, `airControlAccel`, `airBrake`, `hopBoost`, `hopSpeedCap`,
`hopWindow`, `airAccel`, `airWishSpeedCap`, and the slide and wall-jump values).

## Weapons

You spawn with your fists. Weapons lie on the map; walk over one to take it (two slots). Every weapon
has a fixed number of uses and no reserve — when it is empty, throw it at someone. All numbers live in
`src/config/weapons.ts`. The practice range has every weapon on a two-row rack behind the spawn.

### Aiming

Hold right click to aim the weapon in your hands, one- or two-handed: the view zooms in a little,
the gun comes up to the middle of the screen, and your shots spread about a third as much (the host
decides the spread, so it is fair). Fists, blades, grenades and traps do not aim. The NEEDLE aims
through a scope instead: a 20° view behind a black scope ring with a fine crosshair, the gun out of
sight. Mouse sensitivity drops with the zoom so turning feels the same. Players you spectate show
their aim and scope too. Numbers: `AIM` in `src/config/game.ts`, `scope` on a weapon in
`src/config/weapons.ts`.

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

### Legendaries

Rare weapons outside the tiers: a map has a 50% chance of one (`LEGENDARY_CHANCE` in `src/config/weapons.ts`), in place of its best power weapon. The practice range rack always has them all.

**SKYSWEEPER**, a flying broom: not a weapon but something you ride, so both hands stay free
to shoot. About 30% of maps have one lying somewhere (`BROOM` in `src/config/game.ts`). Press
use beside it to climb on: you fly where you look (look up to climb, down to dive), strafe with
A/D, rise with jump and sink with crouch; let go and it slows to a hover. It has 25 s of flight,
draining only while ridden. Use with nothing nearby gets you off; one hit of 35 or more knocks you
off; either way the broom falls with its charge for anyone to take. When the charge runs out it
crumbles, and you glide down. Others see you astride it, bristles trailing; flying, the wind
rushes past louder the faster you go. No higher than 20 m.

**SLABRIDER**, a lime-green sport bike: like the broom, something you ride with both hands free.
About 30% of maps have one standing somewhere (`BIKE` in `src/config/game.ts`), on a roll of its
own. Press use beside it to climb on. W opens the throttle up to 16 m/s (twice a run), S brakes
and then backs up, nothing held and it coasts; turning your view turns the bike, carrying its
speed round. Hold jump for a **wheelie**: 20% faster, and everything you deal does double
damage, and everything you take does too. No jumping or crouching while riding. It has 30 s of
fuel, burning only while ridden. Use with nothing nearby gets you off; one hit of 40 or more
knocks you off; either way the bike stays there with its fuel. Out of fuel, it is a wreck.
Ride into someone at 5 m/s or more and you run them over: 3.5 damage per m/s (56 flat out,
doubled on a wheelie) and they are thrown along, once per pass. Ride into a wall and you are hurt
by the speed you lose (40 head-on flat out, enough to throw you off). And on a wheelie, any hit at
all throws you off: you fly up and away from it and tumble head over heels, the view rolling
with you, with no control for 1.6 s, while the bike drops where you were.

**TIRADE.** A rotary cannon with no off switch. One pull of the trigger and it fires all 200
rounds, about 56 a second (nearly four seconds), whatever you do with the trigger, shoving you back
a little with every round. While it runs you cannot switch weapons, throw it or swap it at a
pickup; dying stops it. Empty, the next pull throws it like any other empty gun. `runaway` on the
weapon in `src/config/weapons.ts` (it may fire several rounds in one tick).

**HECKLER.** A megaphone whose blast is your own voice. Hold the trigger and it pulses a cone of
sound (16 m, 35 degrees) ten times a second, as strong as you are LOUD: your microphone level,
measured on your machine and sent to the host with your input. Shouting blows people back and up,
chips their health and throws their aim about; a whisper does nothing; with no microphone (or voice
off) it still gives a weak pulse. While it is on, your voice reaches everyone on the map, in their
heads, through a distorted megaphone with a big stadium echo (repeats at 290 and 470 ms that ring on
for a few seconds after you let go), even on push to talk; your health still raises its pitch, so a
nearly dead heckler sounds ridiculous. You hear yourself through it too, a little quieter (also in the
practice range); use headphones, or your speakers may feed back into your microphone. The sound is in
`src/audio/megaphone.ts`. A fall soon after a blast is your kill. Charge drains 12% a
second. In the practice range it opens your microphone just while it is in hand. `shout` on the
weapon in `src/config/weapons.ts`.

**MONOLOGUE.** A gauntlet that throws a grabbing beam. Its charge starts at 100% and never refills.

| Control | What it does |
| --- | --- |
| hold fire (`LMB`) | the beam: the first player it touches is frozen in mid-air at its end and goes wherever you point. They cannot walk, jump or pick things up, but they can still look round and shoot (shoot the holder to fight your way out). Harmless on its own; drains 9% a second |
| + second fire (`RMB`) | burns whoever is held (5 HP a second), and drains twice as fast (18% a second). The beam and the shell around them run red |
| mouse wheel | while holding someone: push them 1 m further away or pull them 1 m closer (3 to 12 m). With nobody held it switches weapons as usual |
| swing and let go | they keep the speed of your swing (up to 26 m/s, with a little lift): that is the throw. Let go while still and they just drop |

A fall soon after you let go (into the void, the lava) is your kill. Numbers: `beam` on the
weapon in `src/config/weapons.ts`.

**JETHAMMER.** A sledgehammer the size of a fridge that looks like any other hammer. It never swings.
Press fire and the button in the middle of the handle goes in: doors in the back of the head swing
open and the thruster slides out (0.15 s), then it lights, driving you in a dead straight line along your aim (flattened to at most
20 degrees up or down; turning does not steer it), from 14 m/s up to 58 m/s in well under a second,
with a sonic boom as you pass 45. Anyone you run into above 16 m/s dies on the spot, and you carry on
through. Steps and floors are skimmed; a wall costs you 35 HP and stuns you for a second (no
relighting until it wears off). Let go and the rocket stops (the thruster folds away) but you keep your speed. Fuel
drains 50% a second once it flies: two seconds of rocket in all. The movement is in `pmove`, so it is predicted like running.
`jet` on the weapon in `src/config/weapons.ts`.

**KI BLAST.** An energy wave gathered between cupped hands. Hold fire to charge it: a blue-white orb
grows between your hands for up to 2 s, a low hum climbs with it, and you can barely walk. Let go to
unleash a beam for 1.2 s, thin at your hands and widening as it goes: everyone in it is burned and
shoved along it (the fuller the charge, the wider and deadlier: a full one kills anyone who stays in
it), walls stop it, and you can sweep it slowly with your aim (it lags behind). A quick tap under
0.4 s fizzles and costs nothing. Three blasts. Your own fists (the same hands as when unarmed), one above and one below the orb, hold it at your right side, side on, the classic stance, and tremble harder as the orb
swells between them, then come back to the middle, side by side where fists are held, as the beam pours out between them.
Lying on the ground, it is just a crackling ball of energy. Every sound is synthesized, shaped on a reference clip:
a continuous whining rush that climbs as it charges, a deep thump and an electric zap on release, and the beam's
heavy electric buzz, sizzling and crackling with sparks; its name and numbers are `ki` on the weapon in `src/config/weapons.ts`.

**REARVIEW.** A makeup compact, open in your palm: a rose-gold case, a round mirror in the lid
facing you, pressed powder and a puff in the base. It never
hurts anyone by itself. Hold fire and a shimmering oval field (1.25 m across, 1.4 m in front of your
eyes) catches everything other players fire into it: bullets, rails and beams hit the glass and stick
there as glinting slugs carrying the damage they would have done; rockets, grenades and bolts stick
too, their fuses paused. Half a second later each one bounces back on its own, yours now, and
guided: it chases whoever fired it at 18 m/s (slow enough to watch it come, with a faint trail),
following them as they run and curving round walls (or over them) rather than through them. Shut
in on every side, they are safe; after 6 seconds it gives up. Lowering the
field does not drop what is already on it. Your own shots pass through it; it holds up to 60 things
(more are absorbed); if you die, what was on it just drops. Charge drains 22% a second while it is up
(about 4.5 seconds). `mirror` on the weapon in `src/config/weapons.ts`.

**AFTERBURN.** A torch on a hose, its fuel tank on your back. Forwards, the flame reaches 12 m and
burns through everyone in the corridor. Point it at your feet (more than 40 degrees down), standing
or in the air, and it lifts you off: a rocket, thrust against your aim plus a sideways wobble you do
not control, climbing no higher than 5 m above whatever is beneath you (over the void it cannot
hold you up), dropping burning patches behind you that hurt everyone but you for 2.5 seconds. The tank is the catch: while
it is in your hands it is on your back (red, striped), and a single shot in it (the back half of the
body, waist to shoulders) blows you up, hurting everyone near you and scattering fire. That kill
belongs to the shooter. Fuel: 3 seconds of flame. `torch` on the weapon in
`src/config/weapons.ts`.

### Melee powers

Every melee weapon except the BANHAMMER (which needs no help) has a power of its own. The
BANHAMMER instead tolls a great church bell when it hits someone: a deep, loud toll that rings for
about ten seconds, in the head of the two players involved and from the spot for everyone else on
the map (the `bell` sound in `src/audio/sfx.ts`).

| Weapon | Power |
| --- | --- |
| FISTS | **Combo**: the third hit in a row on the same player, each within 0.9 s, is an uppercut: 2.2× damage (53), a launch into the air and a short daze |
| SHIV | **Bleed**: each cut keeps draining 6 HP/s for 4 s after the last cut, stacking up to 3 cuts (18 HP/s); bleeding someone out is your kill |
| FISH | **Soaked**: for 4 s the victim's footing is as slippery as ice (they skid, cannot stop or turn sharply) and the ZAPPER does double damage to them; they drip water |
| SLUGGER | **Wall splat**: for 1.4 s after a hit, slamming into a wall costs 5 HP per m/s of speed lost; a clean hit into a wall nearly kills |

**Right-click specials.** Left click is the weapon's ordinary attack; right click is a move of its own
(when it is the only weapon in your hands: with two one-handed weapons, right click still fires the
right hand). The HUD shows it under the weapon's name (*RMB GUARD*, *RMB LUNGE 1.4*...), dimmed with
the seconds left while it recharges. Dashes, leaps and the guard's shuffle are part of movement, so
they are predicted and feel instant online.

| Weapon | Right click |
| --- | --- |
| FISTS | **Guard** (hold): hits from the front do 75% less and barely push you; you shuffle at 55% speed and cannot punch |
| SHIV | **Lunge**: an 8 m dash in a fifth of a second; the first player in the way is stabbed for 60 and starts bleeding, or killed if it is their back. 2.5 s; one use |
| SLUGGER | **Home run** (hold, then let go): wind up for up to a second; the swing grows from 55 to 110 damage, its shove from 11 to 30 m/s and its lift from 6 to 12 (and the wall splat still applies). 1.5 s; one use |
| BANHAMMER | **Slam**: leap up and forwards, and the landing sends out a shockwave: 70 at the middle, 35 at 5 m, everyone thrown up and out and dazed (cover stops it). 5 s; does not use up one of its three swings |
| FISH | **Splash**: a wave in front of you (7 m, 40 degrees): everyone in it is soaked for 5 s, shoved back and dazed, unhurt. 3 s; one use |

Base damage was raised along with health to 150: FISTS 24, SHIV 40, SLUGGER 55, FISH 8.

Bleeding and soaked players drip red or blue for everyone to see, each power has its own sound,
and the two players involved get a word on screen. The numbers are on each weapon in
`src/config/weapons.ts` (`combo`, `bleed`, `soak`, `vsSoaked`, `wallSplat`).

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
| NEEDLE | sniper | 4 | perfectly accurate, any hit kills (150), slow; the loudest gun: a saturated crack and boom, echo, then the bolt |
| BOUNCER | ricochet rifle | 10 | bounces off walls 3 times, +35% damage per bounce |
| POSTMAN | rocket launcher | 3 | splash and knockback; rocket jumps |
| LOBBER | grenade launcher | 4 | bouncing grenades on a 1.5 s fuse, instant on a direct hit |
| PINEAPPLE | hand grenades | 2 | big blast on a 2.1 s fuse; bounce it round a corner |
| CLINGER | proximity mines | 2 | stick to anything (even moving platforms), arm in 1 s, spare nobody |
| SHIV | knife | 20 | 40, fast; a kill from behind (4.5x); every cut **bleeds** (stacks to 3); 80 thrown; right click: **lunge** |
| SLUGGER | bat | 12 | 55, long reach, sends people flying; batted into a wall = **wall splat**; right click: **home run** |
| ZAPPER | arc beam | 70 | no spread or falloff, 13 m range |
| GUST | air cannon | 5 | almost no damage, enormous shove; also propels you |
| SWAPPER | swap gun | 3 | hit someone and you trade places |
| **Heavy hitters** | | | |
| KINGPIN | minigun | 150 | 0.7 s spin-up, then the highest sustained damage in the game |
| VERDICT | railgun | 3 | 150 damage (a kill), passes through every player in line; as loud as the NEEDLE, built the same way out of synths, full blast until it is cut off dead at 0.3 s |
| BIG ONE | giant rocket | 1 | slow, 11 m blast, 260 damage at the centre; it will kill you too |
| PINATA | cluster launcher | 3 | the grenade bursts into six bouncing bomblets, with a party popper, horn, fanfare and confetti; each bomblet goes off as a festive pop on a note of the same chord |
| BANHAMMER | giant hammer | 3 | one swing kills; slow; right click: **slam** |
| SIX SEVEN | blue fireballs | 16 | your own bare hands (as with fists) pumping up and down in turn (the "6-7"), a blue flame over each; hold fire to fling fireballs left, right, left (14 on a direct hit + a 26 splash of blue fire); four good hits kill |
| **New tricks** | | | |
| TOASTER | flamethrower | 90 | short cone of fire, no aim needed, 8.5 m reach |
| ICEBOX | freeze ray | 30 | light damage; whoever it touches moves at under half speed |
| REELER | harpoon | 5 | 15 damage, and the line reels the target all the way in: they fly on an arc and land about 2.5 m in front of you, from anywhere in its 35 m range, and cannot steer out of it |
| STAPLER | bolt thrower | 6 | 65-damage bolts that fly in an arc, no splash |
| **Memes** | | | |
| GAMBLER | lucky pistol | 7 | every shot rolls its damage between 1 and 140 |
| FISH | a fish | 30 | 8 damage, huge knockback, dazes, and **soaks** with a big splash: icy footing, double ZAPPER damage |
| POTATO | hot potato | 2 | sticks to whoever it hits and explodes after 3 s, unless they touch someone else first, who then has it |

Map placement uses three tiers (`tier` in the data file), but nothing is guaranteed: every weapon spot
rolls on its own from every weapon, each weighted by its tier (`TIER_WEIGHT`: a tier-0 weapon is 3 times
as likely as a tier-2 one, tier 1 twice). Any weapon can turn up anywhere, by your spawn or on the
landmark. The rolls come from the map's seed.

Balance at 6 m against a stationary target, chest shots (from `npm run test:weapons`; these
figures were measured at the old 100 health, so with 150 most times to kill are about half as long
again. One-hit kills at 150: any NEEDLE hit (150, 300 to the head), any VERDICT hit (150, through
everyone in line) and a SHIV in the back (4.5x: 153). The MAGNATE headshot (101) and a single TWINS
shell no longer kill a fresh player):

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

**Option B — from your computer (`npm run deploy`).** Runs the tests, builds the game and pushes
the built files to a `gh-pages` branch; GitHub's own Pages build then publishes that branch. This
needs no workflow of your own, so it still works when Actions are blocked on the account.

1. Run `npm run deploy` (add `-- --no-test` to skip the tests). It uses your normal `git push` login.
2. One time: **Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**.
3. Run it again whenever you want the site updated; each deploy replaces the previous one.

**Option C — anywhere else.** Run `npm run build` and upload the contents of `dist/` to any static
host (Netlify Drop, Cloudflare Pages).

**The public room list on a static host.** GitHub Pages has no server to keep the list, so one of
the players' browsers keeps it (`src/net/peerDirectory.ts`). Every player already uses PeerJS's free
public broker to reach rooms, and the broker gives each address to whoever asks first. The first
browser that needs the list (someone opening JOIN ROOM, or hosting a public room) claims the address
`slabrush-v1-room-list` and keeps the list in memory; everyone else finds it taken and connects to
that browser instead: hosts announce their public rooms to it, join screens ask it for the list.
When that player closes the game, their room is taken off, the others' connections to them close,
and after a random moment (so they do not all rush at once) one of them claims the address and
carries on; hosts re-announce every 1.25 s, so the list is whole again within about 3 seconds. A
host whose connection to the keeper drops has their rooms taken off at once. No server of yours,
no extra service. To try it on the dev server, add `?peerlist` to the address (it skips the dev
server's own list).

## Tuning

| File | Contents |
| --- | --- |
| `src/config/movement.ts` | every movement constant: accelerations, friction, gravity, jump, slide, wall jump, wall run, air strafing |
| `src/config/weapons.ts` | every weapon: damage, fire rate, ammo, spread, recoil, falloff, projectile and throw stats |
| `src/config/game.ts` | tick rate, player size and hit boxes, `MATCH` (rounds per map, maps to win, delays), `RULES_MATCH` (sudden-death zone), `NET` (snapshot rate, interpolation delay, lag-compensation limit) |
| `src/maps/generator.ts` | grid size, level height, archetypes, how often each mechanic appears |
| `src/maps/themes.ts` | colour themes (sky, fog, lights, texture colours) |

## The map generator

`generateMap(seed, size)` in `src/maps/generator.ts`. The host picks a seed and a size and sends both;
every peer runs the same code and gets the same map. It uses only the seeded RNG (`src/core/rng.ts`), never `Math.random`.

The map is designed on a square grid of 3 m cells (a height field plus extras) and then turned into
collision brushes and triggers. Maps come in five sizes, and the size depends on how many players are
in the room (`pickMapSize`): small rooms mostly get small, frantic maps, with the odd big one; a full
room gets space to move. The size is part of the map's name.

| Size | Grid | Across | Spawns | Chance with 2 / 3 / 4 / 5-6 players |
| --- | --- | --- | --- | --- |
| TINY | 8×8 | 24 m | 4 | 30% / 20% / 10% / never |
| SMALL | 10×10 | 30 m | 4 | 30% / 30% / 25% / never |
| MEDIUM | 12×12 | 36 m | 5 | 22% / 25% / 30% / 25% |
| LARGE | 14×14 | 42 m | 6 | 12% / 15% / 20% / 35% |
| HUGE | 16×16 | 48 m | 6 | 6% / 10% / 15% / 40% |

A map never has fewer spawns than players: MEDIUM is the smallest for five, and with six it is LARGE
(47%) or HUGE (53%). Weapon
count, cover, teleporter distance and spawn spacing all scale with the size, and the sudden-death zone
starts just wide enough to take in the map's corners. ISLANDS needs at least a SMALL map (3×3 islands
on HUGE, 2×2 below that). The map lab lets you choose the player count and see what each gets. The grid is what makes validation possible: "can a player get from A to
B" becomes a graph search over cells.

1. **Archetype** — one of four layouts:
   - **ARENA**: open floor, raised central plaza with ramps.
   - **TERRACES**: the floor is cut into plateaus at four heights, joined by ramps, stairs, jump pads and elevators.
   - **ROOMS**: walled rooms joined by doorways, some with timed doors; rooms can be dark, icy or low-gravity.
   - **ISLANDS**: floating platforms over the void, joined by bridges, ramps, jumpable gaps, moving platforms, jump pads and teleporters.
2. **Decoration** — cover, pillars, void pits, deadly floor, conveyor belts, ice fields, low-gravity
   pockets, dark patches, teleporter pairs, and floating slabs reachable only by jump pad. Obstacles are
   only placed in a clearing with a free ring around them, so they can never cut the map in two.
3. **Spawns** — as many as the size has, by farthest-point sampling, as far apart as the size allows
   (12 m on LARGE and HUGE, about 7 m on TINY), facing the centre.
4. **Weapons** — spots: one a few steps from every spawn, three on landmark tops, jump-pad slabs and
   the cells whose *nearest* spawn is as far as possible, the rest spread evenly. What lies in each
   spot is rolled by tier weight (see above); nothing is guaranteed.
5. **Validation** — the map is rejected if any of these fail:
   - from the centre, every walkable cell you can reach must also have a way back (no traps);
   - at least 75% of walkable cells are in that connected core, and all spawns and weapons are in it;
   - spawns are far enough apart for the size, and there are enough weapons (9 on big maps, fewer on small ones);
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
| Trampolines | three jump pads a few metres apart, to bounce between |

Arenas get 3–4 landmarks, terraces 2–3, rooms 1–2, islands at most the trampolines. Arenas now roll
whether to have their central plaza, so the big landmarks can take the middle. Maps also carry about
twice as much low cover as before. The map lab's top line lists the landmarks on the current map.

Map mechanics, all part of the deterministic simulation (and of client prediction):

| Mechanic | How it works |
| --- | --- |
| Jump pads | trampolines: bounce you about 3.8 m up (higher if the pad leads up to high ground) and onwards the way you were already moving, 2.5 m/s faster up to 14 m/s and never slower; standing still sends you straight up, and you can steer in the air. Tuning: `padBounce`, `padBoost`, `padMaxSpeed` in `src/config/movement.ts` |
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
  host relays and stamps with the real sender). The health pitch shift is applied by the speaker,
  to their own microphone before it is sent (their game always knows their real health); where a
  voice comes from (position, distance, dead or alive) is decided by each listener every frame,
  from the same interpolated world it draws. The pitch shifter is a small AudioWorklet: a two-tap
  delay-line shifter with 50 ms crossfaded windows, bypassed completely at full health.
- **The app is session-agnostic.** `Session` has four implementations (practice, map lab, host,
  client); the renderer, audio and HUD only see that interface.

```
src/
  config/     movement.ts, weapons.ts, game.ts        <- tuning lives here
  core/       vec.ts, rng.ts
  sim/        world.ts (collision, movers)  pmove.ts (movement + map mechanics)
              game.ts (rules, weapons, pickups, zone, lag comp)  match.ts, map.ts, types.ts
  maps/       generator.ts (seeded maps)  themes.ts  testMap.ts (practice range)  parkour.ts (obstacle courses)  parkourPilot.ts (test autopilot)
  net/        protocol.ts  transport.ts  peerTransport.ts  hostSession.ts  clientSession.ts  session.ts  parkourSession.ts
  render/     gameRenderer.ts, mapMesh.ts, mapExtras.ts (movers/triggers), textures.ts, models.ts, viewmodel.ts, effects.ts
  audio/      sfx.ts (Web Audio synthesis)  voice.ts (WebRTC proximity voice)  voiceRules.ts (who hears whom, health → pitch)  pitchShifter.ts (AudioWorklet)
  client/     app.ts (main loop), input.ts, hud.ts, menus.ts, settings.ts
scripts/      simtest.ts, nettest.ts, gentest.ts, weapontest.ts, parkourtest.ts
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
- Name tags above every character, sized to stay readable at distance, and shown only while some part of that player (head, chest or feet) is in plain sight: a tag never gives away someone hidden behind a wall or a closed door.
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
  other tabs, push to talk lighting the lobby roster, the pitch other players receive over WebRTC from a steady 200 Hz test voice, measured by
  autocorrelation: 200 Hz at 100 HP, 294 Hz (+6.7 semitones) at 50, 377 Hz (+11.0) at 10, the same
  whether the host or a guest is hurt and at every listener, with no dropouts; a guest's death voice
  as heard by the other two (200 Hz at the moment of death, about 160 Hz halfway, about 50 Hz at the end, then silence, then their
  ghost voice muted for the living, also when the listener's tab is in the background); falloff at 15 m and silence at 40 m, the living not hearing
  the dead while the dead hear the living, and the HUD talk indicator.
- In a browser (Phase 5): the menu backdrop, the retro filter and sky in a generated map, and a
  two-tab `?local` match showing the spectator camera (and later, three tabs: a dead guest seeing
  the watched player's shotgun, then their two pistols when they dual wield, and their health live), the victory orbit with the celebrating winner,
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
- A stuck mine is drawn upright whatever surface it is on. Iron sights are not lined up with each
  gun's real sights (the gun comes to the middle, the crosshair stays). Other players' models do not
  change pose when they aim.
- Your own shots are not predicted (they lag by your ping); rockets, grenades and thrown weapons are not lag
  compensated; no host migration (if the host's connection goes, the match goes with it).
- **Voice was never heard by a person, or tried across two machines.** The fake microphone is a
  beep, and the test tabs share one browser. The pitch curve is measured exact, but how a real voice
  sounds through the shifter at +12 semitones is for your ears; `VOICE` in `src/audio/voiceRules.ts`
  has the knobs. The shifter adds about 25 ms of delay while it is active. Voice does not go muffled behind walls, and a guest can
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
4. Surface-aligned mines; more architectural variety in the generator.
