declare const process: { env: Record<string, string | undefined> };
// Headless multiplayer tests: `npm run test:net`.
// A real HostSession and real ClientSessions talk over an in-memory link with
// a fake clock, so the whole netcode + match flow runs without a browser.
import { deathRate, hearing, NORMAL_VOICE, ownVoice, voiceFalloff, voiceShift, VOICE } from '../src/audio/voiceRules';
import { DT, MATCH, PLAYER, RULES_MATCH } from '../src/config/game';
import { Rng } from '../src/core/rng';
import { v3 } from '../src/core/vec';
import { MAP_SIZES, generateMap as buildArena, pickMapSize } from '../src/maps/generator';
import { ClientSession } from '../src/net/clientSession';
import { HostSession } from '../src/net/hostSession';
import { COURSES } from '../src/maps/parkour';
import { RACE } from '../src/sim/race';
import { CUSTOM_MAPS } from '../src/maps/custom';
import { MapEditor } from '../src/maps/editor';
import { cleanMapFile } from '../src/maps/mapFile';
import type { VoiceSignal } from '../src/net/protocol';
import { memoryPair } from '../src/net/transport';
import { DirectoryHub, ROOM_TTL, RoomDirectory, servedLocally } from '../src/net/roomDirectory';
import { GameSim } from '../src/sim/game';
import { RoundTally, matchRows } from '../src/client/scoreboard';
import { BTN, type InputCmd } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number) => n.toFixed(2);

class FakeInput {
  seq = 0;
  buttons = 0;
  moveF = 0;
  moveR = 0;
  yaw = 0;
  spin = 0; // radians turned per input: run in a small circle
  sample(): InputCmd {
    this.yaw += this.spin;
    return { seq: this.seq++, buttons: this.buttons, moveF: this.moveF, moveR: this.moveR, yaw: this.yaw, pitch: 0 };
  }
}

// ------------------------------------------------------------ arena maps
{
  const a = JSON.stringify(buildArena(123456)), b = JSON.stringify(buildArena(123456));
  check('arena is deterministic for a seed', a === b);
  check('different seeds give different arenas', a !== JSON.stringify(buildArena(123457)));
  let ok = true, minPickups = 99;
  for (let s = 1; s <= 300; s++) {
    try {
      const m = buildArena(s * 7919);
      minPickups = Math.min(minPickups, m.pickups.length);
      if (m.spawns.length !== MAP_SIZES.find((z) => z.cells === m.info?.cells)?.spawns) ok = false; // as many as its size promises
    } catch { ok = false; }
  }
  check('300 seeds build and validate', ok && minPickups >= 6, `min pickups=${minPickups}`);
}

// ------------------------------------------------------ lag compensation
{
  const shoot = (useViewTick: boolean): number => {
    // bare floor, so nothing blocks the runner
    const flat = { ...buildArena(1), pickups: [], solids: [{ type: 'box' as const, min: v3(-50, -1, -50), max: v3(50, 0, 50), mat: 'concrete' as const }] };
    const sim = new GameSim(flat, 1, RULES_MATCH);
    const a = sim.addPlayer(1, 'A', 1), b = sim.addPlayer(2, 'B', 2);
    a.pos = v3(-20, 0.01, 12); // open strip along the wall
    b.pos = v3(-20, 0.01, 0);
    a.weapons[0] = { type: 'rivet', ammo: 12 };
    const idle = (yaw: number): InputCmd => ({ seq: 0, buttons: 0, moveF: 0, moveR: 0, yaw, pitch: 0 });
    for (let i = 0; i < 40; i++) { // B runs sideways (+x) at full speed
      sim.setInput(1, idle(0));
      sim.setInput(2, { ...idle(0), moveR: 1 });
      sim.step();
    }
    const seenTick = sim.tick;
    const seen = { ...b.pos }; // where A "sees" B: A's screen is 8 ticks behind
    for (let i = 0; i < 8; i++) { sim.setInput(2, { ...idle(0), moveR: 1 }); sim.step(); }
    const yaw = Math.atan2(-(seen.x - a.pos.x), -(seen.z - a.pos.z));
    sim.setInput(1, { ...idle(yaw), buttons: BTN.FIRE, pitch: -0.05, viewTick: useViewTick ? seenTick : undefined });
    sim.setInput(2, { ...idle(0), moveR: 1 });
    sim.step();
    return b.health;
  };
  const withComp = shoot(true), without = shoot(false);
  check('lag compensation: shot at the seen position hits', withComp < PLAYER.maxHealth, `health=${withComp}`);
  check('without it the same shot misses', without === PLAYER.maxHealth, `health=${without}`);
}

// --------------------------------------------------------- sudden death
{
  const sim = new GameSim(buildArena(5), 1, { ...RULES_MATCH, zone: { start: 2, shrinkTime: 4, startRadius: 34, minRadius: 4, damage: 6 } });
  const a = sim.addPlayer(1, 'A', 1, null, sim.map.spawns[0]);
  sim.addPlayer(2, 'B', 2, null, sim.map.spawns[1]);
  a.pos = v3(0.5, 12, 0.5); // A drops into the middle, B camps in a corner
  let firstDeath = -1;
  for (let i = 0; i < 60 * 40 && firstDeath < 0; i++) {
    sim.step();
    const dead = sim.players.find((p) => !p.alive);
    if (dead) firstDeath = dead.id;
  }
  check('zone kills the camper first', firstDeath === 2, `first death=${firstDeath} t=${f(sim.roundTime)}`);
  for (let i = 0; i < 60 * 40; i++) sim.step();
  check('zone eventually ends any round', sim.players.every((p) => !p.alive));
}

// ------------------------------------------------------ hold-Tab scoreboard
{
  const t = new RoundTally();
  const k = (killer: number, victim: number) => ({ t: 'kill' as const, killer, victim, cause: 'rivet' as const, pos: v3() });
  t.add(k(1, 2), 'playing');
  t.add(k(-1, 3), 'playing'); // fell into the void: a death, nobody's kill
  t.add(k(2, 2), 'playing'); // own rocket: a death, not a kill
  t.add(k(1, 3), 'countdown'); // not during a round: ignored
  check('round tally: kills and deaths as the simulation counts them', t.kills(1) === 1 && t.kills(2) === 0 && t.deaths(2) === 2 && t.deaths(3) === 1);
  t.sync('playing');
  const kept = t.kills(1) === 1;
  t.sync('roundEnd');
  check('and empties once the round is over (the host has added it to the totals)', kept && t.kills(1) === 0 && t.deaths(2) === 0);
}

// ------------------------------------------------- host + client session
async function sessions(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const seeds = new Rng(Number(process.env.NETSEED ?? 1));
  const host = new HostSession(link.host, 'HOST', clock, () => seeds.int(1, 0x7fffffff));
  const hin = new FakeInput(), cin = new FakeInput();

  const joining = ClientSession.join(link.connect(), 'GUEST<b>', clock, [3, 4, 5]);
  link.pump();
  const client = await joining;
  const run = (seconds: number) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, hin);
      link.pump();
      client.update(DT, cin);
      link.pump();
    }
  };
  run(0.2);
  check('client joined the lobby', client.localId === 2 && client.roster.length === 2 && client.code === 'TESTS',
    `id=${client.localId} roster=${client.roster.map((p) => p.name).join(',')}`);
  check('names are sanitised', client.roster[1].name === 'GUESTb');
  check('the guest\'s look reaches everyone', host.roster[1].look.join() === '3,4,5' && client.roster[1].look.join() === '3,4,5');

  host.start();
  run(0.5);
  check('round start reaches the client', client.match.phase === 'countdown' && client.match.mapNumber === 1);
  check('client built the identical map from the seed',
    client.map.seed === host.map.seed && JSON.stringify(client.map.solids) === JSON.stringify(host.map.solids));
  check('...at the size the host picked for the room (two players)', client.map.info?.cells === host.match.mapSize
    && host.match.mapSize === pickMapSize(host.match.mapSeed, 2) && client.map.extent === host.map.extent);
  const spawn = { ...host.sim.getPlayer(2)!.pos };
  cin.moveF = 1;
  run(1);
  const frozen = host.sim.getPlayer(2)!;
  check('nobody moves during the countdown', Math.hypot(frozen.pos.x - spawn.x, frozen.pos.z - spawn.z) < 0.01);
  run(MATCH.countdown);
  check('round goes live', host.match.phase === 'playing' && client.match.phase === 'playing');
  check('players wear their look in the match', host.sim.getPlayer(2)!.look.join() === '3,4,5');

  // Prediction: the client moves at once; the host's copy must agree.
  cin.moveR = 0.4;
  cin.buttons = BTN.JUMP;
  run(1.2);
  const hp = host.sim.getPlayer(2)!, cp = client.getPlayer(2)!;
  const moved = Math.hypot(hp.pos.x - spawn.x, hp.pos.z - spawn.z);
  const gap = Math.hypot(hp.pos.x - cp.pos.x, hp.pos.y - cp.pos.y, hp.pos.z - cp.pos.z);
  check('client-predicted movement matches the host while moving', moved > 3 && gap < 0.8, `moved=${f(moved)} gap=${f(gap)}`);
  cin.moveF = cin.moveR = cin.buttons = 0;
  run(2); // long enough for any wall run to end and the player to land
  const gap2 = Math.hypot(hp.pos.x - cp.pos.x, hp.pos.y - cp.pos.y, hp.pos.z - cp.pos.z);
  check('and converges exactly at rest', gap2 < 0.01, `gap=${gap2.toFixed(4)} host=${f(hp.pos.x)},${f(hp.pos.y)},${f(hp.pos.z)} g=${hp.grounded} wr=${hp.wallRunning} client=${f(cp.pos.x)},${f(cp.pos.y)},${f(cp.pos.z)} g=${cp.grounded} wr=${cp.wallRunning}`);

  // Interpolation: the client's view of the host player follows the real one.
  hin.moveF = 1;
  run(0.6);
  hin.moveF = 0;
  run(0.5);
  const h1 = host.sim.getPlayer(1)!, c1 = client.getPlayer(1);
  check('client interpolates the host player', !!c1 && Math.hypot(h1.pos.x - c1.pos.x, h1.pos.z - c1.pos.z) < 0.05);
  check('client mirrors pickups', client.pickups.length === host.sim.pickups.length && client.pickups.length >= 6);

  // The teleport bug: a player's machine stalls for a third of a second while
  // they are running. Their inputs then reach the host in one burst. The host
  // must play all of them, so nobody is yanked back to where they were.
  // (Running in a tight circle, so the test stays on the patch of floor it is already standing on.)
  cin.spin = 0.1;
  cin.moveF = 1;
  run(0.4);
  now += 20 * DT * 1000; // the stall...
  client.update(20 * DT, cin); // ...then 20 ticks of input at once
  link.pump();
  let worstStep = 0, worstFix = 0;
  let prev = { ...client.getPlayer(2)!.pos };
  for (let i = 0; i < 60; i++) {
    run(DT);
    const q = client.getPlayer(2)!.pos;
    worstStep = Math.max(worstStep, Math.hypot(q.x - prev.x, q.z - prev.z));
    // how far the host's answer is pulling the client away from its own prediction
    const e = (client as unknown as { err: { x: number; y: number; z: number } }).err;
    worstFix = Math.max(worstFix, Math.hypot(e.x, e.y, e.z));
    prev = { ...q };
  }
  cin.spin = 0;
  cin.moveF = 0;
  run(0.6);
  const hp2 = host.sim.getPlayer(2)!, cp2 = client.getPlayer(2)!;
  const settle = Math.hypot(hp2.pos.x - cp2.pos.x, hp2.pos.z - cp2.pos.z);
  // A normal step at run speed is 0.13 m and corrections are a few centimetres. If the host
  // drops the burst, the client is corrected by a metre or more (or snapped outright).
  check('a client hiccup does not teleport the player', worstStep < 0.4 && worstFix < 0.25 && settle < 0.05 && hp2.alive,
    `worst step=${f(worstStep)}m worst correction=${f(worstFix)}m host gap after=${f(settle)}m`);
  cin.moveF = 0;
  run(0.5);

  // Round / map flow: the guest falls into the void twice.
  const loseRound = () => { host.sim.getPlayer(2)!.pos.y = -100; run(0.2); };
  loseRound();
  check('last one standing wins the round',
    host.match.phase === 'roundEnd' && host.match.winner === 1 && client.match.roundWins[1] === 1);
  check('client knows it is dead', client.getPlayer(2)!.alive === false);
  check('kill event reached the client', client.events.some((e) => e.t === 'kill' && e.victim === 2));
  {
    // The hold-Tab scoreboard, as the guest's game builds it. The round is over,
    // so the host has already added it to the totals: the event must not count twice.
    const tally = new RoundTally();
    for (const e of client.events) tally.add(e, client.match.phase);
    tally.sync(client.match.phase);
    const rows = matchRows(client.match, client.roster, client.localId, (id) => client.getPlayer(id)?.alive, tally);
    const h = rows.find((r) => r.id === 1)!, g = rows.find((r) => r.id === 2)!;
    check('scoreboard: round winner on top, the void death counted once', rows[0].id === 1 && h.host && !h.me && g.me
      && h.mapRounds === 1 && h.rounds === 1 && g.deaths === 1 && g.kills === 0 && h.kills === 0 && g.alive && g.look.join() === '3,4,5',
      JSON.stringify(rows.map((r) => [r.id, r.mapRounds, r.rounds, r.kills, r.deaths])));
  }
  client.events.length = 0;
  host.events.length = 0;
  run(MATCH.roundEndDelay + 0.3);
  check('second round on the same map', host.match.round === 2 && host.match.mapNumber === 1 && client.match.phase === 'countdown');
  check('client respawned for the new round', client.getPlayer(2)!.alive === true);
  run(MATCH.countdown + 0.2);
  const seed1 = host.map.seed;
  loseRound();
  run(MATCH.roundEndDelay + 0.3);
  check('two round wins take the map', host.match.phase === 'mapEnd' && client.match.mapWins[1] === 1);
  run(MATCH.mapEndDelay + 0.5);
  check('next map is new and identical on both sides',
    host.match.mapNumber === 2 && host.map.seed !== seed1 && client.map.seed === host.map.seed && client.match.round === 1);

  // Play the match out: first to MATCH.mapsToWin maps.
  let guard = 0;
  while (host.match.phase !== 'matchEnd' && guard++ < 40) {
    run(MATCH.countdown + 0.2);
    if (host.match.phase === 'playing') loseRound();
    run(Math.max(MATCH.roundEndDelay, MATCH.mapEndDelay) + 0.5);
  }
  check('first to six maps wins the match', host.match.phase === 'matchEnd' && host.match.mapWins[1] === MATCH.mapsToWin
    && client.match.phase === 'matchEnd' && client.match.winner === 1, `maps=${host.match.mapWins[1]}`);
  const st = client.match.stats;
  check('match stats reach the client', st[1]?.rounds === MATCH.mapsToWin * MATCH.roundsPerMap && st[2]?.deaths === st[1].rounds && st[2]?.rounds === 0,
    JSON.stringify(st));
  run(MATCH.matchEndDelay + 0.5);
  check('everyone returns to the lobby', host.match.phase === 'lobby' && client.match.phase === 'lobby');

  // Leaving in the lobby frees the seat at once; host shutdown is noticed. (Joining mid-match and reconnecting: rejoin().)
  client.dispose();
  run(0.2);
  check('host notices a player leaving the lobby', host.roster.length === 1);

  const link2 = memoryPair();
  const host2 = new HostSession(link2.host, 'H2', clock);
  const j2 = ClientSession.join(link2.connect(), 'C2', clock, [99, -1, 'x' as unknown as number]);
  link2.pump();
  const client2 = await j2;
  link2.pump();
  check('a bogus look from the network is replaced', host2.roster[1]?.look.join() === '0,0,0');
  host2.dispose();
  check('client notices the host leaving', client2.ended === 'The host closed the room' && client2.hostLeft, String(client2.ended));
}

// ---------------------------------------------- joining mid-match, reconnecting
async function rejoin(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'HOST', clock, () => 4242);
  const hin = new FakeInput();
  const clients: { s: ClientSession; in: FakeInput }[] = [];
  const join = async (name: string, token = '') => {
    const j = ClientSession.join(link.connect(), name, clock, [0, 0, 0], token);
    link.pump();
    const s = await j;
    clients.push({ s, in: new FakeInput() });
    link.pump();
    return s;
  };
  const run = (seconds: number) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, hin);
      link.pump();
      for (const c of clients) if (!c.s.ended) c.s.update(DT, c.in);
      link.pump();
    }
  };
  const seat = (id: number) => host.roster.find((p) => p.id === id);

  const a = await join('A');
  host.start();
  run(MATCH.countdown + 0.5);
  check('(the match is under way)', host.match.phase === 'playing');

  // Someone arrives mid-round: let in, shown the match, watching until the next round.
  const late = await join('LATE');
  run(0.3);
  check('joining a match in progress is allowed', late.localId === 3 && !!late.token && host.roster.length === 3);
  check('the late joiner gets the match and builds the same map', late.match.phase === 'playing' && late.map.seed === host.map.seed
    && JSON.stringify(late.map.solids) === JSON.stringify(host.map.solids));
  check('and watches this round instead of playing it', late.waiting && !late.getPlayer(3)?.alive && !host.sim.getPlayer(3));

  // A drops mid-match: their seat is held.
  const aToken = a.token;
  a.dispose();
  run(0.2);
  check('a player who drops mid-match keeps their seat, marked away', !!seat(2)?.away && host.roster.length === 3 && !host.sim.getPlayer(2)?.alive);
  run(MATCH.roundEndDelay + MATCH.countdown + 1); // A's forfeit ends the round; the next one starts
  check('next round: the late joiner plays, the away player sits out', !!host.sim.getPlayer(3) && !host.sim.getPlayer(2) && !late.waiting,
    `round ${host.match.round}, in sim: ${host.sim.players.map((p) => p.id).join(',')}`);
  const deathsBefore = host.match.stats[2]?.deaths ?? 0;

  // A comes back with the token: same seat, same name, same score.
  const back = await join('A AGAIN', aToken);
  run(0.3);
  check('back with the token: the same seat', back.localId === 2 && !seat(2)?.away && seat(2)?.name === 'A' && host.roster.length === 3);
  check('the score carried over', (host.match.stats[2]?.deaths ?? 0) === deathsBefore && deathsBefore >= 1);
  check('they watch the rest of this round (no sneaking back in alive)', back.waiting && !host.sim.getPlayer(2));

  // A made-up token is just a new player.
  const stranger = await join('X', 'not-a-real-token');
  check('a wrong token gets a new seat, never another player\'s', stranger.localId === 4 && host.roster.length === 4);

  // The connection blips but the host never noticed: the new connection simply takes over, still alive.
  const alive = !!host.sim.getPlayer(3)?.alive;
  const again = await join('LATE 2', late.token);
  run(0.3);
  check('rejoining before the host noticed the drop: carry on playing', alive && again.localId === 3 && !!host.sim.getPlayer(3)?.alive
    && host.roster.length === 4 && !again.waiting);

  // Seats are not held for ever.
  stranger.dispose();
  run(0.1);
  check('(the stranger is away)', !!seat(4)?.away);
  run(MATCH.rejoinGrace + 1); // everyone else keeps playing meanwhile
  check(`a seat is given up after ${MATCH.rejoinGrace} s away`, !seat(4) && host.roster.length === 3);

  // The host closes the room: everyone is told, so nobody tries to reconnect.
  host.dispose();
  link.pump();
  check('the host closing the room says so (no reconnecting to nothing)', back.hostLeft && back.ended === 'The host closed the room', String(back.ended));
}

// -------------------------------------------------------------- host pause
async function pausing(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'HOST', clock, () => 99);
  const hin = new FakeInput(), cin = new FakeInput();
  const j = ClientSession.join(link.connect(), 'GUEST', clock);
  link.pump();
  const c = await j;
  const run = (seconds: number) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, hin);
      link.pump();
      c.update(DT, cin);
      link.pump();
    }
  };
  host.setPaused(true);
  check('no pausing in the lobby', !host.match.paused);
  host.start();
  run(MATCH.countdown + 0.5);
  const at = { ...host.sim.getPlayer(2)!.pos };
  const roundTime = host.sim.roundTime;
  host.setPaused(true);
  cin.moveF = 1; // the guest keeps pushing forward the whole time
  run(2);
  const still = host.sim.getPlayer(2)!.pos;
  check('paused: nobody moves', Math.hypot(still.x - at.x, still.z - at.z) < 0.01, `moved ${f(Math.hypot(still.x - at.x, still.z - at.z))} m`);
  check('and the round clock stops', host.sim.roundTime === roundTime && host.match.phase === 'playing');
  check('everyone is told', !!c.match.paused);
  const shown = c.getPlayer(2)!.pos;
  check('the guest\'s own view does not run ahead either', Math.hypot(shown.x - at.x, shown.z - at.z) < 0.3, `drift ${f(Math.hypot(shown.x - at.x, shown.z - at.z))} m`);
  host.setPaused(false);
  run(1);
  const moved = host.sim.getPlayer(2)!.pos;
  check('resumed: back to normal', !c.match.paused && Math.hypot(moved.x - at.x, moved.z - at.z) > 2 && host.sim.roundTime > roundTime);
  check('no lurch: the inputs held during the pause were dropped', Math.hypot(moved.x - at.x, moved.z - at.z) < 12, `moved ${f(Math.hypot(moved.x - at.x, moved.z - at.z))} m in 1 s`);
}

// ------------------------------------------------------------ parkour races
async function racing(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'HOST', clock, () => 7);
  const hin = new FakeInput(), cin = new FakeInput();
  const j = ClientSession.join(link.connect(), 'GUEST', clock);
  link.pump();
  const c = await j;
  const run = (seconds: number) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, hin);
      link.pump();
      c.update(DT, cin);
      link.pump();
    }
  };
  host.setMode('parkour', 'all');
  link.pump();
  check('the guest is told the room races', c.mode === 'parkour' && c.course === 'all');
  host.start();
  run(0.2);
  const r = () => host.match.race!;
  const course = () => COURSES.find((x) => x.id === r().courses[r().index])!;
  check('a race over every course, in order', host.match.mode === 'parkour' && r().courses.join() === COURSES.map((x) => x.id).join());
  check('host and guest build the same course', host.map === course().map && c.map === course().map, `${c.map.name}`);
  const hp = host.sim.getPlayer(1)!, gp = host.sim.getPlayer(2)!;
  check('both line up on the start, side by side', Math.hypot(hp.pos.x - gp.pos.x, hp.pos.z - gp.pos.z) > 0.8);
  run(MATCH.countdown);
  check('the clock starts at the end of the countdown', host.match.phase === 'playing' && r().startTick > 0);
  // The host reaches the first checkpoint; the guest falls off before it.
  const cp1 = course().map.triggers.find((t) => t.type === 'checkpoint' && t.index === 1)!;
  if (cp1.type === 'checkpoint') hp.pos = { ...cp1.spawn };
  gp.pos = { ...gp.pos, y: course().fallY - 1 };
  run(0.2);
  check('a checkpoint counts, and everyone hears of it', r().runners[1].cp === 1 && c.match.race?.runners[1].cp === 1);
  check('a fall puts you back on the start before any checkpoint', gp.alive && Math.abs(gp.pos.x - course().map.spawns[1].pos.x) < 0.5 && r().runners[2].cp === 0);
  hp.pos = { ...hp.pos, y: course().fallY - 1 };
  run(0.2);
  check('...and on your last checkpoint after one', cp1.type === 'checkpoint' && Math.abs(hp.pos.x - cp1.spawn.x) < 0.5 && hp.alive);
  // Both finish, the guest first.
  const fin = course().map.triggers.find((t) => t.type === 'finish')!;
  const onFinish = { x: (fin.min.x + fin.max.x) / 2, y: fin.min.y + 0.05, z: (fin.min.z + fin.max.z) / 2 };
  gp.pos = { ...onFinish };
  run(0.5);
  check('a finish is timed', r().runners[2].finish !== null && r().runners[1].finish === null && host.match.phase === 'playing');
  check('the others get a while longer', (r().endTick - host.sim.tick) * DT <= RACE.afterFirst && (r().endTick - host.sim.tick) * DT > RACE.afterFirst - 10);
  hp.pos = { ...onFinish };
  run(0.3);
  check('everyone home: the course closes, points by place', host.match.phase === 'roundEnd' && r().points[2] === 10 && r().points[1] === 7 && r().order?.[0] === 2 && host.match.winner === 2);
  check('the guest sees the results', c.match.phase === 'roundEnd' && c.match.race?.points[2] === 10);
  // Next course.
  run(8);
  check('then the next course', r().index === 1 && host.match.phase !== 'roundEnd' && c.map === course().map, c.map.name);
  // The rest: nobody finishes the second (time runs out), the host wins the third.
  run(MATCH.countdown + 0.5);
  host.sim.getPlayer(1)!.pos = { ...host.sim.getPlayer(1)!.pos };
  const close = r().endTick;
  for (let i = 0; i < 1000 && host.match.phase === 'playing'; i++) { host.sim.tick = Math.max(host.sim.tick, close - 2); run(0.1); }
  check('time up: a course closes with nobody home, no points', host.match.phase === 'roundEnd' && r().points[1] === 7 && r().points[2] === 10);
  run(8 + MATCH.countdown + 0.5);
  const fin3 = course().map.triggers.find((t) => t.type === 'finish')!;
  host.sim.getPlayer(1)!.pos = { x: (fin3.min.x + fin3.max.x) / 2, y: fin3.min.y + 0.05, z: (fin3.min.z + fin3.max.z) / 2 };
  run(0.3);
  check('only the guest left: still racing', host.match.phase === 'playing' && r().runners[1].finish !== null);
  for (let i = 0; i < 1000 && host.match.phase === 'playing'; i++) { host.sim.tick = Math.max(host.sim.tick, r().endTick - 2); run(0.1); }
  run(8);
  check('after the last course: the race is won on points', host.match.phase === 'matchEnd' && r().points[1] === 17 && host.match.winner === 1 && c.match.winner === 1, JSON.stringify(r().points));
  run(RACE.finalDelay + 1);
  check('and back to the lobby, still a parkour room', host.match.phase === 'lobby' && host.mode === 'parkour');
}

// ---------------------------------------------------------- proximity voice
{
  const H = PLAYER.maxHealth; // the voice follows health as a share of full health
  const full = voiceShift(H), half = voiceShift(H * 0.5), low = voiceShift(H * 0.1), none = voiceShift(0);
  check('full health is your normal voice', full.semitones === 0 && full.lowCut === VOICE.lowCut[0]);
  check('voice rises steadily as health drops',
    half.semitones > 4 && low.semitones > half.semitones && none.semitones > low.semitones && half.lowCut > full.lowCut,
    `+${f(half.semitones)} st at half health, +${f(low.semitones)} at a tenth, +${f(none.semitones)} at 0`);
  check('zero health is a full octave up, and no further', none.semitones === 12 && VOICE.maxSemitones <= 12
    && JSON.stringify(voiceShift(-40)) === JSON.stringify(none) && JSON.stringify(voiceShift(H * 2.5)) === JSON.stringify(NORMAL_VOICE));
  check('the low cut stays gentle (vowels survive)', none.lowCut <= 300);
  const hurt = { alive: true, health: 20 };
  check('your own voice follows your health only while alive in a round',
    ownVoice('playing', hurt).semitones > 8 && ownVoice('countdown', hurt).semitones > 8
    && ownVoice('roundEnd', hurt).semitones === 0 && ownVoice('lobby', hurt).semitones === 0
    && ownVoice('playing', { alive: false, health: 0 }).semitones === 0);
  const alive = { alive: true }, dead = { alive: false };
  check('lobby and between rounds: everyone hears everyone',
    (['lobby', 'roundEnd', 'mapEnd', 'matchEnd'] as const).every((ph) => hearing(ph, dead, alive) === 'flat'));
  check('in a round the living are heard by proximity', hearing('playing', alive, alive) === 'positional' && hearing('countdown', alive, dead) === 'positional');
  check('in a parkour race everyone hears everyone, wherever they are', hearing('playing', alive, alive, false, true) === 'flat' && hearing('countdown', alive, dead, false, true) === 'flat' && hearing('playing', undefined, alive, false, true) === 'mute');
  check('the dead talk among themselves, unheard by the living', hearing('playing', dead, dead) === 'flat' && hearing('playing', dead, alive) === 'mute');
  check('last words: the freshly dead are still heard where they fell',
    hearing('playing', dead, alive, true) === 'positional' && hearing('playing', dead, alive, false) === 'mute');
  const speeds = [0, 0.25, 0.5, 0.75, 1].map((k) => deathRate(k * VOICE.death.seconds));
  check('the death voice starts at normal speed and keeps slowing, ending very deep',
    speeds[0] === 1 && speeds[1] > 0.9 && speeds[2] > 0.75 && speeds.every((v, i) => i === 0 || v < speeds[i - 1])
    && speeds[4] === VOICE.death.endRate && 12 * Math.log2(speeds[4]) <= -20 && deathRate(9) === VOICE.death.endRate,
    `speed ${speeds.map((v) => f(v)).join(' → ')}`);
  check('the death voice is heard for its whole length',
    VOICE.death.seconds === 4 && VOICE.death.heardFor > VOICE.death.seconds && VOICE.death.heardFor < VOICE.death.seconds + VOICE.death.silenceAfter);
  check('voice fades out with distance', voiceFalloff(1) === 1 && voiceFalloff(VOICE.far) === 0 && voiceFalloff(15) > 0 && voiceFalloff(15) < 1);
}

async function voiceRelay(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'H', clock, () => 77);
  const ja = ClientSession.join(link.connect(), 'A', clock);
  link.pump();
  const a = await ja;
  const jb = ClientSession.join(link.connect(), 'B', clock);
  link.pump();
  const b = await jb;
  link.pump();
  const got: { at: string; from: number; d: VoiceSignal }[] = [];
  host.voice.onSignal = (from, d) => got.push({ at: 'host', from, d });
  a.voice.onSignal = (from, d) => got.push({ at: 'a', from, d });
  b.voice.onSignal = (from, d) => got.push({ at: 'b', from, d });
  const offer: VoiceSignal = { k: 'offer', sdp: 'v=0' };
  host.voice.send(a.localId, offer);
  a.voice.send(b.localId, { k: 'answer', sdp: 'v=0 a' });
  b.voice.send(host.localId, { k: 'ice', c: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' } });
  link.pump();
  link.pump();
  const at = (who: string) => got.filter((g) => g.at === who);
  check('voice handshake: host reaches a client', at('a').length === 1 && at('a')[0].from === 1 && at('a')[0].d.k === 'offer');
  check('voice handshake: client to client goes through the host', at('b').length === 1 && at('b')[0].from === a.localId && at('b')[0].d.k === 'answer');
  check('voice handshake: client reaches the host', at('host').length === 1 && at('host')[0].from === b.localId && at('host')[0].d.k === 'ice');

  // Junk and spoofing are dropped: the host stamps the sender itself.
  got.length = 0;
  const tr = (a as unknown as { tr: { send(m: unknown, r: boolean): void } }).tr;
  tr.send({ t: 'vsig', to: b.localId, d: { k: 'offer', sdp: 42 } }, true);
  tr.send({ t: 'vsig', to: b.localId, d: { k: 'evil' } }, true);
  tr.send({ t: 'vsig', to: b.localId, from: 1, d: offer }, true);
  link.pump();
  link.pump();
  check('malformed voice signals are dropped, senders cannot be faked',
    got.length === 1 && got[0].at === 'b' && got[0].from === a.localId, JSON.stringify(got.map((g) => [g.at, g.from])));

  // Remote players' health reaches every client (it shapes their voice).
  host.start();
  const hin = new FakeInput();
  for (let i = 0; i < 0.5 / DT; i++) { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, hin); b.update(DT, hin); link.pump(); }
  host.sim.getPlayer(b.localId)!.health = 37;
  for (let i = 0; i < 0.3 / DT; i++) { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, hin); b.update(DT, hin); link.pump(); }
  check('clients know other players\' health', a.getPlayer(b.localId)?.health === 37 && a.getPlayer(1)?.health === PLAYER.maxHealth,
    `seen=${a.getPlayer(b.localId)?.health}`);
  // Aiming is shown to everyone (spectators see the scope).
  host.sim.getPlayer(1)!.weapons[0] = { type: 'needle', ammo: 4 };
  hin.buttons = BTN.FIRE2;
  for (let i = 0; i < 0.3 / DT; i++) { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, hin); b.update(DT, hin); link.pump(); }
  const seen = a.getPlayer(1)?.aiming;
  hin.buttons = 0;
  for (let i = 0; i < 0.3 / DT; i++) { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, hin); b.update(DT, hin); link.pump(); }
  check('clients see who is aiming', seen === true && a.getPlayer(1)?.aiming === false);

  // A guest's loudness (their microphone level) reaches the host with their input: it powers the HECKLER.
  const shouter = new FakeInput();
  shouter.seq = hin.seq + 5000;
  const loudSample = shouter.sample.bind(shouter);
  shouter.sample = () => ({ ...loudSample(), loud: 0.73 });
  for (let i = 0; i < 0.2 / DT; i++) { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, shouter); b.update(DT, hin); link.pump(); }
  check('a guest\'s loudness reaches the host', host.sim.getPlayer(a.localId)!.cmd.loud === 0.73, String(host.sim.getPlayer(a.localId)!.cmd.loud));

  // A soaked guest skids; their own prediction must skid the same way as the host.
  const runner = new FakeInput();
  runner.seq = hin.seq + 100000; // this guest has been sending hin's numbers: carry on above them, or the host drops ours as old
  runner.moveF = 1;
  let worst = 0;
  const tickAll = () => { now += DT * 1000; host.update(DT, hin); link.pump(); a.update(DT, runner); b.update(DT, hin); link.pump(); };
  for (let i = 0; i < 10 / DT && host.match.phase !== 'playing'; i++) tickAll(); // wait out the countdown
  { const sp = host.sim.getPlayer(a.localId)!.pos; runner.yaw = Math.atan2(sp.x, sp.z); } // face the middle of the map, not a wall
  for (let i = 0; i < 0.6 / DT; i++) tickAll();
  host.sim.getPlayer(a.localId)!.soaked = 3;
  for (let i = 0; i < 0.3 / DT; i++) tickAll();
  const speedAtRelease = Math.hypot(host.sim.getPlayer(a.localId)!.vel.x, host.sim.getPlayer(a.localId)!.vel.z);
  runner.moveF = 0; // let go: on a soaked floor they keep sliding
  const from = { ...host.sim.getPlayer(a.localId)!.pos };
  for (let i = 0; i < 1.2 / DT; i++) {
    tickAll();
    const hp = host.sim.getPlayer(a.localId)!.pos, cp = a.getPlayer(a.localId)!.pos;
    worst = Math.max(worst, Math.hypot(hp.x - cp.x, hp.z - cp.z));
  }
  const to = host.sim.getPlayer(a.localId)!.pos, skid = Math.hypot(to.x - from.x, to.z - from.z);
  check('a soaked guest\'s prediction skids like the host', worst < 0.8 && skid > 2 && a.getPlayer(a.localId)!.soaked > 0,
    `${f(speedAtRelease)} m/s at release, skidded ${f(skid)} m, worst gap ${f(worst)} m`);
  host.dispose();
}

// --------------------------------------- the online room list (kept by a browser)
{
  const hub = new DirectoryHub();
  const room = { code: 'ROOMA', host: 'ANA', players: 1, max: 6, phase: 'lobby', local: false, at: 5000 };
  hub.receive('host', { t: 'announce', room }, 5);
  const seen = hub.receive('joiner', { t: 'list' }, 5.1);
  check('online list: a public room announced to the keeper is listed to everyone', seen?.t === 'rooms' && seen.rooms.map((r) => r.code).join() === 'ROOMA');
  hub.closed('host');
  check('the host\'s connection closes: off the list at once', hub.receive('joiner', { t: 'list' }, 5.2)?.rooms.length === 0);
  hub.receive('host2', { t: 'announce', room: { ...room, at: 6000 } }, 6);
  check('back after a blip: listed again', hub.receive('joiner', { t: 'list' }, 6.1)?.rooms.length === 1);
  hub.receive('host2', { t: 'withdraw', code: 'ROOMA', at: 7000 }, 7);
  check('withdrawn (closed, or gone private): off at once, and stays off', hub.receive('joiner', { t: 'list' }, 7.1)?.rooms.length === 0
    && (hub.receive('host2', { t: 'announce', room: { ...room, at: 6900 } }, 7.2), hub.receive('joiner', { t: 'list' }, 7.3)?.rooms.length === 0));
  const junk = [null, 'x', { t: 'announce', room: { code: '1' } }, { t: 'nope' }, { t: 'withdraw', code: 5 }];
  check('junk messages change nothing', junk.every((j) => hub.receive('evil', j, 8) === null) && hub.receive('joiner', { t: 'list' }, 8)?.rooms.length === 0);
}

// ------------------------------------------------- rooms on the local network
{
  const dir = new RoomDirectory();
  const room = { code: 'ABCDE', host: 'GABE', players: 2, max: 4, phase: 'lobby', local: false, at: 1000 };
  check('a hosted room is listed', dir.post(room, 0) && dir.list(1).length === 1 && dir.list(1)[0].host === 'GABE');
  dir.post({ ...room, players: 3, phase: 'playing' }, 2);
  check('re-announcing updates it in place', dir.list(3).length === 1 && dir.list(3)[0].players === 3 && dir.list(3)[0].phase === 'playing');
  dir.post({ ...room, code: 'FGHJK', host: 'ANA' }, 3);
  dir.post(room, 4); // the first one announces again: order must not change
  check('the list keeps its order', dir.list(5).map((r) => r.code).join() === 'ABCDE,FGHJK');
  // FGHJK last spoke at t=3, ABCDE at t=4: just after FGHJK's time is up, only ABCDE is left.
  check('a room that stops announcing drops off', dir.list(3 + ROOM_TTL + 0.5).map((r) => r.code).join() === 'ABCDE');
  dir.post({ ...room, at: 20000 }, 20);
  dir.post({ code: 'abcde', gone: true, at: 21000 }, 21);
  check('a closed room is withdrawn at once', dir.list(21).length === 0);
  // An announcement sent just before the room closed, arriving just after: it must not bring it back.
  check('a late announcement cannot bring a closed room back', !dir.post({ ...room, at: 20900 }, 21.2) && dir.list(21.3).length === 0);
  // Private, then public again: the host announces afresh, and it is listed.
  check('but a room made public again is listed again', dir.post({ ...room, at: 22000 }, 22) && dir.list(22).length === 1);
  dir.post({ code: 'ABCDE', gone: true, at: 23000 }, 23);
  check(`a host that vanishes without a word drops off within ${ROOM_TTL} s`, ROOM_TTL <= 5
    && dir.post({ ...room, code: 'ZXCVB', at: 24000 }, 24) && dir.list(24 + ROOM_TTL - 0.1).length === 1 && dir.list(24 + ROOM_TTL + 0.1).length === 0);
  const bad = [null, 'x', { code: 'AB1' }, { code: 'TOOLONG' }, { code: 12345 }];
  check('junk announcements are rejected', bad.every((b) => !dir.post(b, 30)) && dir.list(30).length === 0);
  dir.post({ code: 'QWERT', host: '<script>alert(1)</script>VERYLONGNAMEINDEED', players: 99, max: -3, phase: 'hacked', local: 'yes' }, 31);
  const q = dir.list(31)[0];
  check('announcements are cleaned', q.host.length <= 14 && !/[<>]/.test(q.host) && q.players === 1 && q.max === 6 && q.phase === 'lobby' && q.local === false, JSON.stringify(q));
  let n = 0;
  for (let i = 0; i < 100; i++) if (dir.post({ ...room, code: 'Z' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)) + 'QQ' }, 32)) n++;
  check('the list cannot be flooded', dir.list(32).length <= 64, `${dir.list(32).length} listed`);
}

// ---------------------------------------------------------- PARKOUR: joining and coming back mid-race
async function raceJoining(): Promise<void> {
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'HOST', clock, () => 99);
  const hin = new FakeInput();
  const clients: { s: ClientSession; in: FakeInput }[] = [];
  const join = async (name: string, token = '') => {
    const j = ClientSession.join(link.connect(), name, clock, [0, 0, 0], token);
    link.pump();
    const s = await j;
    clients.push({ s, in: new FakeInput() });
    link.pump();
    return s;
  };
  const run = (seconds: number) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, hin);
      link.pump();
      for (const c of clients) if (!c.s.ended) c.s.update(DT, c.in);
      link.pump();
    }
  };
  const a = await join('A');
  host.setMode('parkour', COURSES[0].id);
  link.pump();
  host.start();
  run(MATCH.countdown + 0.5);
  check('(the race is under way)', host.match.phase === 'playing' && !!host.match.race);
  const r = host.match.race!, course = COURSES[0];
  // Someone joins while the course is being raced: they run it now, from the start.
  const late = await join('LATE');
  run(0.5);
  const lp = host.sim.getPlayer(late.localId);
  check('joining a race in progress: you run it now, from the start', !!lp?.alive && !!r.runners[late.localId] && !late.waiting
    && Math.hypot(lp!.pos.x - course.map.spawns[0].pos.x, lp!.pos.z - course.map.spawns[0].pos.z) < 6);
  check('and everyone sees you on the standings', !!a.match.race?.runners[late.localId]);
  // A reaches checkpoint 2, then drops.
  const ap = host.sim.getPlayer(a.localId)!;
  for (const k of [1, 2]) {
    const cp = course.map.triggers.find((t) => t.type === 'checkpoint' && t.index === k)!;
    if (cp.type === 'checkpoint') ap.pos = { ...cp.spawn };
    run(0.2);
  }
  check('(A is on checkpoint 2)', r.runners[a.localId].cp === 2);
  const token = a.token, aid = a.localId;
  a.dispose();
  run(3); // longer than a respawn
  check('dropping out of a race leaves no body on the course, not even later', !host.sim.getPlayer(aid) && host.match.phase === 'playing');
  // A comes back: straight onto checkpoint 2, progress kept.
  const back = await join('A', token);
  run(0.5);
  const bp = host.sim.getPlayer(aid), cp2 = course.map.triggers.find((t) => t.type === 'checkpoint' && t.index === 2)!;
  check('coming back to a race: on your last checkpoint, progress kept', back.localId === aid && !!bp?.alive && !back.waiting
    && cp2.type === 'checkpoint' && Math.hypot(bp!.pos.x - cp2.spawn.x, bp!.pos.z - cp2.spawn.z) < 4 && r.runners[aid].cp === 2);
}

// ---------------------------------------------------------- a map made in the map lab, in the rotation
async function customRotation(): Promise<void> {
  const ed = new MapEditor(MapEditor.blank('battle', 'MAKER'));
  ed.tool = 'spawn';
  ed.place({ point: { x: 6, y: 0, z: 6 }, normal: { x: 0, y: 1, z: 0 }, solid: 0, yaw: 0 });
  ed.place({ point: { x: -6, y: 0, z: -6 }, normal: { x: 0, y: 1, z: 0 }, solid: 0, yaw: 0 });
  const f = cleanMapFile(ed.file);
  CUSTOM_MAPS.push(f); // (as if accepted with add-map)
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const host = new HostSession(link.host, 'HOST', clock, () => 7); // (a seed that picks the hand-made map)
  const j = ClientSession.join(link.connect(), 'GUEST', clock);
  link.pump();
  const c = await j;
  host.start();
  for (let i = 0; i < 0.3 / DT; i++) { now += DT * 1000; host.update(DT, new FakeInput()); link.pump(); c.update(DT, new FakeInput()); link.pump(); }
  check('a battle map made in the map lab comes up in the rotation, for host and guest alike', host.match.mapId === f.id && host.map === f.map && c.map === f.map
    && !!host.sim.getPlayer(2) && f.map.spawns.some((sp) => Math.hypot(sp.pos.x - host.sim.getPlayer(2)!.pos.x, sp.pos.z - host.sim.getPlayer(2)!.pos.z) < 0.1));
  CUSTOM_MAPS.splice(CUSTOM_MAPS.indexOf(f), 1);
}

await voiceRelay();
await sessions();
await rejoin();
await pausing();
await racing();
await raceJoining();
await customRotation();
// The dev server's room list is only asked for on this machine or the local network; on GitHub Pages it goes straight to the browser-kept list.
check('room list: the dev server is asked only when served locally', ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.20.1.1', 'box.local'].every(servedLocally)
  && !['devgabe1.github.io', 'example.com', '172.40.1.1', '8.8.8.8'].some(servedLocally));
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('network tests failed');
