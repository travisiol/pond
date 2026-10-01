import { angleDelta } from "@/shared/geometry";
import { RULES, lengthFor } from "@/shared/rules";
import {
  decodeState,
  type BoardRow,
  type RosterEntry,
  type ServerMessage,
  type StateWire,
  type YouState,
} from "@/shared/protocol";
import { getSession } from "@/lib/api";
import { socketUrl } from "@/lib/site";
import { PracticeArena } from "./practice";

/**
 * The browser's copy of the ocean.
 *
 * Smoothness comes from one idea: the client draws the world a beat and a
 * half behind the server. Every snapshot is queued per fish, stamped with
 * its tick; a render clock, estimated from arrival times and smoothed,
 * walks through the queue and each fish is interpolated between the two
 * samples that bracket it. If a sample is late the fish carries on at its
 * speed for up to a tick and a half; if the tab was asleep the clock snaps.
 *
 * Two audiences read this: the render loop (mutable fields, every frame)
 * and React (through `subscribe` / `version`, only when something a panel
 * shows has changed).
 */

export type Phase = "connecting" | "lobby" | "playing" | "dead" | "cashed";

interface Sample {
  tick: number;
  x: number;
  y: number;
  angle: number;
}

export interface ClientFish {
  id: number;
  name: string;
  skin: number;
  bot: boolean;
  /** Rendered position, interpolated. */
  x: number;
  y: number;
  angle: number;
  /** Units per second, for the tail beat. */
  speed: number;
  coins: number;
  flags: number;
  cash: number;
  queue: Sample[];
  newestTick: number;
  /** Tail-beat phase, so a shoal does not beat in unison. */
  phase: number;
  /** Seconds since first seen, for the fade-in. */
  age: number;
}

export interface ClientPellet {
  id: number;
  x: number;
  y: number;
  value: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  lerpStart: number;
  born: number;
}

/** A floating "+0.00002 ETH" over the water. */
export interface Pop {
  id: number;
  x: number;
  y: number;
  coins: number;
  big: boolean;
  at: number;
}

export interface Burst {
  x: number;
  y: number;
  skin: number;
  coins: number;
  at: number;
}

export interface FeedItem {
  id: number;
  kind: "eaten" | "cash";
  text: string;
  coins: number;
  mine: boolean;
  at: number;
}

export type Welcome = Extract<ServerMessage, { t: "welcome" }>;
export type DeathInfo = Extract<ServerMessage, { t: "death" }>;
export type CashInfo = Extract<ServerMessage, { t: "extracted" }>;

const RENDER_DELAY_TICKS = 1.5;
const MAX_EXTRAPOLATE_TICKS = 1.5;
const STALE_TICKS = 8;
const LERP_SECONDS = 1 / RULES.tickHz;

function nowTicks(): number {
  return (performance.now() / 1000) * RULES.tickHz;
}

export class GameClient {
  phase: Phase = "connecting";
  ws: WebSocket | PracticeArena | null = null;
  /** True while the ocean is the browser's own practice copy. */
  practice = false;
  /** True when the player asked for practice, so we stop looking for a server. */
  wantPractice = false;
  /** False once a real server failed to answer. */
  serverReachable = true;
  welcome: Welcome | null = null;
  you: YouState | null = null;
  myId = 0;
  readonly fish = new Map<number, ClientFish>();
  readonly pellets = new Map<number, ClientPellet>();
  readonly roster = new Map<number, RosterEntry>();
  board: { top: BoardRow[]; alive: number; players: number; floor: number; pot: number } | null = null;
  pops: Pop[] = [];
  bursts: Burst[] = [];
  feed: FeedItem[] = [];
  /** The last shark I ate, for the banner. */
  lastMeal: { id: number; name: string; coins: number; at: number } | null = null;
  lastDeath: DeathInfo | null = null;
  lastCash: CashInfo | null = null;
  /** What this life started with, after the fee. */
  stake = 0;
  /** Most this life has held. */
  peak = 0;
  kills = 0;
  error: string | null = null;
  serverTime = 0;
  camX = 0;
  camY = 0;
  now = 0;
  ping = 0;
  /** Server time my current fish spawned at, for the cash-out countdown. */
  spawnedAt = 0;
  version = 0;
  renderTick = 0;
  /** Coins my fish holds, as drawn. */
  myCoins = 0;
  private clockOffset = NaN;
  private listeners = new Set<() => void>();
  private serial = 0;
  private inputAngle = 0;
  private inputBoost = false;
  private inputCash = false;
  private sentAngle = NaN;
  private sentBoost = false;
  private sentCash = false;
  private sentAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingSentAt = 0;
  private closedByUs = false;
  private pendingGain = 0;
  private pendingGainAt = 0;
  private lastCoins = 0;
  private bumpedAt = 0;

  // ─────────────────────────────── React ────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  // ─────────────────────────────── socket ───────────────────────────────

  /** First connection. `practice` skips the server and opens the practice ocean. */
  start(practice: boolean): void {
    if (practice) this.wantPractice = true;
    this.connect();
  }

  connect(): void {
    this.closedByUs = false;
    this.phase = "connecting";
    this.resetWorld();
    this.bump();
    if (this.wantPractice) return this.openPractice();
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl());
    } catch {
      this.serverReachable = false;
      return this.openPractice();
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.serverReachable = true;
      this.practice = false;
      ws.send(JSON.stringify({ t: "hello", session: getSession() ?? undefined }));
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.onMessage(ev.data);
    };
    ws.onclose = () => {
      // React StrictMode opens two sockets: only the current one may act.
      if (this.ws !== ws) return;
      this.stopPing();
      this.ws = null;
      if (this.closedByUs) return;
      if (!opened) {
        // Nobody home: play the practice ocean instead of an error page.
        this.serverReachable = false;
        this.openPractice();
      } else {
        this.phase = "connecting";
        this.bump();
        setTimeout(() => {
          if (!this.closedByUs && !this.ws) this.connect();
        }, 1500);
      }
    };
    ws.onerror = () => {};
  }

  private openPractice(): void {
    const arena = new PracticeArena();
    this.ws = arena;
    this.practice = true;
    arena.onopen = () => {
      if (this.ws === arena) arena.send(JSON.stringify({ t: "hello" }));
    };
    arena.onmessage = (ev) => {
      if (this.ws === arena) this.onMessage(ev.data);
    };
    this.bump();
  }

  /** Switch between the real server and the practice ocean. */
  setPractice(on: boolean): void {
    if (this.phase === "playing") return;
    this.wantPractice = on;
    this.reconnect();
  }

  reconnect(): void {
    this.close();
    this.connect();
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private resetWorld(): void {
    this.fish.clear();
    this.pellets.clear();
    this.roster.clear();
    this.board = null;
    this.myId = 0;
    this.clockOffset = NaN;
    this.welcome = null;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.pingSentAt = performance.now();
      this.sendJson({ t: "ping", n: 1 });
    }, 4000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private sendJson(msg: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // ─────────────────────────────── actions ──────────────────────────────

  spawn(name?: string): void {
    this.error = null;
    this.sendJson({ t: "spawn", name: name || undefined });
  }

  /** Back to the lobby panel after a death or a cash-out. */
  acknowledge(): void {
    if (this.phase === "dead" || this.phase === "cashed") {
      this.phase = "lobby";
      this.bump();
    }
  }

  setInput(angle: number, boost: boolean, cash: boolean): void {
    this.inputAngle = angle;
    this.inputBoost = boost;
    this.inputCash = cash;
  }

  private flushInput(): void {
    if (this.phase !== "playing") return;
    const now = performance.now();
    const changed =
      this.inputBoost !== this.sentBoost ||
      this.inputCash !== this.sentCash ||
      Number.isNaN(this.sentAngle) ||
      Math.abs(angleDelta(this.sentAngle, this.inputAngle)) > 0.02;
    if (!changed || now - this.sentAt < 45) return;
    this.sentAt = now;
    this.sentAngle = this.inputAngle;
    this.sentBoost = this.inputBoost;
    this.sentCash = this.inputCash;
    this.sendJson({ t: "input", a: Number(this.inputAngle.toFixed(3)), b: this.inputBoost ? 1 : 0, c: this.inputCash ? 1 : 0 });
  }

  // ─────────────────────────────── messages ─────────────────────────────

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      const state = decodeState(data as ArrayBuffer);
      if (state) this.onState(state);
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        this.welcome = msg;
        this.you = msg.you;
        this.myId = msg.fishId ?? 0;
        this.phase = this.myId ? "playing" : "lobby";
        this.bump();
        break;
      case "you":
        this.you = msg.you;
        this.bump();
        break;
      case "roster":
        if (msg.full) this.roster.clear();
        for (const r of msg.add ?? []) {
          this.roster.set(r.id, r);
          const f = this.fish.get(r.id);
          if (f) {
            f.name = r.name;
            f.skin = r.skin;
            f.bot = r.bot;
          }
        }
        for (const id of msg.remove ?? []) this.roster.delete(id);
        break;
      case "spawned":
        this.myId = msg.id;
        this.stake = msg.stake;
        this.peak = msg.stake;
        this.kills = 0;
        this.lastCoins = msg.stake;
        this.myCoins = msg.stake;
        this.pendingGain = 0;
        this.spawnedAt = this.serverTime;
        this.sentAngle = NaN;
        this.phase = "playing";
        this.lastDeath = null;
        this.lastCash = null;
        this.bump();
        break;
      case "death": {
        const victim = this.fish.get(msg.id);
        this.bursts.push({ x: msg.x, y: msg.y, skin: victim?.skin ?? 0, coins: msg.coins, at: this.now });
        this.fish.delete(msg.id);
        if (msg.killerId !== null && msg.killerId === this.myId) {
          this.kills += 1;
          this.lastMeal = { id: ++this.serial, name: msg.name, coins: msg.gained, at: this.now };
          // The coin jump is announced here, not as a trickle of small pops.
          this.lastCoins += msg.gained;
        }
        this.pushFeed({
          kind: "eaten",
          text: msg.killerName ? `${msg.killerName} ate ${msg.name}` : `${msg.name} was eaten`,
          coins: msg.coins,
          mine: msg.mine || msg.killerId === this.myId,
        });
        if (msg.mine) {
          this.lastDeath = msg;
          this.myId = 0;
          this.phase = "dead";
        }
        this.bump();
        break;
      }
      case "extracted":
        this.fish.delete(msg.id);
        this.pushFeed({ kind: "cash", text: `${msg.name} cashed out`, coins: msg.coins, mine: msg.mine });
        if (msg.mine) {
          this.lastCash = msg;
          this.myId = 0;
          this.phase = "cashed";
        }
        this.bump();
        break;
      case "board":
        this.board = msg;
        this.bump();
        break;
      case "error":
        this.error = msg.message;
        this.bump();
        break;
      case "pong":
        this.ping = Math.round(performance.now() - this.pingSentAt);
        break;
    }
  }

  private pushFeed(item: Omit<FeedItem, "id" | "at">): void {
    this.feed.push({ ...item, id: ++this.serial, at: this.now });
    if (this.feed.length > 6) this.feed.shift();
  }

  private onState(s: StateWire): void {
    this.serverTime = s.time;
    // Render clock: how far the server's tick is ahead of our own clock.
    const offset = s.tick - nowTicks();
    if (Number.isNaN(this.clockOffset) || Math.abs(offset - this.clockOffset) > 3) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * 0.05;

    if (s.myId && s.myId !== this.myId) {
      this.myId = s.myId;
      if (this.phase !== "playing") {
        this.phase = "playing";
        this.bump();
      }
    }
    if (!s.myId) {
      this.camX += (s.camX - this.camX) * 0.2;
      this.camY += (s.camY - this.camY) * 0.2;
    }

    for (const w of s.fish) {
      let f = this.fish.get(w.id);
      if (!f) {
        const r = this.roster.get(w.id);
        f = {
          id: w.id,
          name: r?.name ?? "",
          skin: r?.skin ?? w.id % 10,
          bot: r?.bot ?? false,
          x: w.x,
          y: w.y,
          angle: w.angle,
          speed: 0,
          coins: w.coins,
          flags: w.flags,
          cash: w.cash,
          queue: [],
          newestTick: s.tick,
          phase: (w.id * 1.7) % 6.28,
          age: 0,
        };
        this.fish.set(w.id, f);
      }
      f.coins = w.coins;
      f.flags = w.flags;
      f.cash = w.cash;
      f.newestTick = s.tick;
      f.queue.push({ tick: s.tick, x: w.x, y: w.y, angle: w.angle });
      if (f.queue.length > 12) f.queue.shift();
    }
    for (const [id, f] of this.fish) if (s.tick - f.newestTick > STALE_TICKS) this.fish.delete(id);

    // Orbs: glide to where the server says they are; the magnet moves them.
    const seen = new Set<number>();
    for (const p of s.pellets) {
      seen.add(p.id);
      const cur = this.pellets.get(p.id);
      if (!cur) {
        this.pellets.set(p.id, {
          id: p.id,
          x: p.x,
          y: p.y,
          value: p.value,
          fromX: p.x,
          fromY: p.y,
          toX: p.x,
          toY: p.y,
          lerpStart: this.now,
          born: this.now,
        });
      } else {
        cur.value = p.value;
        if (cur.toX !== p.x || cur.toY !== p.y) {
          cur.fromX = cur.x;
          cur.fromY = cur.y;
          cur.toX = p.x;
          cur.toY = p.y;
          cur.lerpStart = this.now;
        }
      }
    }
    for (const id of this.pellets.keys()) if (!seen.has(id)) this.pellets.delete(id);
  }

  // ─────────────────────────────── frame ────────────────────────────────

  /** Advance the drawn world to `now` (seconds). Called once per frame. */
  update(now: number, dt: number): void {
    this.now = now;
    this.flushInput();
    if (!Number.isNaN(this.clockOffset)) this.renderTick = nowTicks() + this.clockOffset - RENDER_DELAY_TICKS;

    for (const f of this.fish.values()) {
      f.age += dt;
      const q = f.queue;
      if (q.length === 0) continue;
      while (q.length >= 2 && q[1].tick <= this.renderTick) q.shift();
      const a = q[0];
      const b = q[1];
      const px = f.x;
      const py = f.y;
      if (b && this.renderTick >= a.tick) {
        const t = Math.min(1, (this.renderTick - a.tick) / Math.max(1, b.tick - a.tick));
        f.x = a.x + (b.x - a.x) * t;
        f.y = a.y + (b.y - a.y) * t;
        f.angle = a.angle + angleDelta(a.angle, b.angle) * t;
      } else if (this.renderTick > a.tick) {
        // Late packet: carry on along the heading for a moment.
        const over = Math.min(MAX_EXTRAPOLATE_TICKS, this.renderTick - a.tick);
        const v = f.speed / RULES.tickHz;
        f.x = a.x + Math.cos(a.angle) * v * over;
        f.y = a.y + Math.sin(a.angle) * v * over;
        f.angle = a.angle;
      } else {
        f.x = a.x;
        f.y = a.y;
        f.angle = a.angle;
      }
      if (dt > 0) {
        const inst = Math.hypot(f.x - px, f.y - py) / dt;
        if (inst < 900) f.speed += (inst - f.speed) * Math.min(1, dt * 8);
      }
      f.phase += dt * (3 + f.speed * 0.035);
    }

    for (const p of this.pellets.values()) {
      const t = Math.min(1, (now - p.lerpStart) / LERP_SECONDS);
      p.x = p.fromX + (p.toX - p.fromX) * t;
      p.y = p.fromY + (p.toY - p.fromY) * t;
    }

    const me = this.myId ? this.fish.get(this.myId) : undefined;
    if (me) {
      this.camX = me.x;
      this.camY = me.y;
      this.myCoins = me.coins;
      if (me.coins > this.peak) this.peak = me.coins;
      // Small gains are gathered for a moment and shown as one number.
      const gain = me.coins - this.lastCoins;
      this.lastCoins = me.coins;
      if (gain > 0) {
        if (this.pendingGain === 0) this.pendingGainAt = now;
        this.pendingGain += gain;
      }
      if (this.pendingGain > 0 && now - this.pendingGainAt > 0.35) {
        const len = lengthFor(me.coins, this.welcome?.economy.entryCoins ?? RULES.entryCoins);
        this.pops.push({
          id: ++this.serial,
          x: me.x + Math.cos(me.angle) * len * 0.4,
          y: me.y + Math.sin(me.angle) * len * 0.4,
          coins: this.pendingGain,
          big: false,
          at: now,
        });
        this.pendingGain = 0;
      }
    }

    while (this.pops.length && now - this.pops[0].at > 1.6) this.pops.shift();
    while (this.bursts.length && now - this.bursts[0].at > 1.2) this.bursts.shift();
    while (this.feed.length && now - this.feed[0].at > 9) {
      this.feed.shift();
      this.bump();
    }
    // The HUD reads live numbers a few times a second.
    if (this.phase === "playing" && now - this.bumpedAt > 0.2) {
      this.bumpedAt = now;
      this.bump();
    }
  }

  /** Seconds until the cash-out opens for my fish, 0 when it is open. */
  cashOpensIn(): number {
    if (!this.welcome) return 0;
    return Math.max(0, this.welcome.timing.minStaySeconds - (this.serverTime - this.spawnedAt));
  }

  entry(): number {
    return this.welcome?.economy.entryCoins ?? RULES.entryCoins;
  }
}
