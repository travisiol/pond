/**
 * Fish the ocean plays itself, so the first person in never lands in empty
 * water. They are real fish: they eat, they get eaten and drop what they
 * carried. What they spawn with is whatever `stake()` hands them — on the
 * server that is coins drawn from the pot (none when the pot is dry), in the
 * browser's practice ocean it is play money. They never cash out: a bot
 * that has grown too rich swims off and `retire()` gives everything it
 * held back to the pot, so nothing ever leaves through a bot.
 *
 * Pure: no clock, no database, no sockets.
 */
import { RULES, canEat, lengthFor } from "./rules";
import { dist } from "./geometry";
import type { Fish, World } from "./sim";
import { BOT_NAMES, skinForIndex } from "./names";

export interface BotOptions {
  /** How many to keep alive. */
  count: number;
  /**
   * Coins for the next bot, given how big it should be relative to a
   * player's starting shark (0.5 = half, 2 = double). Returns what the pot
   * could actually pay. Called at each spawn.
   */
  stake: (size: number) => number;
  /** Receives the coins of a bot that retires. */
  retire: (coins: number) => void;
}

interface Mind {
  nextThink: number;
  /** 0 timid .. 1 bold. */
  bold: number;
  wanderX: number;
  wanderY: number;
}

export class Bots {
  private readonly minds = new Map<number, Mind>();
  private readonly retired: number[] = [];
  private nameIndex = 0;
  private lastSpawnAt = -10;
  private serial = 0;
  private seed = 12345;

  constructor(
    private readonly world: World,
    private readonly opts: BotOptions,
  ) {}

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  has(id: number): boolean {
    return this.minds.has(id);
  }

  count(): number {
    return this.minds.size;
  }

  /** Coins currently carried by bots. */
  coins(): number {
    let sum = 0;
    for (const id of this.minds.keys()) sum += this.world.fish.get(id)?.coins ?? 0;
    return sum;
  }

  onDeath(id: number): void {
    this.minds.delete(id);
  }

  /** Ids of bots that retired since the last call, for the roster. */
  takeRetired(): number[] {
    return this.retired.splice(0);
  }

  /** Keeps `count` bots alive, one spawn every half second at most, and retires the rich. */
  maintain(): void {
    const cap = this.world.entry * RULES.botRetireEntries;
    for (const id of [...this.minds.keys()]) {
      const f = this.world.fish.get(id);
      if (f && f.alive && f.coins >= cap) {
        this.opts.retire(this.world.remove(id));
        this.minds.delete(id);
        this.retired.push(id);
      }
    }
    if (this.minds.size >= this.opts.count) return;
    if (this.world.time - this.lastSpawnAt < 0.5) return;
    this.lastSpawnAt = this.world.time;
    // Mostly small fry, some your size, a few big ones.
    const r = this.rand();
    const size = r < 0.5 ? 0.45 + this.rand() * 0.35 : r < 0.82 ? 0.9 + this.rand() * 0.45 : 1.6 + this.rand() * 1.1;
    const coins = Math.max(0, Math.floor(this.opts.stake(size)));
    // A bot with nothing is a fish nobody can gain from: skip until the pot can pay.
    if (coins <= 0) return;
    const name = BOT_NAMES[this.nameIndex % BOT_NAMES.length];
    this.nameIndex += 1;
    this.serial += 1;
    const f = this.world.spawn({ owner: `bot:${this.serial}`, name, skin: skinForIndex(this.serial + 4), bot: true, coins });
    this.minds.set(f.id, {
      nextThink: this.world.time,
      bold: this.rand(),
      wanderX: f.x,
      wanderY: f.y,
    });
  }

  /** One decision per bot every 0.15–0.35 s. */
  think(): void {
    const now = this.world.time;
    for (const [id, mind] of this.minds) {
      const f = this.world.fish.get(id);
      if (!f || !f.alive) {
        this.minds.delete(id);
        continue;
      }
      if (now < mind.nextThink) continue;
      mind.nextThink = now + 0.15 + this.rand() * 0.2;
      const { angle, boost } = this.decide(f, mind);
      this.world.setInput(id, angle, boost, false);
    }
  }

  private decide(f: Fish, mind: Mind): { angle: number; boost: boolean } {
    const w = this.world;
    const len = lengthFor(f.coins, w.entry);
    let threat: Fish | null = null;
    let threatD = Infinity;
    let prey: Fish | null = null;
    let preyScore = 0;
    for (const o of w.fish.values()) {
      if (o === f || !o.alive) continue;
      const d = dist(f.x, f.y, o.x, o.y);
      if (canEat(o.coins, f.coins)) {
        const reach = 190 + lengthFor(o.coins, w.entry) * 1.3 - mind.bold * 70;
        if (d < reach && d < threatD) {
          threat = o;
          threatD = d;
        }
      } else if (canEat(f.coins, o.coins) && w.time >= o.shieldUntil) {
        const sight = 320 + len + mind.bold * 180;
        if (d < sight) {
          const score = o.coins / (90 + d);
          if (score > preyScore) {
            prey = o;
            preyScore = score;
          }
        }
      }
    }
    // Stay off the wall.
    const edge = Math.hypot(f.x, f.y);
    if (edge > RULES.arenaRadius - 260) {
      const home = Math.atan2(-f.y, -f.x);
      if (!threat) return { angle: home + (this.rand() - 0.5) * 0.8, boost: false };
    }
    if (threat) {
      return {
        angle: Math.atan2(f.y - threat.y, f.x - threat.x) + (this.rand() - 0.5) * 0.5,
        boost: threatD < 170 && f.coins > w.entry * 0.8,
      };
    }
    if (prey) {
      const d = dist(f.x, f.y, prey.x, prey.y);
      return {
        angle: Math.atan2(prey.y - f.y, prey.x - f.x),
        boost: mind.bold > 0.6 && d < 200 && f.coins > w.entry * 1.5,
      };
    }
    // Forage: the richest orb nearby, else wander.
    let best: { x: number; y: number } | null = null;
    let bestScore = 0;
    for (const p of w.pelletsNear(f.x, f.y, 420)) {
      const score = p.value / (60 + dist(f.x, f.y, p.x, p.y));
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) return { angle: Math.atan2(best.y - f.y, best.x - f.x), boost: false };
    if (dist(f.x, f.y, mind.wanderX, mind.wanderY) < 120) {
      const a = this.rand() * Math.PI * 2;
      const r = Math.sqrt(this.rand()) * RULES.arenaRadius * 0.8;
      mind.wanderX = Math.cos(a) * r;
      mind.wanderY = Math.sin(a) * r;
    }
    return { angle: Math.atan2(mind.wanderY - f.y, mind.wanderX - f.x), boost: false };
  }
}
