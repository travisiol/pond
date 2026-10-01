/**
 * The ocean, as pure arithmetic. No sockets, no clock, no chain: the server
 * feeds it inputs and calls `step(dt)`, the headless test does the same, and
 * the browser runs it for the practice ocean. Every coin that enters through
 * `spawn` or `dropPellet` is either inside a fish, lying in the water as an
 * orb, or has left through an `extracted` or `retired` event. `totalCoins()`
 * is the invariant the tests hold the world to after every step.
 */
import {
  RULES,
  canEat,
  lengthFor,
  magnetRadiusFor,
  radiusFor,
  speedFor,
  turnRateFor,
} from "./rules";
import { dist, makeRng, turnToward } from "./geometry";

export type DeathCause = "eaten";

export interface Fish {
  id: number;
  /** Wallet address (lowercase) for players, `bot:<n>` for bots. */
  owner: string;
  name: string;
  skin: number;
  bot: boolean;
  x: number;
  y: number;
  /** Heading in radians. */
  angle: number;
  targetAngle: number;
  wantBoost: boolean;
  wantCash: boolean;
  /** Sprint actually applied this tick (coins, cash-out and orphan rules can veto it). */
  boosting: boolean;
  /** True while the cash-out meter is filling. */
  cashing: boolean;
  coins: number;
  spawnedAt: number;
  shieldUntil: number;
  shedAcc: number;
  /** Seconds accumulated toward cashing out. */
  cash: number;
  /** World time the owner's socket dropped, or null while connected. */
  orphanedAt: number | null;
  kills: number;
  alive: boolean;
}

export interface Pellet {
  id: number;
  x: number;
  y: number;
  value: number;
}

export type SimEvent =
  | {
      type: "death";
      id: number;
      owner: string;
      killerId: number | null;
      cause: DeathCause;
      /** What the fish held when it died. */
      coins: number;
      /** How much of that went straight into the eater. */
      gained: number;
      x: number;
      y: number;
    }
  | { type: "extracted"; id: number; owner: string; coins: number; x: number; y: number }
  | { type: "pickup"; id: number; pelletId: number; value: number }
  | { type: "shed"; id: number; pelletId: number; value: number };

/**
 * The clocks the ocean runs on. They default to the published rules; a
 * local server may shorten them (TIME_SCALE) so a test does not wait
 * 45 seconds to cash out. Movement is never scaled — only waiting.
 */
export interface Timing {
  spawnShieldSeconds: number;
  minStaySeconds: number;
  cashSeconds: number;
}

export function defaultTiming(scale = 1): Timing {
  return {
    spawnShieldSeconds: RULES.spawnShieldSeconds * scale,
    minStaySeconds: RULES.minStaySeconds * scale,
    cashSeconds: RULES.cashSeconds * scale,
  };
}

export interface SpawnOptions {
  owner: string;
  name: string;
  skin: number;
  bot: boolean;
  coins: number;
  /** Optional fixed position (tests). */
  at?: { x: number; y: number; angle: number };
}

export function pelletRadius(value: number, entry: number): number {
  return 5 + 26 * Math.sqrt(Math.min(1, Math.max(0, value) / entry));
}

const PELLET_CELL = 80;

function cellKey(cx: number, cy: number): number {
  return (cx + 32768) * 65536 + (cy + 32768);
}

export class World {
  time = 0;
  tick = 0;
  readonly fish = new Map<number, Fish>();
  readonly pellets = new Map<number, Pellet>();
  private nextFishId = 1;
  private nextPelletId = 1;
  private readonly pelletGrid = new Map<number, Set<number>>();
  private readonly rng: () => number;
  readonly timing: Timing;
  /** The price of one life in coins. Size is measured against it. */
  readonly entry: number;

  constructor(seed = 1, timing: Timing = defaultTiming(), entry: number = RULES.entryCoins) {
    this.rng = makeRng(seed);
    this.timing = timing;
    this.entry = entry;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  spawn(opts: SpawnOptions): Fish {
    const coins = Math.max(0, Math.floor(opts.coins));
    const at = opts.at ?? this.findSpawnPoint();
    const fish: Fish = {
      id: this.nextFishId++,
      owner: opts.owner,
      name: opts.name,
      skin: opts.skin,
      bot: opts.bot,
      x: at.x,
      y: at.y,
      angle: at.angle,
      targetAngle: at.angle,
      wantBoost: false,
      wantCash: false,
      boosting: false,
      cashing: false,
      coins,
      spawnedAt: this.time,
      shieldUntil: this.time + this.timing.spawnShieldSeconds,
      shedAcc: 0,
      cash: 0,
      orphanedAt: null,
      kills: 0,
      alive: true,
    };
    this.fish.set(fish.id, fish);
    return fish;
  }

  /** Takes a fish out without dropping anything. Returns its coins for the ledger. */
  remove(id: number): number {
    const f = this.fish.get(id);
    if (!f) return 0;
    f.alive = false;
    this.fish.delete(id);
    const coins = f.coins;
    f.coins = 0;
    return coins;
  }

  setInput(id: number, angle: number, boost: boolean, cash: boolean): void {
    const f = this.fish.get(id);
    if (!f || !f.alive) return;
    if (Number.isFinite(angle)) f.targetAngle = angle;
    f.wantBoost = boost;
    f.wantCash = cash;
  }

  /** Puts `value` coins in the water. Merges into an orb lying right there. */
  dropPellet(x: number, y: number, value: number): Pellet {
    const v = Math.floor(value);
    if (v <= 0) throw new Error("dropPellet: value must be a positive whole number");
    // Keep orbs inside the wall.
    const d = Math.hypot(x, y);
    const max = RULES.arenaRadius - 20;
    if (d > max) {
      x = (x / d) * max;
      y = (y / d) * max;
    }
    const near = this.pelletsNear(x, y, 8);
    if (near.length > 0) {
      near[0].value += v;
      return near[0];
    }
    const pellet: Pellet = { id: this.nextPelletId++, x, y, value: v };
    this.pellets.set(pellet.id, pellet);
    this.gridAdd(pellet);
    if (this.pellets.size > RULES.maxPellets) this.compactPellets();
    return pellet;
  }

  /** Every coin the ocean holds right now: in fish plus in the water. */
  totalCoins(): number {
    let sum = 0;
    for (const f of this.fish.values()) sum += f.coins;
    for (const p of this.pellets.values()) sum += p.value;
    return sum;
  }

  floorCoins(): number {
    let sum = 0;
    for (const p of this.pellets.values()) sum += p.value;
    return sum;
  }

  aliveFish(): Fish[] {
    return [...this.fish.values()].filter((f) => f.alive);
  }

  /** True once a fish has been alive long enough to start cashing out. */
  canCash(f: Fish): boolean {
    return !f.bot && this.time - f.spawnedAt >= this.timing.minStaySeconds;
  }

  findSpawnPoint(): { x: number; y: number; angle: number } {
    let best = { x: 0, y: 0, angle: 0 };
    let bestClear = -1;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = this.rng() * Math.PI * 2;
      const rr = Math.sqrt(this.rng()) * RULES.arenaRadius * 0.85;
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      let clear = Infinity;
      for (const f of this.fish.values()) {
        if (!f.alive) continue;
        // Only fish big enough to matter count as danger.
        clear = Math.min(clear, dist(x, y, f.x, f.y) - lengthFor(f.coins, this.entry));
      }
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y, angle: this.rng() * Math.PI * 2 - Math.PI };
      }
      if (clear > 700) break;
    }
    return best;
  }

  // ─────────────────────────────── step ────────────────────────────────

  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    this.time += dt;
    this.tick += 1;

    for (const f of this.fish.values()) {
      if (f.alive) this.move(f, dt, events);
    }

    this.eat(events);

    for (const f of this.fish.values()) {
      if (!f.alive) continue;
      this.pickup(f, dt, events);
      this.cashOut(f, dt, events);
    }
    return events;
  }

  private move(f: Fish, dt: number, events: SimEvent[]): void {
    const orphan = f.orphanedAt !== null;
    // A dropped socket cashes out on its own: same wait, same risk.
    f.cashing = (f.wantCash || orphan) && this.canCash(f);
    f.angle = turnToward(f.angle, orphan ? f.angle : f.targetAngle, turnRateFor(f.coins, this.entry) * dt);

    const minBoost = this.entry * RULES.boostMinEntryFraction;
    f.boosting = f.wantBoost && !orphan && !f.cashing && f.coins >= minBoost;
    let speed = speedFor(f.coins, this.entry);
    if (f.boosting) speed *= RULES.boostFactor;
    if (f.cashing) speed *= RULES.cashSlow;

    f.x += Math.cos(f.angle) * speed * dt;
    f.y += Math.sin(f.angle) * speed * dt;

    // The wall stops you and turns you along it.
    const r = radiusFor(f.coins, this.entry);
    const d = Math.hypot(f.x, f.y);
    const max = RULES.arenaRadius - r;
    if (d > max) {
      f.x = (f.x / d) * max;
      f.y = (f.y / d) * max;
      if (orphan || f.bot) f.angle = Math.atan2(-f.y, -f.x) + (this.rng() - 0.5);
    }

    if (f.boosting) {
      f.shedAcc += dt;
      while (f.shedAcc >= RULES.boostShedInterval) {
        f.shedAcc -= RULES.boostShedInterval;
        const shed = Math.max(1, Math.floor(f.coins * RULES.boostShedRate));
        if (f.coins - shed < minBoost) {
          f.boosting = false;
          break;
        }
        f.coins -= shed;
        const back = lengthFor(f.coins, this.entry) * 0.6;
        const pellet = this.dropPellet(
          f.x - Math.cos(f.angle) * back + (this.rng() - 0.5) * 10,
          f.y - Math.sin(f.angle) * back + (this.rng() - 0.5) * 10,
          shed,
        );
        events.push({ type: "shed", id: f.id, pelletId: pellet.id, value: shed });
      }
    } else {
      f.shedAcc = 0;
    }
  }

  /**
   * Big fish swallow small fish. Decided on the positions everyone ended
   * the tick at; a fish can only be eaten once, by the biggest mouth on it.
   */
  private eat(events: SimEvent[]): void {
    const alive: Fish[] = [];
    for (const f of this.fish.values()) if (f.alive && this.time >= f.shieldUntil) alive.push(f);
    alive.sort((a, b) => b.coins - a.coins);
    for (const eater of alive) {
      if (!eater.alive) continue;
      const len = lengthFor(eater.coins, this.entry);
      const mx = eater.x + Math.cos(eater.angle) * len * 0.3;
      const my = eater.y + Math.sin(eater.angle) * len * 0.3;
      const gape = radiusFor(eater.coins, this.entry) * 0.9;
      for (const prey of alive) {
        if (prey === eater || !prey.alive || !canEat(eater.coins, prey.coins)) continue;
        if (dist(mx, my, prey.x, prey.y) > gape + radiusFor(prey.coins, this.entry) * 0.6) continue;
        this.swallow(eater, prey, events);
      }
    }
  }

  private swallow(eater: Fish, prey: Fish, events: SimEvent[]): void {
    const coins = prey.coins;
    const gained = Math.floor((coins * RULES.eatGainBps) / 10_000);
    prey.alive = false;
    this.fish.delete(prey.id);
    prey.coins = 0;
    eater.coins += gained;
    eater.kills += 1;
    this.scatter(prey.x, prey.y, coins - gained, lengthFor(coins, this.entry) * 0.6);
    events.push({
      type: "death",
      id: prey.id,
      owner: prey.owner,
      killerId: eater.id,
      cause: "eaten",
      coins,
      gained,
      x: prey.x,
      y: prey.y,
    });
  }

  /** Drops exactly `coins` around a point, in a handful of orbs. */
  scatter(x: number, y: number, coins: number, spread: number): void {
    if (coins <= 0) return;
    const count = Math.min(RULES.eatScatterOrbs, coins);
    const base = Math.floor(coins / count);
    let rem = coins - base * count;
    for (let i = 0; i < count; i++) {
      let v = base;
      if (rem > 0) {
        v += 1;
        rem -= 1;
      }
      const a = (i / count) * Math.PI * 2 + this.rng();
      const d = spread * (0.35 + this.rng() * 0.65);
      this.dropPellet(x + Math.cos(a) * d, y + Math.sin(a) * d, v);
    }
  }

  /**
   * The magnet. Every orb within reach of the mouth is pulled straight at
   * it, faster than the fish can swim, and swallowed the moment it touches.
   * Orbs move; coins never appear or vanish here.
   */
  private pickup(f: Fish, dt: number, events: SimEvent[]): void {
    const r = radiusFor(f.coins, this.entry);
    const len = lengthFor(f.coins, this.entry);
    const mx = f.x + Math.cos(f.angle) * len * 0.3;
    const my = f.y + Math.sin(f.angle) * len * 0.3;
    const magnet = magnetRadiusFor(f.coins, this.entry);
    const near = this.pelletsNear(mx, my, magnet + 32);
    for (const p of near) {
      const pr = pelletRadius(p.value, this.entry);
      const d = dist(mx, my, p.x, p.y);
      if (d > magnet + pr) continue;
      const touch = r * 0.6 + pr + RULES.pickupSlack;
      if (d > touch) {
        const stepLen = Math.min(RULES.magnetSpeed * dt, d - touch * 0.5);
        this.movePellet(p, p.x + ((mx - p.x) / d) * stepLen, p.y + ((my - p.y) / d) * stepLen);
        if (dist(mx, my, p.x, p.y) > touch) continue;
      }
      f.coins += p.value;
      this.gridRemove(p);
      this.pellets.delete(p.id);
      events.push({ type: "pickup", id: f.id, pelletId: p.id, value: p.value });
    }
  }

  private cashOut(f: Fish, dt: number, events: SimEvent[]): void {
    if (f.cashing) {
      f.cash += dt;
      if (f.cash >= this.timing.cashSeconds) {
        f.alive = false;
        this.fish.delete(f.id);
        events.push({ type: "extracted", id: f.id, owner: f.owner, coins: f.coins, x: f.x, y: f.y });
        f.coins = 0;
      }
    } else if (f.cash > 0) {
      f.cash = Math.max(0, f.cash - dt * RULES.cashDrainFactor);
    }
  }

  // ─────────────────────────── pellet grid ─────────────────────────────

  private movePellet(p: Pellet, x: number, y: number): void {
    this.gridRemove(p);
    p.x = x;
    p.y = y;
    this.gridAdd(p);
  }

  private gridAdd(p: Pellet): void {
    const key = cellKey(Math.floor(p.x / PELLET_CELL), Math.floor(p.y / PELLET_CELL));
    let bucket = this.pelletGrid.get(key);
    if (!bucket) {
      bucket = new Set();
      this.pelletGrid.set(key, bucket);
    }
    bucket.add(p.id);
  }

  private gridRemove(p: Pellet): void {
    const key = cellKey(Math.floor(p.x / PELLET_CELL), Math.floor(p.y / PELLET_CELL));
    const bucket = this.pelletGrid.get(key);
    if (bucket) {
      bucket.delete(p.id);
      if (bucket.size === 0) this.pelletGrid.delete(key);
    }
  }

  pelletsNear(x: number, y: number, radius: number): Pellet[] {
    const out: Pellet[] = [];
    const c0x = Math.floor((x - radius) / PELLET_CELL);
    const c1x = Math.floor((x + radius) / PELLET_CELL);
    const c0y = Math.floor((y - radius) / PELLET_CELL);
    const c1y = Math.floor((y + radius) / PELLET_CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.pelletGrid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = this.pellets.get(id);
          if (p && dist(x, y, p.x, p.y) <= radius) out.push(p);
        }
      }
    }
    return out;
  }

  /** Orbs inside an axis-aligned box — what a client's viewport needs. */
  pelletsInRect(x0: number, y0: number, x1: number, y1: number): Pellet[] {
    const out: Pellet[] = [];
    const c0x = Math.floor(x0 / PELLET_CELL);
    const c1x = Math.floor(x1 / PELLET_CELL);
    const c0y = Math.floor(y0 / PELLET_CELL);
    const c1y = Math.floor(y1 / PELLET_CELL);
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket = this.pelletGrid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const p = this.pellets.get(id);
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) out.push(p);
        }
      }
    }
    return out;
  }

  /** Folds the smallest orbs into a neighbour so the water never fills without bound. */
  private compactPellets(): void {
    const sorted = [...this.pellets.values()].sort((a, b) => a.value - b.value);
    const victims = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
    for (const v of victims) {
      if (!this.pellets.has(v.id)) continue;
      const near = this.pelletsNear(v.x, v.y, PELLET_CELL * 1.5).filter((p) => p.id !== v.id);
      let target: Pellet | undefined = near[0];
      for (const p of near) if (p.value > (target?.value ?? -1)) target = p;
      if (!target) {
        for (const p of this.pellets.values()) {
          if (p.id !== v.id) {
            target = p;
            break;
          }
        }
      }
      if (!target) break;
      target.value += v.value;
      this.gridRemove(v);
      this.pellets.delete(v.id);
    }
  }
}
