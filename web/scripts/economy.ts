/**
 * Does the money hold together? Runs the real simulation with scripted
 * players of different skill for an hour of game time and prints where
 * every coin went. Run with `npm run economy`.
 *
 * The table is the whole ledger: what players paid in, what they took out,
 * what the treasury kept, what the pot holds, what is still in the water.
 * The last line checks that nothing was created or lost.
 */
import { Bots } from "../src/shared/bots";
import { makeRng } from "../src/shared/geometry";
import { RULES, canEat, coinsToEth, lengthFor, splitEntry } from "../src/shared/rules";
import { World, defaultTiming, type Fish } from "../src/shared/sim";

const ENTRY = RULES.entryCoins;
const DT = 1 / RULES.tickHz;
const MINUTES = Number(process.argv[2] ?? 60);
const POT_SEED = ENTRY * 30;

type Style = {
  name: string;
  /** How far ahead the player notices a bigger fish. */
  sight: number;
  /** Cash out once the fish is worth this many times its stake. */
  target: number;
  /** Seconds between two decisions: slower = clumsier. */
  reaction: number;
};

const STYLES: Style[] = [
  { name: "sharp, greedy (x3)", sight: 420, target: 3, reaction: 0.1 },
  { name: "sharp, quick (x1.4)", sight: 420, target: 1.4, reaction: 0.1 },
  { name: "average (x2)", sight: 300, target: 2, reaction: 0.25 },
  { name: "average (x2)", sight: 300, target: 2, reaction: 0.25 },
  { name: "careless (x2)", sight: 170, target: 2, reaction: 0.5 },
  { name: "careless (x2)", sight: 170, target: 2, reaction: 0.5 },
  { name: "never cashes out", sight: 300, target: 1e9, reaction: 0.25 },
  { name: "cashes out at once", sight: 300, target: 0, reaction: 0.25 },
];

interface Seat {
  style: Style;
  fishId: number;
  paid: number;
  taken: number;
  lives: number;
  eaten: number;
  cashed: number;
  kills: number;
  nextThink: number;
  stake: number;
}

const rng = makeRng(2026);
const world = new World(7, defaultTiming(), ENTRY);
let pot = POT_SEED;
let treasury = 0;
let rained = 0;
const split = splitEntry(ENTRY);

const bots = new Bots(world, {
  count: 14,
  stake: (size) => {
    const stake = Math.floor(split.stake * size);
    if (pot < stake) return 0;
    pot -= stake;
    return stake;
  },
  retire: (c) => {
    pot += c;
  },
});

const seats: Seat[] = STYLES.map((style) => ({ style, fishId: 0, paid: 0, taken: 0, lives: 0, eaten: 0, cashed: 0, kills: 0, nextThink: 0, stake: 0 }));

function decide(f: Fish, s: Style): { angle: number; boost: boolean; cash: boolean } {
  let angle = f.targetAngle;
  let best = 0;
  for (const o of world.fish.values()) {
    if (o === f || !o.alive) continue;
    const d = Math.hypot(o.x - f.x, o.y - f.y);
    if (canEat(o.coins, f.coins) && d < s.sight + lengthFor(o.coins, ENTRY)) {
      return { angle: Math.atan2(f.y - o.y, f.x - o.x), boost: d < 170, cash: false };
    }
    if (canEat(f.coins, o.coins) && o.coins / (90 + d) > best && d < 600) {
      best = o.coins / (90 + d);
      angle = Math.atan2(o.y - f.y, o.x - f.x);
    }
  }
  const wantsOut = world.canCash(f) && f.coins >= split.stake * s.target;
  if (wantsOut) return { angle, boost: false, cash: true };
  for (const p of world.pelletsNear(f.x, f.y, 450)) {
    const d = Math.hypot(p.x - f.x, p.y - f.y);
    if (p.value / (60 + d) > best) {
      best = p.value / (60 + d);
      angle = Math.atan2(p.y - f.y, p.x - f.x);
    }
  }
  if (best === 0 && Math.hypot(f.x, f.y) > RULES.arenaRadius * 0.7) angle = Math.atan2(-f.y, -f.x);
  return { angle, boost: false, cash: false };
}

let rainAcc = 0;
const ticks = MINUTES * 60 * RULES.tickHz;
const orb = Math.max(1, Math.floor(ENTRY * RULES.rainOrbEntryFraction));
let potMin = pot;
for (let t = 0; t < ticks; t++) {
  // Players come back a few seconds after a life ends.
  for (const s of seats) {
    if (s.fishId === 0 && rng() < 0.01) {
      s.paid += ENTRY;
      s.lives += 1;
      pot += split.toPot;
      treasury += split.toTreasury;
      s.stake = split.stake;
      s.fishId = world.spawn({ owner: `seat:${seats.indexOf(s)}`, name: s.style.name, skin: 0, bot: false, coins: split.stake }).id;
    }
    const f = s.fishId ? world.fish.get(s.fishId) : undefined;
    if (f && world.time >= s.nextThink) {
      s.nextThink = world.time + s.style.reaction;
      const d = decide(f, s.style);
      world.setInput(f.id, d.angle, d.boost, d.cash);
    }
  }
  bots.maintain();
  bots.think();
  rainAcc += DT;
  if (rainAcc >= 0.1) {
    rainAcc = 0;
    for (let i = 0; i < 4 && pot >= orb && world.pellets.size < RULES.rainTargetOrbs; i++) {
      pot -= orb;
      rained += orb;
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * RULES.arenaRadius * 0.94;
      world.dropPellet(Math.cos(a) * r, Math.sin(a) * r, orb);
    }
  }
  for (const e of world.step(DT)) {
    if (e.type === "death") {
      if (bots.has(e.id)) bots.onDeath(e.id);
      const victim = seats.find((s) => s.fishId === e.id);
      if (victim) {
        victim.fishId = 0;
        victim.eaten += 1;
      }
      const killer = seats.find((s) => s.fishId === e.killerId);
      if (killer) killer.kills += 1;
    } else if (e.type === "extracted") {
      const s = seats.find((x) => x.fishId === e.id);
      if (s) {
        s.fishId = 0;
        s.taken += e.coins;
        s.cashed += 1;
      }
    }
  }
  potMin = Math.min(potMin, pot);
}

// Whoever is still swimming keeps what they hold: count it as theirs.
let swimming = 0;
for (const s of seats) {
  const f = s.fishId ? world.fish.get(s.fishId) : undefined;
  if (f) swimming += f.coins;
}

const eth = (c: number) => coinsToEth(Math.round(c), 4).padStart(9);
console.log(`\n${MINUTES} minutes, entry ${coinsToEth(ENTRY)} ETH, fee ${RULES.feeBps / 100}% (half to the pot, half to the treasury)\n`);
console.log("player                   lives  eaten  cashed  kills   paid in    taken out        net");
let paid = 0;
let taken = 0;
for (const s of seats) {
  const f = s.fishId ? world.fish.get(s.fishId) : undefined;
  const holding = f ? f.coins : 0;
  const net = s.taken + holding - s.paid;
  paid += s.paid;
  taken += s.taken;
  console.log(
    `${s.style.name.padEnd(24)} ${String(s.lives).padStart(5)}  ${String(s.eaten).padStart(5)}  ${String(s.cashed).padStart(6)}  ${String(s.kills).padStart(5)} ${eth(s.paid)} ${eth(s.taken + holding)}  ${net >= 0 ? "+" : "-"}${eth(Math.abs(net)).trim()}`,
  );
}
const ocean = world.totalCoins();
console.log(`\nplayers paid in      ${eth(paid)} ETH`);
console.log(`players took out     ${eth(taken)} ETH  (${((taken / Math.max(1, paid)) * 100).toFixed(1)}% of what they paid)`);
console.log(`treasury kept        ${eth(treasury)} ETH  (${((treasury / Math.max(1, paid)) * 100).toFixed(1)}%)`);
console.log(`pot                  ${eth(pot)} ETH  (started at ${coinsToEth(POT_SEED)}, lowest ${coinsToEth(potMin)}, rained ${coinsToEth(rained)})`);
console.log(`still in the ocean   ${eth(ocean)} ETH  (players ${coinsToEth(swimming)}, bots ${coinsToEth(bots.coins())}, orbs ${coinsToEth(world.floorCoins())})`);
const drift = POT_SEED + paid - (taken + treasury + pot + ocean);
console.log(`\nbooks: seed + paid in = took out + treasury + pot + ocean → drift ${drift} coins ${drift === 0 ? "(balanced)" : "(BROKEN)"}`);
process.exit(drift === 0 ? 0 : 1);
