// Battle bot tests: `npm run test:bots`.
// Bots play through the real GameSim (and a real HostSession for the lobby
// side), so these check what they actually do: fight, pick up weapons, keep
// off edges and lava, finish rounds, and that the levels really differ.
import { BOT_LEVELS, BOT_SKILL, type BotLevel } from '../src/config/bots';
import { DT, MATCH, PLAYER, RULES_MATCH } from '../src/config/game';
import { Rng } from '../src/core/rng';
import { v3, type Vec3 } from '../src/core/vec';
import { generateMap, pickMapSize } from '../src/maps/generator';
import { ClientSession } from '../src/net/clientSession';
import { HostSession } from '../src/net/hostSession';
import { memoryPair } from '../src/net/transport';
import { botCanUse } from '../src/sim/bot';
import { NavGrid } from '../src/sim/nav';
import { GameSim } from '../src/sim/game';
import type { MapDef, Solid } from '../src/sim/map';
import { WEAPONS } from '../src/config/weapons';
import { emptyCmd, type InputCmd } from '../src/sim/types';

let failed = 0;
function check(name: string, ok: boolean, info = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  if (!ok) failed++;
}
const f = (n: number) => n.toFixed(2);

/** A bare map: the given solids, two spawns, nothing else. */
function bare(solids: Solid[], killY = -10): MapDef {
  const base = generateMap(1);
  return { ...base, solids, triggers: [], pickups: [], bots: [], killY, spawns: [{ pos: v3(0, 0, 0), yaw: 0 }, { pos: v3(0, 0, 10), yaw: 0 }] };
}
const floor = (x0: number, z0: number, x1: number, z1: number, surface?: 'deadly'): Solid =>
  ({ type: 'box', min: v3(x0, -1, z0), max: v3(x1, 0, z1), mat: 'concrete', ...(surface ? { surface } : {}) }) as Solid;

/** Run a sim with one input for player 1 (a person standing still unless told otherwise). */
function run(sim: GameSim, seconds: number, me: () => InputCmd = emptyCmd, until?: () => boolean): number {
  for (let i = 0; i < seconds / DT; i++) {
    if (sim.getPlayer(1)) sim.setInput(1, me());
    sim.step();
    sim.events.length = 0;
    if (until?.()) return (i + 1) * DT;
  }
  return Infinity;
}

// ---------------------------------------------------------------- weapons
{
  const usable = Object.values(WEAPONS).filter(botCanUse).map((w) => w.id);
  check('bots use ordinary guns and melee, not the trick weapons or vehicles',
    usable.includes('rivet') && usable.includes('fists') && usable.includes('shiv')
    && !usable.includes('monologue') && !usable.includes('heckler') && !usable.includes('skysweeper') && !usable.includes('slabrider') && !usable.includes('snapper'),
    `${usable.length} usable`);
}

// ---------------------------------------------------- a duel on a flat floor
/**
 * A bot with a rivet against a person 12 m away, standing still or strafing
 * (left and right, half a second each way): seconds until the person is dead.
 */
function duel(level: BotLevel, seed: number, strafe = false): number {
  const sim = new GameSim(bare([floor(-30, -30, 30, 30)]), seed, RULES_MATCH);
  const me = sim.addPlayer(1, 'ME', 1, null, { pos: v3(0, 0, -12), yaw: 0 });
  sim.addPlayer(2, 'BOT', 2, null, { pos: v3(0, 0, 0), yaw: Math.PI / 2 }); // looking away to start with
  sim.makeBot(2, level);
  sim.getPlayer(2)!.weapons[0] = { type: 'rivet', ammo: 999 };
  let i = 0;
  return run(sim, 30, () => ({ ...emptyCmd(), moveR: strafe ? (Math.floor(i++ / 30) % 2 ? 1 : -1) : 0 }), () => !me.alive);
}
{
  const avg = (level: BotLevel, strafe: boolean) => {
    let sum = 0;
    for (let s = 1; s <= 16; s++) sum += Math.min(30, duel(level, s * 977, strafe));
    return sum / 16;
  };
  const still: Record<string, number> = {}, moving: Record<string, number> = {};
  for (const level of BOT_LEVELS) { still[level] = avg(level, false); moving[level] = avg(level, true); }
  const t = BOT_LEVELS.map((l) => `${l}=${f(still[l])}/${f(moving[l])}s`).join(' ');
  check('every level finds and kills a person standing in the open', BOT_LEVELS.every((l) => still[l] < 30), t);
  check('harder levels kill faster', still.easy > still.medium && still.medium > still.hard && still.hard > still.extermination, t);
  // Balance: no level plays like an aimbot. Bands are seconds to kill someone standing still with a pistol at 12 m
  // (a perfect shot needs about 1.1 s); see BOT_SKILL.
  check('balance: EASY >= 6 s, MEDIUM >= 4 s, HARD >= 2.5 s, EXTERMINATION >= 1.4 s', still.easy >= 6 && still.medium >= 4 && still.hard >= 2.5 && still.extermination >= 1.4, t);
  check('...and EXTERMINATION still the deadliest (under 3 s)', still.extermination < 3, t);
  check('strafing makes every level miss more (MEDIUM by a third at least)', BOT_LEVELS.every((l) => moving[l] > still[l]) && moving.medium > still.medium * 1.3, t);
}

// ---------------------------------------------------- walls and levels
/**
 * A bot after a person it cannot see: behind a wall, or up on another level.
 * How long until it first hits them, and how much of the time (while it could
 * not see them) it spent looking straight at them through the wall, or
 * standing still.
 */
function chase(map: MapDef, bot: Vec3, me: Vec3, level: BotLevel): { t: number; staring: number; idle: number } {
  const sim = new GameSim(map, 21, RULES_MATCH);
  const person = sim.addPlayer(1, 'ME', 1, null, { pos: me, yaw: 0 });
  const b = sim.addPlayer(2, 'BOT', 2, null, { pos: bot, yaw: 0 });
  sim.makeBot(2, level);
  b.weapons[0] = { type: 'rivet', ammo: 999 };
  let blind = 0, staring = 0, idle = 0;
  for (let i = 0; i < 25 / DT; i++) {
    sim.setInput(1, emptyCmd());
    sim.step();
    const hit = sim.events.some((e) => e.t === 'hit' && e.attacker === 2);
    sim.events.length = 0;
    if (hit) return { t: (i + 1) * DT, staring: blind ? staring / blind : 0, idle: blind ? idle / blind : 0 };
    const eye = v3(b.pos.x, b.pos.y + PLAYER.eyeHeight, b.pos.z);
    if (sim.world.traceRay(eye, v3(person.pos.x, person.pos.y + 1.1, person.pos.z)).fraction < 1) {
      blind++;
      const at = Math.atan2(-(person.pos.x - b.pos.x), -(person.pos.z - b.pos.z));
      if (Math.abs(Math.atan2(Math.sin(at - b.yaw), Math.cos(at - b.yaw))) < 0.3) staring++;
      if (Math.hypot(b.vel.x, b.vel.z) < 0.5 && b.grounded) idle++;
    }
  }
  return { t: Infinity, staring: blind ? staring / blind : 0, idle: blind ? idle / blind : 0 };
}
const wall = (x0: number, z0: number, x1: number, z1: number, h: number): Solid => ({ type: 'box', min: v3(x0, 0, z0), max: v3(x1, h, z1), mat: 'concrete' }) as Solid;
{
  // A wall across the middle with a gap at one end.
  const map = bare([floor(-15, -15, 15, 15), wall(-15, -0.5, 9, 0.5, 4)]);
  // Another level: a deck 4 m up over half the floor, a ramp up to it at one side.
  const deck = bare([floor(-15, -15, 15, 15), { type: 'box', min: v3(-15, 3.5, 0), max: v3(15, 4, 15), mat: 'concrete' } as Solid,
    { type: 'ramp', min: v3(10, 0, -8), max: v3(14, 4, 0), high: '+z', mat: 'concrete' } as Solid]);
  const rows: string[] = [];
  let ok = true, honest = true;
  for (const level of BOT_LEVELS) {
    const w = chase(map, v3(-6, 0, -6), v3(-6, 0, 6), level);
    const d = chase(deck, v3(-4, 0, 8), v3(-4, 4, 8), level);
    rows.push(`${level}: wall ${f(w.t)}s, deck ${f(d.t)}s, staring ${f(Math.max(w.staring, d.staring))}, idle ${f(Math.max(w.idle, d.idle))}`);
    if (!(w.t < 25 && d.t < 25)) ok = false;
    if (w.staring > 0.25 || d.staring > 0.25 || w.idle > 0.25 || d.idle > 0.25) honest = false;
  }
  for (const r of rows) console.log(`      ${r}`);
  check('bots find their way round a wall, and up to another level, to someone they cannot see', ok);
  check('...without staring at them through the wall or standing still', honest);
}
{
  // Two islands with a 3 m gap of void between: a bot with only its fists has to jump it.
  const islands = bare([floor(-8, -4, -1.5, 4), floor(1.5, -4, 8, 4)]);
  let crossed = 0, fell = 0;
  for (const level of BOT_LEVELS) {
    const sim = new GameSim(islands, 31, RULES_MATCH);
    const me = sim.addPlayer(1, 'ME', 1, null, { pos: v3(5, 0, 0), yaw: 0 });
    const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(-5, 0, 0), yaw: 0 });
    sim.makeBot(2, level);
    let hit = false;
    for (let i = 0; i < 12 / DT && !hit && b.alive; i++) {
      sim.setInput(1, emptyCmd()); sim.step();
      hit = sim.events.some((e) => e.t === 'hit' && e.attacker === 2 && e.victim === me.id);
      sim.events.length = 0;
    }
    if (hit) crossed++;
    if (!b.alive) fell++;
  }
  check('bots jump a gap to get at someone on the other side', crossed === 4 && fell === 0, `${crossed} of 4 got there, ${fell} fell`);
}
{
  // The navigation grid joins the spawns of generated maps, whatever they use to join their levels.
  let pairs = 0, joined = 0;
  for (let n = 1; n <= 30; n++) {
    const seed = n * 104729;
    const map = generateMap(seed, pickMapSize(seed, 4));
    const nav = new NavGrid(map);
    for (const a of map.spawns) for (const c of map.spawns) { if (a === c) continue; pairs++; if (nav.path(a.pos, c.pos)) joined++; }
  }
  check('navigation joins every spawn of generated maps to every other', joined === pairs, `${joined}/${pairs}`);
}

// ------------------------------------------------- every weapon it can use
/** A medium bot holding `weapons` against a person standing 10 m away: does it hit them within 8 s? */
function lands(weapons: [string, number][], level: BotLevel = 'medium'): boolean {
  const sim = new GameSim(bare([floor(-30, -30, 30, 30)]), 11, RULES_MATCH);
  sim.addPlayer(1, 'ME', 1, null, { pos: v3(0, 0, -10), yaw: 0 });
  const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(0, 0, 0), yaw: 0 });
  sim.makeBot(2, level);
  weapons.forEach(([type, ammo], i) => { b.weapons[i] = { type: type as keyof typeof WEAPONS, ammo }; });
  let hit = false;
  for (let i = 0; i < 8 / DT && !hit; i++) {
    sim.setInput(1, emptyCmd());
    sim.step();
    hit = sim.events.some((e) => e.t === 'hit' && e.attacker === 2 && e.victim === 1);
    sim.events.length = 0;
  }
  return hit;
}
{
  const missed = Object.values(WEAPONS).filter((w) => botCanUse(w) && w.id !== 'fists')
    .filter((w) => !lands([[w.id, Math.min(w.ammo, 999)]])).map((w) => w.id);
  check('a bot lands hits with every weapon it picks up', missed.length === 0, missed.length ? `missed with ${missed.join(', ')}` : '');
  check('...and with its fists', lands([]));
  check('dual wielding, it fires a semi-automatic in the other hand (and throws the empty one)', lands([['hornet', 0], ['pepper', 21]]));
}

// ------------------------------------------------------------ EXTERMINATION
{
  const sim = new GameSim(bare([floor(-30, -30, 30, 30)]), 7, RULES_MATCH);
  const a = sim.addPlayer(1, 'ME', 1, null, { pos: v3(0, 0, -2), yaw: Math.PI }); // facing the bot
  const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(0, 0, 0), yaw: 0 });
  sim.makeBot(2, 'extermination');
  a.weapons[0] = { type: 'rivet', ammo: 1 };
  a.cooldown = [0, 0];
  // Point blank at the bot's chest, on the very first tick (before it has moved).
  const yaw = Math.atan2(-(b.pos.x - a.pos.x), -(b.pos.z - a.pos.z));
  sim.setInput(1, { ...emptyCmd(), yaw, pitch: Math.atan2(1.1 - PLAYER.eyeHeight, 2), buttons: 8 }); sim.step();
  const lost = PLAYER.maxHealth - b.health;
  check('EXTERMINATION bots take less damage', lost > 0 && lost < WEAPONS.rivet.damage, `took ${lost} of ${WEAPONS.rivet.damage}`);
  check('EXTERMINATION deals more and takes less; the others play fair',
    BOT_SKILL.extermination.dealt > 1 && BOT_SKILL.extermination.taken < 1 && BOT_SKILL.hard.dealt === 1 && BOT_SKILL.hard.taken === 1 && BOT_SKILL.medium.taken === 1);
}

// ---------------------------------------------------------------- pickups
{
  const map = bare([floor(-30, -30, 30, 30)]);
  map.pickups = [{ pos: v3(8, 0.2, 6), weapon: 'rivet' }];
  const sim = new GameSim(map, 3, RULES_MATCH);
  sim.addPlayer(1, 'ME', 1, null, { pos: v3(-25, 0, -25), yaw: 0 }); // far off, behind a... nothing: it is just far
  const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(0, 0, 0), yaw: 0 });
  sim.makeBot(2, 'medium');
  const t = run(sim, 10, emptyCmd, () => !!b.weapons[0] || !!b.weapons[1]);
  check('an unarmed bot goes and gets a weapon', t < 10, `t=${f(t)}`);
}

// ------------------------------------------------------- edges and lava
{
  // A narrow island; the person is across a gap of void the bot cannot cross.
  const map = bare([floor(-4, -4, 4, 4), floor(-4, 14, 4, 22)]);
  let deaths = 0;
  for (const level of BOT_LEVELS) {
    const sim = new GameSim(map, 5, RULES_MATCH);
    sim.addPlayer(1, 'ME', 1, null, { pos: v3(0, 0, 18), yaw: 0 });
    const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(0, 0, 0), yaw: Math.PI });
    sim.makeBot(2, level);
    run(sim, 8);
    if (!b.alive) deaths++;
  }
  check('bots do not walk off into the void after an enemy they cannot reach', deaths === 0, `${deaths} fell`);
}
{
  // Lava between the bot and the person, with a way round.
  const map = bare([floor(-12, -12, 12, -3), floor(-12, -3, 6, 3, 'deadly'), floor(6, -3, 12, 3), floor(-12, 3, 12, 12)]);
  let burned = 0, arrived = 0;
  for (const level of BOT_LEVELS) {
    const sim = new GameSim(map, 9, RULES_MATCH);
    const me = sim.addPlayer(1, 'ME', 1, null, { pos: v3(-6, 0, 9), yaw: 0 });
    const b = sim.addPlayer(2, 'BOT', 2, null, { pos: v3(-6, 0, -8), yaw: 0 });
    sim.makeBot(2, level);
    run(sim, 12, emptyCmd, () => !b.alive || !me.alive || Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z) < 2.5);
    if (!b.alive) burned++;
    else if (!me.alive || Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z) < 3) arrived++; // (got there and punched them in, or got there)
  }
  check('bots keep out of lava', burned === 0, `${burned} burned`);
  check('...and find the way round it', arrived >= 3, `${arrived} of 4 arrived`);
}

// ------------------------------------------------- whole rounds on real maps
{
  // Bots only, on generated maps, as in a room: the round has to end with one left.
  const results: Record<string, { won: number; draws: number; long: number; voids: number; kills: number; deaths: number }> = {};
  const seeds = new Rng(4242);
  for (const level of BOT_LEVELS) {
    const r = { won: 0, draws: 0, long: 0, voids: 0, kills: 0, deaths: 0 };
    for (let n = 0; n < 8; n++) {
      const seed = seeds.int(1, 0x7fffffff);
      const map = generateMap(seed, pickMapSize(seed, 4));
      const sim = new GameSim(map, seed, RULES_MATCH);
      map.spawns.slice(0, 4).forEach((sp, i) => { sim.addPlayer(10 + i, `B${i}`, i, null, sp); sim.makeBot(10 + i, level); });
      let voidDeaths = 0;
      let t = 0;
      for (; t < 120 / DT; t++) {
        sim.step();
        for (const e of sim.events) if (e.t === 'kill') { if (e.cause === 'void') voidDeaths++; if (e.killer >= 0 && e.killer !== e.victim) r.kills++; r.deaths++; }
        sim.events.length = 0;
        if (sim.players.filter((p) => p.alive).length <= 1) break;
      }
      const alive = sim.players.filter((p) => p.alive).length;
      if (alive === 1) r.won++; else if (alive === 0) r.draws++; else r.long++;
      r.voids += voidDeaths;
    }
    results[level] = r;
  }
  const line = (l: string) => { const r = results[l]; return `${l}: ${r.won} won, ${r.draws} draws, ${r.long} unfinished, ${r.kills}/${r.deaths} kills/deaths, ${r.voids} void`; };
  for (const l of BOT_LEVELS) console.log(`      ${line(l)}`);
  check('bot-only rounds end within two minutes', BOT_LEVELS.every((l) => results[l].long === 0), BOT_LEVELS.map((l) => results[l].long).join('/'));
  check('most deaths are kills, not falls', BOT_LEVELS.every((l) => results[l].kills >= results[l].deaths * 0.5), BOT_LEVELS.map((l) => `${results[l].kills}/${results[l].deaths}`).join(' '));
}

// --------------------------------------------------------- the room lobby
{
  const link = memoryPair();
  let now = 0;
  const clock = () => now;
  const seeds = new Rng(77);
  const host = new HostSession(link.host, 'HOST', clock, () => seeds.int(1, 0x7fffffff));
  const pump = (seconds: number, client?: ClientSession) => {
    for (let i = 0; i < seconds / DT; i++) {
      now += DT * 1000;
      host.update(DT, { sample: emptyCmd });
      link.pump();
      client?.update(DT, { sample: emptyCmd });
      link.pump();
    }
  };
  host.setMaxPlayers(4);
  host.setBots(9, 'hard');
  check('bots fill the free seats, no more', host.roster.length === 4 && host.bots === 3 && host.roster.slice(1).every((p) => p.bot === 'hard' && p.name.startsWith('BOT ')),
    host.roster.map((p) => `${p.name}:${p.bot ?? '-'}`).join(','));
  check('every bot gets its own name and colour', new Set(host.roster.map((p) => p.name)).size === 4 && new Set(host.roster.map((p) => p.color)).size === 4);
  host.setBots(3, 'extermination');
  check('changing the level changes every bot', host.roster.slice(1).every((p) => p.bot === 'extermination'));
  const joining = ClientSession.join(link.connect(), 'GUEST', clock);
  link.pump();
  const client = await joining;
  pump(0.2, client);
  check('a person joining a full room takes a bot\'s seat', host.roster.length === 4 && host.bots === 2 && host.humans === 2 && client.localId > 0);
  check('the guest sees the bots in the lobby', client.roster.filter((p) => p.bot === 'extermination').length === 2);
  host.setMaxPlayers(3);
  check('a smaller room drops bots first', host.roster.length === 3 && host.humans === 2 && host.bots === 1);
  host.setMode('parkour', 'all');
  check('parkour rooms have no bots', host.bots === 0);
  host.setMode('battle', 'all');
  host.setBots(1, 'easy');
  host.start();
  pump(MATCH.countdown + 0.5, client);
  const bot = host.roster.find((p) => p.bot)!;
  const sp = host.sim.getPlayer(bot.id);
  check('bots play in the match, with a brain only on the host', !!sp?.brain && sp.brain.level === 'easy' && !client.getPlayer(bot.id)?.brain && !host.sim.getPlayer(1)!.brain);
  const start = { ...sp!.pos };
  pump(3, client);
  check('the bot moves about once the round is live', Math.hypot(sp!.pos.x - start.x, sp!.pos.z - start.z) > 1 || !sp!.alive);
  check('...and the guest sees it move', !!client.getPlayer(bot.id) && Math.hypot(client.getPlayer(bot.id)!.pos.x - start.x, client.getPlayer(bot.id)!.pos.z - start.z) > 0.5 || !sp!.alive);
  host.setBots(0, 'easy');
  check('bots cannot be changed mid-match', host.bots === 1);
}

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
if (failed) throw new Error('bot tests failed');
