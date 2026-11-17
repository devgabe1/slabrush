declare const process: { env: Record<string, string | undefined> };
// Headless multiplayer tests: `npm run test:net`.
// A real HostSession and real ClientSessions talk over an in-memory link with
// a fake clock, so the whole netcode + match flow runs without a browser.
import { deathRate, hearing, NORMAL_VOICE, ownVoice, voiceFalloff, voiceShift, VOICE } from '../src/audio/voiceRules';
import { DT, MATCH, RULES_MATCH } from '../src/config/game';
import { Rng } from '../src/core/rng';
import { v3 } from '../src/core/vec';
import { generateMap as buildArena } from '../src/maps/generator';
import { ClientSession } from '../src/net/clientSession';
import { HostSession } from '../src/net/hostSession';
import type { VoiceSignal } from '../src/net/protocol';
import { memoryPair } from '../src/net/transport';
import { GameSim } from '../src/sim/game';
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
      if (m.spawns.length !== 6) ok = false;
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
  check('lag compensation: shot at the seen position hits', withComp < 100, `health=${withComp}`);
  check('without it the same shot misses', without === 100, `health=${without}`);
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
  run(1);
  const gap2 = Math.hypot(hp.pos.x - cp.pos.x, hp.pos.y - cp.pos.y, hp.pos.z - cp.pos.z);
  check('and converges exactly at rest', gap2 < 0.01, `gap=${gap2.toFixed(4)}`);

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

  // Late joiner while a match runs is refused; leaving and host shutdown are noticed.
  host.start();
  run(0.3);
  const late = ClientSession.join(link.connect(), 'LATE', clock).then(() => 'joined', (e: Error) => e.message);
  link.pump();
  check('joining mid-match is refused', (await late).includes('in progress'));
  client.dispose();
  run(0.2);
  check('host notices a player leaving', host.roster.length === 1);

  const link2 = memoryPair();
  const host2 = new HostSession(link2.host, 'H2', clock);
  const j2 = ClientSession.join(link2.connect(), 'C2', clock, [99, -1, 'x' as unknown as number]);
  link2.pump();
  const client2 = await j2;
  link2.pump();
  check('a bogus look from the network is replaced', host2.roster[1]?.look.join() === '0,0,0');
  host2.dispose();
  check('client notices the host leaving', client2.ended === 'The host left the match', String(client2.ended));
}

// ---------------------------------------------------------- proximity voice
{
  const full = voiceShift(100), half = voiceShift(50), low = voiceShift(10), none = voiceShift(0);
  check('full health is your normal voice', full.semitones === 0 && full.lowCut === VOICE.lowCut[0]);
  check('voice rises steadily as health drops',
    half.semitones > 4 && low.semitones > half.semitones && none.semitones > low.semitones && half.lowCut > full.lowCut,
    `+${f(half.semitones)} st at 50 HP, +${f(low.semitones)} at 10, +${f(none.semitones)} at 0`);
  check('zero health is a full octave up, and no further', none.semitones === 12 && VOICE.maxSemitones <= 12
    && JSON.stringify(voiceShift(-40)) === JSON.stringify(none) && JSON.stringify(voiceShift(250)) === JSON.stringify(NORMAL_VOICE));
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
  check('clients know other players\' health', a.getPlayer(b.localId)?.health === 37 && a.getPlayer(1)?.health === 100,
    `seen=${a.getPlayer(b.localId)?.health}`);
  host.dispose();
}

await voiceRelay();
await sessions();
console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('network tests failed');
