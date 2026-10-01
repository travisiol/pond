import { RULES, WEI_PER_COIN, splitEntry } from "@/shared/rules";
import { World, defaultTiming, type Fish } from "@/shared/sim";
import { Bots } from "@/shared/bots";
import { buildState } from "@/shared/snapshot";
import { encodeState, type ClientMessage, type RosterEntry, type ServerMessage } from "@/shared/protocol";
import { cleanName } from "@/shared/names";

/**
 * The ocean, in the browser, when no server answers or when you ask for
 * practice: the same simulation, the same bots, the same rules, fees and
 * clocks — on play money. It speaks the server's protocol through the
 * WebSocket surface the client already uses, so nothing else in the client
 * knows it is talking to itself.
 *
 * What it is not: the money game. Nothing won or lost here exists, the
 * balance refills itself, there is no wallet and no bank.
 */

const ENTRY = RULES.entryCoins;
const PRACTICE_LOBBY = ENTRY * 5;
const PRACTICE_POT = ENTRY * 60;

export class PracticeArena {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private readonly world = new World((Date.now() & 0xffff) || 1, defaultTiming(1), ENTRY);
  private pot = PRACTICE_POT;
  private readonly bots = new Bots(this.world, {
    count: 16,
    stake: (size) => {
      const stake = Math.floor(splitEntry(ENTRY).stake * size);
      if (this.pot < stake) return 0;
      this.pot -= stake;
      return stake;
    },
    retire: (coins) => {
      this.pot += coins;
    },
  });
  private readonly names = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private myId = 0;
  private lobby = PRACTICE_LOBBY;
  private specX = 0;
  private specY = 0;
  private rainAcc = 0;
  private greeted = false;

  constructor() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = this.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello":
        if (!this.greeted) {
          this.greeted = true;
          this.hello();
        }
        break;
      case "spawn":
        this.spawn(msg.name);
        break;
      case "input":
        if (this.myId) this.world.setInput(this.myId, Number(msg.a), msg.b === 1, msg.c === 1);
        break;
      case "ping":
        this.emit({ t: "pong", n: msg.n, serverTime: this.world.time });
        break;
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: 1000 }));
  }

  // ────────────────────────────── the ocean ─────────────────────────────

  private hello(): void {
    // A running start: the bots have already been at it for a while.
    for (let i = 0; i < 500; i++) this.tick(true);
    this.emit({
      t: "welcome",
      rules: RULES,
      timing: this.world.timing,
      economy: { entryCoins: ENTRY, feeBps: RULES.feeBps, feePotShareBps: RULES.feePotShareBps },
      live: false,
      liveNote: "Practice ocean: same rules, bots, play money. Nothing here is real ETH.",
      practice: true,
      arena: null,
      chainId: 4663,
      devFaucet: false,
      you: this.you(),
      fishId: null,
    });
    this.emit({ t: "roster", full: true, add: this.roster() });
    // Step by the wall clock: browser timers fire late, and a late timer
    // must not make the ocean run slow.
    const dt = 1 / RULES.tickHz;
    let last = performance.now();
    let owed = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      owed = Math.min(owed + (now - last) / 1000, dt * 6);
      last = now;
      while (owed >= dt) {
        owed -= dt;
        this.tick(false);
      }
    }, 1000 / RULES.tickHz / 2);
  }

  private spawn(nameRaw: unknown): void {
    if (this.myId && this.world.fish.get(this.myId)?.alive) return this.emit({ t: "error", message: "You are already in the water." });
    if (this.lobby < ENTRY) this.lobby = PRACTICE_LOBBY;
    const name = cleanName(nameRaw) ?? "You";
    const split = splitEntry(ENTRY);
    this.lobby -= ENTRY;
    // Play money: the whole fee goes back to the practice pot.
    this.pot += split.fee;
    const f = this.world.spawn({ owner: "practice", name, skin: Math.floor(Math.random() * 10), bot: false, coins: split.stake });
    this.myId = f.id;
    this.names.set(f.id, name);
    this.emit({ t: "roster", add: [{ id: f.id, name, skin: f.skin, bot: false }] });
    this.emit({ t: "spawned", id: f.id, stake: split.stake, fee: split.fee });
    this.emit({ t: "you", you: this.you() });
  }

  private tick(silent: boolean): void {
    const dt = 1 / RULES.tickHz;
    this.bots.maintain();
    this.bots.think();
    const retired = this.bots.takeRetired();
    const events = this.world.step(dt);

    // Rain, from the pot only.
    this.rainAcc += dt;
    if (this.rainAcc >= 0.1) {
      this.rainAcc = 0;
      const orb = Math.max(1, Math.floor(ENTRY * RULES.rainOrbEntryFraction));
      for (let i = 0; i < 4 && this.pot >= orb && this.world.pellets.size < RULES.rainTargetOrbs; i++) {
        this.pot -= orb;
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * RULES.arenaRadius * 0.94;
        this.world.dropPellet(Math.cos(a) * r, Math.sin(a) * r, orb);
      }
    }

    // Resolve every name first: a fish eaten this tick is already gone.
    const named = events.map((e) => ({
      e,
      name: "id" in e ? (this.nameOf(e.id) ?? "?") : "?",
      killerName: e.type === "death" && e.killerId !== null ? this.nameOf(e.killerId) : null,
    }));
    if (!silent && retired.length) this.emit({ t: "roster", remove: retired });
    for (const id of retired) this.names.delete(id);
    for (const { e, name, killerName } of named) {
      if (e.type === "death") {
        if (this.bots.has(e.id)) this.bots.onDeath(e.id);
        const mine = e.id === this.myId;
        if (mine) {
          this.myId = 0;
          this.lobby = Math.max(this.lobby, PRACTICE_LOBBY);
        }
        this.names.delete(e.id);
        if (silent) continue;
        this.emit({ t: "roster", remove: [e.id] });
        this.emit({
          t: "death",
          id: e.id,
          name,
          killerId: e.killerId,
          killerName,
          cause: e.cause,
          coins: e.coins,
          gained: e.gained,
          x: e.x,
          y: e.y,
          mine,
        });
        if (mine) this.emit({ t: "you", you: this.you() });
      } else if (e.type === "extracted") {
        const mine = e.id === this.myId;
        if (mine) {
          this.myId = 0;
          this.lobby += e.coins;
        }
        this.names.delete(e.id);
        if (silent) continue;
        this.emit({ t: "roster", remove: [e.id] });
        this.emit({ t: "extracted", id: e.id, name, coins: e.coins, x: e.x, y: e.y, mine });
        if (mine) this.emit({ t: "you", you: this.you() });
      }
    }
    if (silent) return;

    // Camera: my fish, else the biggest one.
    const me = this.myId ? this.world.fish.get(this.myId) : undefined;
    let camX: number;
    let camY: number;
    if (me && me.alive) {
      camX = me.x;
      camY = me.y;
    } else {
      let best: Fish | null = null;
      for (const f of this.world.fish.values()) if (f.alive && (!best || f.coins > best.coins)) best = f;
      this.specX += ((best ? best.x : 0) - this.specX) * 0.06;
      this.specY += ((best ? best.y : 0) - this.specY) * 0.06;
      camX = this.specX;
      camY = this.specY;
    }
    const state = buildState(this.world, { camX, camY, myId: me && me.alive ? me.id : 0 });
    this.onmessage?.(new MessageEvent("message", { data: encodeState(state) }));

    if (this.world.tick % RULES.tickHz === 0) {
      const alive = this.world.aliveFish();
      for (const f of alive) if (!this.names.has(f.id)) this.emit({ t: "roster", add: [this.entry(f)] });
      this.emit({
        t: "board",
        top: alive
          .slice()
          .sort((a, b) => b.coins - a.coins)
          .slice(0, 10)
          .map((f) => ({ id: f.id, name: f.name, coins: f.coins, kills: f.kills })),
        alive: alive.length,
        players: 1,
        floor: this.world.floorCoins(),
        pot: this.pot,
      });
    }
  }

  // ─────────────────────────────── helpers ──────────────────────────────

  private you() {
    return {
      address: "practice",
      name: "You",
      lobbyCoins: this.lobby,
      lobbyWei: (BigInt(this.lobby) * WEI_PER_COIN).toString(),
      claimableWei: "0",
      claimedWei: "0",
    };
  }

  private nameOf(id: number): string | null {
    return this.names.get(id) ?? this.world.fish.get(id)?.name ?? null;
  }

  private entry(f: Fish): RosterEntry {
    this.names.set(f.id, f.name);
    return { id: f.id, name: f.name, skin: f.skin, bot: f.bot };
  }

  private roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const f of this.world.fish.values()) if (f.alive) out.push(this.entry(f));
    return out;
  }

  private emit(msg: ServerMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(msg) }));
  }
}
