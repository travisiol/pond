/**
 * Headless checks of the shared simulation: the rules do what the page says
 * and no coin is ever created or lost. Run with `npm run sim`.
 */
import { Bots } from "../src/shared/bots";
import { makeRng } from "../src/shared/geometry";
import { decodeState, encodeState } from "../src/shared/protocol";
import { RULES, canEat, coinsToEth, ethToCoins, lengthFor, speedFor, splitEntry } from "../src/shared/rules";
import { World, defaultTiming, type SimEvent } from "../src/shared/sim";
import { buildState } from "../src/shared/snapshot";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  FAIL ${name} ${detail}`);
  }
}

const DT = 1 / RULES.tickHz;
const E = RULES.entryCoins;
const run = (w: World, seconds: number, each?: (events: SimEvent[]) => void) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const ev = w.step(DT);
    each?.(ev);
  }
};
const at = (x: number, y: number, angle = 0) => ({ x, y, angle });
const spawn = (w: World, coins: number, x: number, y: number, angle = 0, bot = false) =>
  w.spawn({ owner: `t:${x}:${y}`, name: "t", skin: 0, bot, coins, at: at(x, y, angle) });

// ── money helpers ────────────────────────────────────────────────────────
{
  const s = splitEntry(2000);
  check("fee split adds up", s.stake + s.toPot + s.toTreasury === 2000 && s.fee === 200 && s.toPot === 100);
  const odd = splitEntry(1999, 1000, 3333);
  check("fee split adds up on odd numbers", odd.stake + odd.toPot + odd.toTreasury === 1999);
  check("coinsToEth", coinsToEth(2000) === "0.0020" && coinsToEth(45) === "0.000045" && coinsToEth(1_250_000) === "1.2500");
  check("ethToCoins", ethToCoins("0.002") === 2000 && ethToCoins("1") === 1_000_000 && ethToCoins("abc") === null);
  check("canEat needs a clear margin", canEat(1150, 1000) && !canEat(1149, 1000) && !canEat(1000, 1000));
}

// ── eating ───────────────────────────────────────────────────────────────
{
  const w = new World(1, defaultTiming());
  const big = spawn(w, E * 3, 0, 0, 0);
  const small = spawn(w, E, 60, 0, 0);
  run(w, RULES.spawnShieldSeconds - 0.2);
  check("shield: nobody eaten while shielded", big.alive && small.alive);
  // Put them mouth to body once the shield is gone.
  small.x = big.x + lengthFor(big.coins, E) * 0.3;
  small.y = big.y;
  const before = w.totalCoins();
  const smallCoins = small.coins;
  const bigCoins = big.coins;
  let death: SimEvent | undefined;
  run(w, 0.5, (ev) => {
    death ??= ev.find((e) => e.type === "death");
  });
  check("big fish eats small fish", !small.alive && big.alive && !!death);
  const gained = Math.floor((smallCoins * RULES.eatGainBps) / 10_000);
  check("eater gets exactly 80%", death?.type === "death" && death.gained === gained && big.coins >= bigCoins + gained);
  check("eating conserves every coin", w.totalCoins() === before, `${w.totalCoins()} vs ${before}`);
  check("the rest is in the water", w.floorCoins() + big.coins === before);
}
{
  const w = new World(2, defaultTiming());
  const a = spawn(w, E, 0, 0, 0);
  const b = spawn(w, E, 20, 0, Math.PI);
  run(w, 5);
  check("equal fish cannot eat each other", a.alive && b.alive);
}

// ── sprint ───────────────────────────────────────────────────────────────
{
  const w = new World(3, defaultTiming());
  const f = spawn(w, E * 2, 0, 0, 0);
  const slow = spawn(w, E * 2, 0, 800, 0);
  w.setInput(f.id, 0, true, false);
  const before = w.totalCoins();
  run(w, 3);
  check("sprint is faster", f.x > slow.x * 1.5, `${f.x} vs ${slow.x}`);
  check("sprint sheds coins", f.coins < E * 2 && w.floorCoins() > 0);
  check("sprint conserves every coin", w.totalCoins() === before);
  const poor = spawn(w, Math.floor(E * 0.3), 0, -800, 0);
  w.setInput(poor.id, 0, true, false);
  run(w, 1);
  check("no sprint below half an entry", poor.coins === Math.floor(E * 0.3) && !poor.boosting);
  check("bigger fish are slower", speedFor(E * 20, E) < speedFor(E, E));
}

// ── orbs ─────────────────────────────────────────────────────────────────
{
  const w = new World(4, defaultTiming());
  const f = spawn(w, E, 0, 0, 0);
  w.dropPellet(70, 0, 25);
  w.dropPellet(0, 600, 25);
  run(w, 1);
  check("orb ahead is pulled in and eaten", f.coins === E + 25);
  check("orb far away is untouched", w.floorCoins() === 25);
  const edge = w.dropPellet(9000, 0, 5);
  check("orbs stay inside the wall", Math.hypot(edge.x, edge.y) < RULES.arenaRadius);
}

// ── wall ─────────────────────────────────────────────────────────────────
{
  const w = new World(5, defaultTiming());
  const f = spawn(w, E, RULES.arenaRadius - 100, 0, 0);
  run(w, 4);
  check("the wall stops a fish and does not kill it", f.alive && Math.hypot(f.x, f.y) <= RULES.arenaRadius);
}

// ── cash out ─────────────────────────────────────────────────────────────
{
  const w = new World(6, defaultTiming());
  const f = spawn(w, E, 0, 0, 0);
  w.setInput(f.id, 0, false, true);
  run(w, 10);
  check("no cash-out before the minimum stay", f.alive && f.cash === 0);
  run(w, RULES.minStaySeconds - 10 + 1);
  check("cash-out meter fills after the minimum stay", f.alive && f.cash > 0 && f.cashing);
  w.setInput(f.id, 0, false, false);
  run(w, 1);
  check("letting go drains the meter", f.cash === 0);
  w.setInput(f.id, 0, false, true);
  const held = f.coins;
  let out: SimEvent | undefined;
  run(w, RULES.cashSeconds + 0.2, (ev) => {
    out ??= ev.find((e) => e.type === "extracted");
  });
  check("holding for the full time cashes out", !f.alive && out?.type === "extracted" && out.coins === held);
  check("a cashed-out fish leaves nothing behind", w.totalCoins() === 0);
}
{
  const w = new World(7, defaultTiming());
  const f = spawn(w, E, 0, 0, 0);
  const shark = spawn(w, E * 5, -400, 0, 0);
  run(w, RULES.minStaySeconds + 0.1);
  f.x = 0;
  f.y = 0;
  shark.x = -200;
  shark.y = 0;
  shark.angle = 0;
  w.setInput(f.id, 0, false, true);
  w.setInput(shark.id, 0, false, false);
  run(w, RULES.cashSeconds);
  check("a fish cashing out is slow enough to be caught", !f.alive && shark.kills === 1);
}
{
  const w = new World(8, defaultTiming());
  const f = spawn(w, E, 0, 0, 0);
  f.orphanedAt = 0;
  let out: SimEvent | undefined;
  run(w, RULES.minStaySeconds + RULES.cashSeconds + 1, (ev) => {
    out ??= ev.find((e) => e.type === "extracted");
  });
  check("a dropped connection cashes out by itself, after the same wait", out?.type === "extracted" && out.coins === E);
}
{
  const w = new World(9, defaultTiming());
  const bot = spawn(w, E, 0, 0, 0, true);
  w.setInput(bot.id, 0, false, true);
  run(w, RULES.minStaySeconds + RULES.cashSeconds + 2);
  check("bots can never cash out", bot.alive);
}

// ── wire ─────────────────────────────────────────────────────────────────
{
  const w = new World(10, defaultTiming());
  const f = spawn(w, 123_456, 100.5, -200.25, 1.234);
  w.dropPellet(50, 60, 77);
  const state = buildState(w, { camX: 0, camY: 0, myId: f.id });
  const back = decodeState(encodeState(state));
  check(
    "snapshot survives the wire",
    !!back &&
      back.fish.length === 1 &&
      back.fish[0].coins === 123_456 &&
      Math.abs(back.fish[0].x - 100.5) < 0.01 &&
      Math.abs(back.fish[0].angle - 1.234) < 0.001 &&
      back.pellets[0].value === 77 &&
      back.myId === f.id,
  );
}

// ── bots ─────────────────────────────────────────────────────────────────
{
  const w = new World(11, defaultTiming());
  let pot = E * 40;
  const bots = new Bots(w, {
    count: 12,
    stake: () => {
      if (pot < E) return 0;
      pot -= E;
      return E;
    },
    retire: (c) => {
      pot += c;
    },
  });
  const start = pot;
  for (let i = 0; i < 20 * 60 * 4; i++) {
    bots.maintain();
    bots.think();
    for (const e of w.step(DT)) if (e.type === "death" && bots.has(e.id)) bots.onDeath(e.id);
  }
  check("bots only ever hold pot money", pot + w.totalCoins() === start, `${pot + w.totalCoins()} vs ${start}`);
  check("bots keep the water alive", bots.count() > 0 && w.aliveFish().length > 0);
  let ok = true;
  for (const f of w.fish.values()) if (f.coins > E * RULES.botRetireEntries * 2) ok = false;
  check("no bot hoards the pot", ok);
}

// ── conservation under chaos ─────────────────────────────────────────────
{
  const w = new World(12, defaultTiming(0.1));
  const rng = makeRng(99);
  let inCoins = 0;
  let outCoins = 0;
  const ids: number[] = [];
  let drift = 0;
  for (let t = 0; t < 20 * 120; t++) {
    if (w.aliveFish().length < 30 && rng() < 0.2) {
      const coins = Math.floor(E * (0.5 + rng() * 3));
      inCoins += coins;
      ids.push(w.spawn({ owner: `p:${t}`, name: "p", skin: 0, bot: rng() < 0.3, coins }).id);
    }
    if (rng() < 0.05) {
      const v = 1 + Math.floor(rng() * 40);
      inCoins += v;
      w.dropPellet((rng() - 0.5) * 3000, (rng() - 0.5) * 3000, v);
    }
    for (const id of ids) w.setInput(id, rng() * 6.28, rng() < 0.3, rng() < 0.2);
    for (const e of w.step(DT)) if (e.type === "extracted") outCoins += e.coins;
    if (w.totalCoins() !== inCoins - outCoins) drift++;
  }
  check("two minutes of chaos: coins in = coins in the ocean + coins out, every tick", drift === 0, `${drift} bad ticks`);
}

console.log(`\nsim-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
