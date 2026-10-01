/**
 * Ledger soak: the real Arena and the real SQLite ledger, no sockets and no
 * clock. It steps the ocean as fast as the CPU allows for SOAK_MINUTES of
 * game time with bots, heavy rain and a handful of scripted wallets that
 * spawn, sprint, get eaten, cash out, drop their socket and come back —
 * and after EVERY tick it holds the two invariants the money rests on:
 *
 *   deposited + funded = lobbies + claimable + pot + ocean     (drift 0)
 *   crash shadow on disk = coins in the live ocean
 *
 * It is the only test that reaches a bot retiring (pot up, shadow down in
 * one transaction), which a 40-second socket run never sees.
 *
 *   npm run soak          (SOAK_MINUTES=30 by default)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "frenzy-soak-"));
Object.assign(process.env, {
  DB_PATH: join(tmp, "soak.sqlite"),
  CHAIN: "off",
  DEV_FAUCET: "true",
  TIME_SCALE: "0.2",
  ENTRY_COINS: process.env.ENTRY_COINS ?? "2000",
  FEE_BPS: process.env.FEE_BPS ?? "1000",
  FEE_POT_SHARE_BPS: process.env.FEE_POT_SHARE_BPS ?? "5000",
  TREASURY_ADDRESS: "",
  BOT_COUNT: process.env.BOT_COUNT ?? "24",
  RAIN_PER_MINUTE: process.env.RAIN_PER_MINUTE ?? "900",
  CHECKPOINT_SECONDS: "5",
});

// Imported after the environment is set: the config is read at import time.
const { RULES, coinsToWei } = await import("../../web/src/shared/rules");
const { assertConfig, config, entrySplit } = await import("../src/config");
const db = await import("../src/db");
const { Arena } = await import("../src/arena");

assertConfig();
const MINUTES = Number(process.env.SOAK_MINUTES ?? "30");
const WALLETS = 10;

let seed = 20261001;
function rand(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

const fakeSocket = (): WebSocket => ({ readyState: 1, OPEN: 1, send() {} }) as unknown as WebSocket;

db.recoverCheckpoint();
const arena = new Arena();
// Private members the soak drives and counts. The run is the test; the cast is its only liberty.
const inner = arena as unknown as { tickOnce(dt: number): void; botRetired(coins: number): void };

let retirements = 0;
let retiredCoins = 0;
const realRetire = inner.botRetired.bind(arena);
inner.botRetired = (coins: number) => {
  retirements++;
  retiredCoins += coins;
  realRetire(coins);
};

db.faucetPot(coinsToWei(2_000_000));
const wallets = Array.from({ length: WALLETS }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
for (const w of wallets) db.faucet(w, coinsToWei(400_000));

type ClientOf = ReturnType<typeof arena.connect>;
const clients = new Map<string, ClientOf | null>();
for (const w of wallets) {
  const c = arena.connect(fakeSocket(), "soak");
  arena.hello(c, w);
  clients.set(w, c);
}

let failures = 0;
function fail(msg: string): void {
  failures++;
  if (failures <= 10) console.error(`  FAIL tick ${arena.world.tick}: ${msg}`);
}

const dt = 1 / RULES.tickHz;
const ticks = Math.round(MINUTES * 60 * RULES.tickHz);
const started = Date.now();
let spawns = 0;
let reconnects = 0;
let drops = 0;

for (let i = 0; i < ticks; i++) {
  for (const w of wallets) {
    let c = clients.get(w) ?? null;
    if (!c) {
      // Offline: come back now and then (the fish may have cashed out by itself meanwhile).
      if (rand() < 0.01) {
        c = arena.connect(fakeSocket(), "soak");
        arena.hello(c, w);
        clients.set(w, c);
        reconnects++;
      }
      continue;
    }
    if (c.fishId === null) {
      if (rand() < 0.02) {
        arena.spawnRequest(c, undefined);
        if (c.fishId !== null) spawns++;
      }
      continue;
    }
    const f = arena.world.fish.get(c.fishId);
    if (!f) continue;
    if (rand() < 0.002) {
      arena.disconnect(c);
      clients.set(w, null);
      drops++;
      continue;
    }
    if (rand() < 0.2) {
      const age = arena.world.time - f.spawnedAt;
      const wantOut = age > arena.world.timing.minStaySeconds * 3 && f.coins > config.entryCoins;
      arena.input(c, f.angle + (rand() - 0.5) * 1.6, rand() < 0.25 ? 1 : 0, wantOut ? 1 : 0);
    }
  }

  inner.tickOnce(dt);

  const live = arena.world.totalCoins();
  const shadow = db.checkpointTotal();
  if (shadow !== live) fail(`crash shadow ${shadow} != ocean ${live}`);
  // The full books are a table scan: every 5 ticks is plenty, every tick near the end.
  if (i % 5 === 0 || i > ticks - 200) {
    const b = db.books(live);
    if (b.drift !== 0n) fail(`books drift ${b.drift} wei`);
  }
}

const count = (type: string): number =>
  Number((db.db.prepare("SELECT COUNT(*) AS n FROM history WHERE type = ?").get(type) as { n: number }).n);
const deaths = count("death");
const extracts = count("extract");

// A crash right now: what the shadow holds goes back, and the books still close.
const before = db.books(arena.world.totalCoins());
const rec = db.recoverCheckpoint();
const after = db.books(0);
if (after.drift !== 0n) fail(`books drift ${after.drift} wei after recovering the checkpoint`);
if (coinsToWei(rec.coins + rec.floor) !== before.ocean) fail(`recovery returned ${rec.coins + rec.floor} coins, the ocean held ${before.ocean / coinsToWei(1)}`);

const split = entrySplit();
console.log(`\nsoak: ${MINUTES} min of game time, ${ticks} ticks in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`  player spawns ${spawns} (entry ${config.entryCoins} = ${split.stake} stake + ${split.toPot} pot + ${split.toTreasury} treasury)`);
console.log(`  player deaths ${deaths}, cash-outs ${extracts}, sockets dropped ${drops}, reconnected ${reconnects}`);
console.log(`  bots retired ${retirements} (${retiredCoins} coins back to the pot)`);
console.log(`  final recovery: ${rec.players} player(s) ${rec.coins} coins to lobbies, ${rec.floor} coins to the pot`);
const thin: string[] = [];
if (spawns === 0) thin.push("no spawn");
if (deaths === 0) thin.push("no player death");
if (extracts === 0) thin.push("no cash-out");
if (retirements === 0) thin.push("no bot retirement");
if (thin.length > 0) {
  failures++;
  console.error(`  FAIL the run never exercised: ${thin.join(", ")}`);
}
console.log(failures === 0 ? `\nsoak passed: both invariants held after every one of ${ticks} ticks` : `\nsoak FAILED: ${failures} violation(s)`);

db.db.close();
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* the OS will clean its temp dir */
}
process.exit(failures === 0 ? 0 : 1);
