import type { WebSocket } from "ws";
import { RULES } from "../../web/src/shared/rules";
import { World, defaultTiming, type Fish, type SimEvent } from "../../web/src/shared/sim";
import { encodeState, type BoardRow, type RosterEntry, type ServerMessage, type YouState } from "../../web/src/shared/protocol";
import { buildState } from "../../web/src/shared/snapshot";
import { cleanName, shortAddress, skinForIndex } from "../../web/src/shared/names";
import { chainConfigured, config, entrySplit, eth, liveNote, rainOrbCoins, treasuryAccount } from "./config";
import * as db from "./db";
import { makeBots, type Bots } from "./bots";

/**
 * The ocean's referee: one World stepped twenty times a second, every
 * socket that watches or plays it, and the seam between the simulation's
 * whole coins and the ledger's wei. Nothing a client sends is trusted
 * beyond "which way", "sprint or not" and "I am holding cash-out".
 */

export interface Client {
  ws: WebSocket;
  ip: string;
  /** Signed-in wallet, lowercase, or null for a spectator. */
  address: string | null;
  fishId: number | null;
  camX: number;
  camY: number;
  inputs: number;
  inputWindow: number;
}

const INPUTS_PER_SECOND = 40;

export class Arena {
  readonly world: World;
  readonly bots: Bots;
  readonly clients = new Set<Client>();
  /** address → fish id, one fish per wallet. */
  private readonly owners = new Map<string, number>();
  private readonly names = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private rainAcc = 0;
  private lastCheckpointAt = 0;
  private skinCounter = 0;
  private specX = 0;
  private specY = 0;
  private stopped = false;

  constructor() {
    this.world = new World(Date.now() & 0xffff, defaultTiming(config.timeScale), config.entryCoins);
    this.bots = makeBots(this.world, (coins) => this.botRetired(coins));
  }

  // ─────────────────────────────── loop ────────────────────────────────

  start(): void {
    const dt = 1 / RULES.tickHz;
    // Timers fire late (coarse OS clocks, a busy machine). Step by the wall
    // clock instead of by timer fires, or the ocean runs slower than real
    // time and every wait in the rules gets longer than it says.
    let last = performance.now();
    let owed = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      owed += (now - last) / 1000;
      last = now;
      // After a long stall, drop the backlog rather than fast-forward the game.
      if (owed > dt * 6) owed = dt * 6;
      while (owed >= dt) {
        owed -= dt;
        try {
          this.tickOnce(dt);
        } catch (err) {
          console.error("[ocean] tick failed", err);
        }
      }
    }, 1000 / RULES.tickHz / 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  private tickOnce(dt: number): void {
    this.bots.maintain();
    this.dropRetired();
    this.announceNew();
    this.bots.think();
    const events = this.world.step(dt);
    this.handleEvents(events);
    this.rain(dt);
    this.updateSpectatorCamera();
    for (const c of this.clients) this.sendState(c);
    if (this.world.tick % RULES.tickHz === 0) this.broadcastBoard();
    if (this.world.time - this.lastCheckpointAt >= config.checkpointSeconds) {
      this.lastCheckpointAt = this.world.time;
      this.checkpoint();
    }
  }

  private handleEvents(events: SimEvent[]): void {
    // Resolve every name first, while the roster still knows the fish that just left.
    const named = events.map((e) => ({
      e,
      name: this.nameOf(e.id) ?? "?",
      killerName: e.type === "death" && e.killerId !== null ? this.nameOf(e.killerId) : null,
    }));

    // The ledger first, and all of this tick's cash-outs in one transaction:
    // the coins reach the lobbies in the same commit that takes them out of
    // the crash shadow.
    const credits: { owner: string; coins: number }[] = [];
    let toPot = 0;
    for (const { e } of named) {
      if (e.type !== "extracted") continue;
      // Bots cannot cash out; if one ever did, its coins are the pot's.
      if (this.bots.has(e.id)) toPot += e.coins;
      else credits.push({ owner: e.owner, coins: e.coins });
    }
    if (credits.length > 0 || toPot > 0) db.settle({ credits, toPot, ...this.shadow() });

    for (const { e, name, killerName } of named) {
      if (e.type === "death") {
        // Nothing moves in the ledger: the coins stayed in the ocean, most in the eater, the rest as orbs.
        if (this.bots.has(e.id)) {
          this.bots.onDeath(e.id);
        } else {
          this.owners.delete(e.owner);
          db.recordHistory("death", e.owner, name, e.coins, e.cause + (killerName ? `:${killerName}` : ""));
        }
        this.names.delete(e.id);
        this.broadcast({ t: "roster", remove: [e.id] });
        for (const c of this.clients) {
          const mine = c.fishId === e.id;
          if (mine) c.fishId = null;
          this.send(c, {
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
        }
      } else if (e.type === "extracted") {
        if (this.bots.has(e.id)) {
          this.bots.onDeath(e.id);
        } else {
          this.owners.delete(e.owner);
          db.recordHistory("extract", e.owner, name, e.coins);
        }
        this.names.delete(e.id);
        this.broadcast({ t: "roster", remove: [e.id] });
        for (const c of this.clients) {
          const mine = c.fishId === e.id;
          if (mine) c.fishId = null;
          this.send(c, { t: "extracted", id: e.id, name, coins: e.coins, x: e.x, y: e.y, mine });
        }
        // Every socket of that wallet sees its lobby grow, whether or not it was driving.
        this.refreshYou(e.owner);
      }
    }
  }

  /** A bot grew too rich and swam off: everything it held goes back to the pot. */
  private botRetired(coins: number): void {
    // The world has already let go of the bot, so the shadow written here no longer counts it.
    db.settle({ toPot: coins, ...this.shadow() });
  }

  private dropRetired(): void {
    const gone = this.bots.takeRetired();
    if (gone.length === 0) return;
    for (const id of gone) this.names.delete(id);
    this.broadcast({ t: "roster", remove: gone });
  }

  /**
   * The pot keeps the water stocked: it rains orbs at up to `rainPerMinute`
   * until about `RULES.rainTargetOrbs` lie around, and only while it can pay.
   */
  private rain(dt: number): void {
    if (config.rainPerMinute <= 0) return;
    this.rainAcc += dt;
    const interval = 60 / config.rainPerMinute;
    const orb = rainOrbCoins();
    while (this.rainAcc >= interval) {
      this.rainAcc -= interval;
      if (this.world.pellets.size >= RULES.rainTargetOrbs || !db.drawPot(orb)) {
        this.rainAcc = 0;
        return;
      }
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RULES.arenaRadius * 0.92;
      this.world.dropPellet(Math.cos(a) * r, Math.sin(a) * r, orb);
    }
  }

  private updateSpectatorCamera(): void {
    let best: Fish | null = null;
    for (const f of this.world.fish.values()) {
      if (!f.alive) continue;
      if (!best || f.coins > best.coins) best = f;
    }
    const tx = best ? best.x : 0;
    const ty = best ? best.y : 0;
    this.specX += (tx - this.specX) * 0.12;
    this.specY += (ty - this.specY) * 0.12;
  }

  /** What the ocean holds right now, in the shape the crash shadow stores it. */
  private shadow(): { rows: { owner: string; coins: number }[]; floor: number } {
    const rows: { owner: string; coins: number }[] = [];
    let floor = this.world.floorCoins();
    for (const f of this.world.fish.values()) {
      if (!f.alive) continue;
      if (f.bot) floor += f.coins;
      else rows.push({ owner: f.owner, coins: f.coins });
    }
    return { rows, floor };
  }

  /** Refreshes the crash shadow and checks the books. */
  private checkpoint(): void {
    const live = this.world.totalCoins();
    const shadowed = db.checkpointTotal();
    if (shadowed !== live) {
      console.error(`[books] SHADOW DRIFT: the checkpoint held ${shadowed} coins, the ocean holds ${live}`);
    }
    db.settle(this.shadow());
    const b = db.books(live);
    if (b.drift !== 0n) console.error(`[books] DRIFT ${b.drift.toString()} wei: the ledger and the ocean disagree`);
  }

  // ─────────────────────────────── clients ──────────────────────────────

  connect(ws: WebSocket, ip: string): Client {
    const client: Client = { ws, ip, address: null, fishId: null, camX: 0, camY: 0, inputs: 0, inputWindow: 0 };
    this.clients.add(client);
    return client;
  }

  disconnect(client: Client): void {
    this.clients.delete(client);
    if (client.fishId === null) return;
    const fish = this.world.fish.get(client.fishId);
    // Another socket of the same wallet may already drive the fish.
    const held = [...this.clients].some((c) => c.fishId === client.fishId);
    // Left alone, the fish cashes out by itself: same wait, same risk. The simulation does it.
    if (fish && fish.alive && !held && fish.orphanedAt === null) fish.orphanedAt = this.world.time;
    client.fishId = null;
  }

  /** A socket says who it is: reattach to the fish this wallet still has in the ocean, if any. */
  hello(client: Client, address: string | null): void {
    client.address = address;
    client.fishId = null;
    if (address) {
      const fishId = this.owners.get(address);
      if (fishId !== undefined) {
        const fish = this.world.fish.get(fishId);
        if (fish && fish.alive) {
          fish.orphanedAt = null;
          client.fishId = fishId;
          // Only one socket drives a fish: the newest takes over, older ones watch.
          for (const other of this.clients) if (other !== client && other.fishId === fishId) other.fishId = null;
        }
      }
    }
    this.send(client, {
      t: "welcome",
      rules: RULES,
      timing: this.world.timing,
      economy: { entryCoins: config.entryCoins, feeBps: config.feeBps, feePotShareBps: config.feePotShareBps },
      live: chainConfigured(),
      liveNote: liveNote(),
      practice: config.chain !== "on",
      arena: config.arenaAddress || null,
      chainId: config.chainId,
      devFaucet: config.devFaucet,
      you: address ? this.youState(address) : null,
      fishId: client.fishId,
    });
    this.send(client, { t: "roster", full: true, add: this.rosterEntries() });
  }

  spawnRequest(client: Client, nameRaw: unknown): void {
    if (!client.address) return this.error(client, "Sign in with your wallet to play.");
    const mine = client.fishId !== null && this.world.fish.get(client.fishId)?.alive;
    if (mine || this.owners.has(client.address)) {
      return this.error(client, "You already have a fish in the ocean. Cash out or get eaten before starting another life.");
    }
    const chosen = cleanName(nameRaw);
    if (nameRaw !== undefined && nameRaw !== null && nameRaw !== "" && !chosen) {
      return this.error(client, "Pick a name of 2 to 14 letters or digits. Bot names are taken.");
    }
    if (chosen) db.setName(client.address, chosen);
    const account = db.ensureAccount(client.address);
    const name = chosen ?? account.name ?? shortAddress(client.address);

    const split = entrySplit();
    const treasury = treasuryAccount();
    if (!db.enter(client.address, split, treasury)) {
      const have = db.weiToCoins(account.lobby_wei);
      return this.error(client, `Your balance is ${eth(have)}. One life costs ${eth(config.entryCoins)}: deposit more to play.`);
    }
    this.skinCounter += 1;
    const fish = this.world.spawn({
      owner: client.address,
      name,
      skin: skinForIndex(this.skinCounter),
      bot: false,
      coins: split.stake,
    });
    this.owners.set(client.address, fish.id);
    client.fishId = fish.id;
    db.recordHistory("spawn", client.address, name, split.stake, `fee:${split.fee}`);
    this.broadcast({ t: "roster", add: [this.rosterEntry(fish)] });
    this.send(client, { t: "spawned", id: fish.id, stake: split.stake, fee: split.fee });
    this.refreshYou(client.address);
    if (split.toTreasury > 0 && treasury !== client.address) this.refreshYou(treasury);
  }

  input(client: Client, angle: unknown, boost: unknown, cash: unknown): void {
    if (client.fishId === null) return;
    // 40 inputs a second is plenty for a pointer; more is a script.
    const now = this.world.tick;
    if (now !== client.inputWindow) {
      client.inputWindow = now;
      client.inputs = 0;
    }
    if (++client.inputs > Math.ceil(INPUTS_PER_SECOND / RULES.tickHz) + 1) return;
    const a = Number(angle);
    if (!Number.isFinite(a)) return;
    this.world.setInput(client.fishId, a, boost === 1 || boost === true, cash === 1 || cash === true);
  }

  /** Pushes fresh lobby numbers to every socket of this wallet (after a deposit lands, say). */
  refreshYou(address: string): void {
    for (const c of this.clients) if (c.address === address) this.sendYou(c);
  }

  // ─────────────────────────────── snapshots ────────────────────────────

  private sendState(client: Client): void {
    if (client.ws.readyState !== client.ws.OPEN) return;
    const me = client.fishId !== null ? this.world.fish.get(client.fishId) : undefined;
    if (me && me.alive) {
      client.camX = me.x;
      client.camY = me.y;
    } else {
      client.camX = this.specX;
      client.camY = this.specY;
    }
    const state = buildState(this.world, { camX: client.camX, camY: client.camY, myId: me && me.alive ? me.id : 0 });
    client.ws.send(encodeState(state), { binary: true });
  }

  // ─────────────────────────────── roster ───────────────────────────────

  private nameOf(id: number): string | null {
    return this.names.get(id) ?? this.world.fish.get(id)?.name ?? null;
  }

  private rosterEntry(f: Fish): RosterEntry {
    this.names.set(f.id, f.name);
    return { id: f.id, name: f.name, skin: f.skin, bot: f.bot };
  }

  /** Bots join without a spawn request: tell everyone as soon as one is in the water. */
  private announceNew(): void {
    if (this.names.size >= this.world.fish.size) return;
    const fresh: RosterEntry[] = [];
    for (const f of this.world.fish.values()) if (f.alive && !this.names.has(f.id)) fresh.push(this.rosterEntry(f));
    if (fresh.length > 0) this.broadcast({ t: "roster", add: fresh });
  }

  private rosterEntries(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const f of this.world.fish.values()) if (f.alive) out.push(this.rosterEntry(f));
    return out;
  }

  private broadcastBoard(): void {
    const alive = this.world.aliveFish();
    const top: BoardRow[] = alive
      .slice()
      .sort((a, b) => b.coins - a.coins)
      .slice(0, 10)
      .map((f) => ({ id: f.id, name: f.name, coins: f.coins, kills: f.kills }));
    let players = 0;
    for (const c of this.clients) if (c.address) players++;
    this.broadcast({
      t: "board",
      top,
      alive: alive.length,
      players,
      floor: this.world.floorCoins(),
      pot: db.weiToCoins(db.potWei()),
    });
  }

  // ─────────────────────────────── helpers ──────────────────────────────

  youState(address: string): YouState {
    const a = db.ensureAccount(address);
    return {
      address,
      name: a.name,
      lobbyCoins: db.weiToCoins(a.lobby_wei),
      lobbyWei: a.lobby_wei.toString(),
      claimableWei: a.claimable_wei.toString(),
      claimedWei: a.claimed_wei.toString(),
    };
  }

  private sendYou(client: Client): void {
    if (!client.address) return;
    this.send(client, { t: "you", you: this.youState(client.address) });
  }

  private error(client: Client, message: string): void {
    this.send(client, { t: "error", message });
  }

  send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }

  /** Public counters for /status. All money in whole coins. */
  stats(): {
    alive: number;
    bots: number;
    players: number;
    sockets: number;
    floor: number;
    pot: number;
    oceanCoins: number;
    botCoins: number;
  } {
    let players = 0;
    for (const c of this.clients) if (c.address) players++;
    return {
      alive: this.world.aliveFish().length,
      bots: this.bots.count(),
      players,
      sockets: this.clients.size,
      floor: this.world.floorCoins(),
      pot: db.weiToCoins(db.potWei()),
      oceanCoins: this.world.totalCoins(),
      botCoins: this.bots.coins(),
    };
  }

  /**
   * Graceful stop: every player gets back exactly what their fish holds,
   * the orbs and the bots' coins go back to the pot, and the crash shadow
   * is emptied — all in one transaction. A restart is not a death.
   */
  drain(): { players: number; coins: number; floor: number } {
    this.stop();
    const credits: { owner: string; coins: number }[] = [];
    let coins = 0;
    let floor = this.world.floorCoins();
    for (const f of [...this.world.fish.values()]) {
      if (!f.alive) continue;
      const c = this.world.remove(f.id);
      if (f.bot) floor += c;
      else {
        credits.push({ owner: f.owner, coins: c });
        coins += c;
      }
    }
    this.world.pellets.clear();
    this.owners.clear();
    db.settle({ credits, toPot: floor, rows: [], floor: 0 });
    for (const c of credits) db.recordHistory("refund", c.owner, null, c.coins, "restart");
    return { players: credits.length, coins, floor };
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
