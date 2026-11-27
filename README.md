# SLABRUSH

An original browser FPS: fast movement, pickup weapons, last one standing. Multiplayer is
peer-to-peer with room codes, so there is no server to run. Every battle map is generated from a
seed, and all models, textures and sounds are made in code.

## Run locally

Requires Node 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173.

| Command | What it does |
| --- | --- |
| `npm run dev` | development server |
| `npm run dev:lan` | HTTPS server for friends on the same network |
| `npm run build` | type check and production build into `dist/` |
| `npm test` | all test suites |
| `npm run add-map -- <file>` | add a map made in the map lab to the rotation |

## Play with friends

1. One player clicks **CREATE ROOM** and shares the five-letter code, or lists the room as public.
2. The others click **JOIN ROOM** and enter the code, or pick the room from the public list.
3. The host starts the match. The host's machine runs the game, so the match ends if the host closes it.

A room plays one of three modes, picked when it is created or in the lobby: **BATTLE** (last one
standing, no respawns), **TEAM** (RED against BLUE with respawns and no friendly fire; the first team to
50 kills wins, or the team ahead after 10 minutes) or **PARKOUR** (a race over the obstacle courses).
TEAM matches are played on hand-built maps, each a mirror image so neither side is favoured:
**ARCADE SKYLINE** (neon rooftops over a highway canyon) and **FROSTFANG FJORD** (Viking longhouses
across a frozen lake).

Rules, controls and map-making are explained in the game's menus.

**Voice chat** is on by default. Use headphones, or switch to push to talk in **Settings**.

**Testing alone:** open two tabs at `http://localhost:5173/?local`.

## Deploy

**Automatic:** the workflow in `.github/workflows/deploy.yml` publishes every push to `main`. In the
repository, set **Settings → Pages → Source: GitHub Actions**.

**From your computer:** run `npm run deploy`. It runs the tests, builds the game and pushes it to the
`gh-pages` branch. The first time, set **Settings → Pages → Source: Deploy from a branch →
gh-pages / (root)**.

Any static host works too: upload the contents of `dist/` after `npm run build`.

## Tests

`npm test` runs the simulation, networking, map generator, weapon, parkour, map-lab and decoration
suites. Each one also has its own script in `package.json`.

## For developers

Architecture, conventions and where things live are in [CLAUDE.md](CLAUDE.md). Tuning values
(movement, weapons, match rules, voice) are in `src/config/` and `src/audio/voiceRules.ts`.
