/**
 * End-to-end proof against the real server. Run from `server/`:
 *
 *   npm run e2e            (PORT=8962 by default)
 *
 * The script starts the server itself, on a throwaway database under the OS
 * temp dir, with CHAIN=off DEV_FAUCET=true DEV_AUTH=true TIME_SCALE=0.1, and
 * restarts it four times on that same database:
 *
 *   A. a quiet ocean (no bots, no rain) where every number is exact:
 *      entry, fee split, steering, takeover, cash-out, self cash-out;
 *      then the process is killed with a fish alive;
 *   B. boot recovery, then a busy ocean (6 bots, rain) and a graceful stop
 *      with a fish alive;
 *   C. after the graceful stop, then killed again with fish, bots and orbs
 *      in the water;
 *   D. boot recovery of that crash.
 *
 * Balances are always measured as deltas, never as absolutes.
 */
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAG_CAN_CASH,
  FLAG_CASHING,
  FLAG_ORPHAN,
  decodeState,
  type FishWire,
  type ServerMessage,
  type StateWire,
} from "../../web/src/shared/protocol";
import { RULES, WEI_PER_COIN, splitEntry } from "../../web/src/shared/rules";
import { angleDelta } from "../../web/src/shared/geometry";

const PORT = Number(process.env.PORT ?? "8962");
const SERVER = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}/ws`;
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIME_SCALE = 0.1;

const ALICE = "0x00000000000000000000000000000000000a11ce";
const SHORT = "0x0000000000000000000000000000000000005407";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wei = (coins: number): bigint => BigInt(coins) * WEI_PER_COIN;

// ─────────────────────────────── the server ───────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), "frenzy-e2e-"));
const DB_PATH = join(tmp, "e2e.sqlite");
let child: ChildProcess | null = null;
let log: string[] = [];
const allLogs: string[] = [];

async function answers(): Promise<boolean> {
  try {
    const res = await fetch(`${SERVER}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

async function boot(extra: Record<string, string>): Promise<void> {
  log = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    DB_PATH,
    CHAIN: "off",
    DEV_FAUCET: "true",
    DEV_AUTH: "true",
    TIME_SCALE: String(TIME_SCALE),
    ENTRY_COINS: "2000",
    FEE_BPS: "1000",
    FEE_POT_SHARE_BPS: "5000",
    TREASURY_ADDRESS: "",
    ARENA_ADDRESS: "",
    PAYOUT_SIGNER_KEY: "",
    ...extra,
  };
  // node directly (not npx), so the pid we kill is the server itself.
  const c = spawnProcess(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child = c;
  const onData = (d: Buffer) => {
    for (const line of d.toString("utf8").split(/\r?\n/)) {
      if (!line) continue;
      log.push(line);
      allLogs.push(line);
    }
  };
  c.stdout!.on("data", onData);
  c.stderr!.on("data", onData);
  for (let i = 0; i < 600; i++) {
    if (c.exitCode !== null) throw new Error(`the server exited at boot:\n${log.join("\n")}`);
    if (await answers()) return;
    await sleep(100);
  }
  throw new Error(`the server did not answer on ${SERVER}:\n${log.join("\n")}`);
}

function exited(c: ChildProcess, ms: number): Promise<boolean> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(true);
  return new Promise((res) => {
    const timer = setTimeout(() => res(false), ms);
    c.once("exit", () => {
      clearTimeout(timer);
      res(true);
    });
  });
}

/** kill -9: no drain, no goodbye. On Windows this is TerminateProcess. */
async function crash(): Promise<void> {
  const c = child;
  if (!c) return;
  c.kill("SIGKILL");
  await exited(c, 5000);
  child = null;
  await sleep(150);
}

// ──────────────────────────────── helpers ────────────────────────────────

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, body: unknown, token?: string): Promise<Reply> {
  const res = await fetch(SERVER + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, token?: string): Promise<Reply> {
  const res = await fetch(SERVER + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function lobbyOf(token: string): Promise<number> {
  return Number((await get("/me", token)).body.lobbyCoins);
}

interface Books {
  deposited: bigint;
  funded: bigint;
  lobby: bigint;
  claimable: bigint;
  pot: bigint;
  ocean: bigint;
  drift: bigint;
  balanced: boolean;
  oceanCoins: number;
  checkpointCoins: number;
  checkpointMatches: boolean;
}

async function books(): Promise<Books> {
  const b = (await get("/books")).body;
  const big = (k: string) => BigInt(String(b[k] ?? "0"));
  return {
    deposited: big("deposited"),
    funded: big("funded"),
    lobby: big("lobby"),
    claimable: big("claimable"),
    pot: big("pot"),
    ocean: big("ocean"),
    drift: big("drift"),
    balanced: b.balanced === true,
    oceanCoins: Number(b.oceanCoins),
    checkpointCoins: Number(b.checkpointCoins),
    checkpointMatches: b.checkpointMatches === true,
  };
}

async function checkBooks(when: string): Promise<Books> {
  const b = await books();
  check(`books: drift is 0 ${when}`, b.balanced && b.drift === 0n, `drift ${b.drift}`);
  check(`books: the crash shadow equals the ocean ${when}`, b.checkpointMatches, `${b.checkpointCoins} vs ${b.oceanCoins}`);
  return b;
}

async function status(): Promise<Record<string, unknown>> {
  return (await get("/status")).body;
}

async function until(what: () => Promise<boolean> | boolean, ms: number, every = 100): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await what()) return true;
    await sleep(every);
  }
  return false;
}

type Msg<T extends ServerMessage["t"]> = Extract<ServerMessage, { t: T }>;

class Socket {
  ws: WebSocket;
  messages: ServerMessage[] = [];
  states: StateWire[] = [];
  frames = 0;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; timer: NodeJS.Timeout }[] = [];

  constructor() {
    this.ws = new WebSocket(WS);
    this.ws.binaryType = "arraybuffer";
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const s = decodeState(ev.data);
        if (s) {
          this.frames++;
          this.states.push(s);
          if (this.states.length > 400) this.states.shift();
        }
        return;
      }
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      this.messages.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i];
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(m);
        }
      }
    };
  }

  static async open(session?: string): Promise<{ s: Socket; welcome: Msg<"welcome"> }> {
    const s = new Socket();
    await new Promise<void>((res, rej) => {
      s.ws.onopen = () => res();
      s.ws.onerror = () => rej(new Error("socket error"));
    });
    s.send(session ? { t: "hello", session } : { t: "hello" });
    const welcome = await s.wait("welcome");
    return { s, welcome };
  }

  send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Forget what has been received so far, so the next `wait` only sees new messages. */
  clear(): void {
    this.messages = [];
  }

  wait<T extends ServerMessage["t"]>(t: T, ms = 5000, extra?: (m: Msg<T>) => boolean): Promise<Msg<T>> {
    const pred = (m: ServerMessage) => m.t === t && (!extra || extra(m as Msg<T>));
    const already = this.messages.find(pred);
    if (already) return Promise.resolve(already as Msg<T>);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        rej(new Error(`timeout waiting for ${t}`));
      }, ms);
      this.waiters.push({ pred, resolve: res as (m: ServerMessage) => void, timer });
    });
  }

  latest(): StateWire | undefined {
    return this.states[this.states.length - 1];
  }

  me(): FishWire | undefined {
    const s = this.latest();
    return s && s.myId ? s.fish.find((f) => f.id === s.myId) : undefined;
  }

  fish(id: number): FishWire | undefined {
    return this.latest()?.fish.find((f) => f.id === id);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((res) => {
      this.ws.onclose = () => res();
      this.ws.close();
      setTimeout(res, 1000);
    });
  }
}

/** Spawns a fish on `s` and returns the `spawned` message. */
async function spawnFish(s: Socket, name?: string): Promise<Msg<"spawned">> {
  s.clear();
  s.send(name ? { t: "spawn", name } : { t: "spawn" });
  const out = await Promise.race([
    s.wait("spawned", 5000),
    s.wait("error", 5000).then((e) => {
      throw new Error(`spawn refused: ${e.message}`);
    }),
  ]);
  return out;
}

// ───────────────────────────────── the run ─────────────────────────────────

async function main(): Promise<void> {
  if (await answers()) throw new Error(`something already answers on ${SERVER}: stop it, or pick another PORT`);

  // ════════════════ A. quiet ocean: every number is exact ════════════════
  await boot({ BOT_COUNT: "0", RAIN_PER_MINUTE: "0" });

  console.log("\n1. Status and a spectator's welcome");
  const st0 = await status();
  const entry = Number(st0.entryCoins);
  const split = splitEntry(entry, Number(st0.feeBps), Number(st0.feePotShareBps));
  check("status answers with the economy", entry === 2000 && st0.feeBps === 1000 && st0.feePotShareBps === 5000, JSON.stringify(st0).slice(0, 300));
  check("status shows pot, floor and the treasury's lobby", typeof st0.pot === "number" && typeof st0.floor === "number" && typeof st0.treasuryLobbyCoins === "number");
  check("status says practice, not live", st0.practice === true && st0.live === false && typeof st0.liveNote === "string");
  check("the split is 1800 stake + 100 pot + 100 treasury", split.stake === 1800 && split.toPot === 100 && split.toTreasury === 100);

  const { s: spec, welcome: w0 } = await Socket.open();
  check("spectator welcome: no wallet, no fish", w0.you === null && w0.fishId === null);
  check("welcome carries the economy", w0.economy.entryCoins === entry && w0.economy.feeBps === 1000 && w0.economy.feePotShareBps === 5000);
  check("welcome.practice is true with CHAIN=off", w0.practice === true && w0.live === false && typeof w0.liveNote === "string");
  check("welcome carries the rules and the scaled clocks", w0.rules.tickHz === RULES.tickHz && Math.abs(w0.timing.minStaySeconds - RULES.minStaySeconds * TIME_SCALE) < 1e-9);
  await spec.wait("roster");
  await sleep(500);
  check("spectator receives binary state frames", spec.frames >= 5, `${spec.frames}`);
  spec.clear();
  spec.send({ t: "spawn" });
  const specErr = await spec.wait("error");
  check("a spectator cannot spawn, and is told to sign in", /sign in/i.test(specErr.message), specErr.message);

  console.log("\n2. Dev sign-in and the faucet");
  check("/me without a session is 401", (await get("/me")).status === 401);
  const auth = await post("/auth/dev", { address: ALICE });
  const token = String(auth.body.token ?? "");
  check("dev session issued", token.length === 64, JSON.stringify(auth.body));
  const lobby0 = await lobbyOf(token);
  const b0 = await books();
  const fa = await post("/dev/faucet", { address: ALICE, eth: "0.01" });
  check("faucet credits the lobby with 0.01 ETH = 10 000 coins", fa.body.lobbyCoins === lobby0 + 10_000 && (await lobbyOf(token)) === lobby0 + 10_000, JSON.stringify(fa.body));
  const bad = await post("/dev/faucet", { address: ALICE, eth: "lots" });
  check("faucet refuses a bad amount with a readable message", bad.status === 400 && /decimal/.test(String(bad.body.error)), JSON.stringify(bad.body));
  const b1 = await checkBooks("after the faucet");
  check("books: deposited grew by exactly 0.01 ETH", b1.deposited - b0.deposited === wei(10_000) && b1.lobby - b0.lobby === wei(10_000));
  let lobby = lobby0 + 10_000;

  console.log("\n3. Spawn refused when the lobby is short");
  const tokenShort = String((await post("/auth/dev", { address: SHORT })).body.token ?? "");
  const short0 = await lobbyOf(tokenShort);
  await post("/dev/faucet", { address: SHORT, eth: "0.0012" });
  const { s: shortSock, welcome: shortWelcome } = await Socket.open(tokenShort);
  const shortHave = shortWelcome.you?.lobbyCoins ?? -1;
  check("the short wallet holds less than one entry", shortHave === short0 + 1200 && shortHave < entry, `${shortHave}`);
  shortSock.send({ t: "spawn", name: "Broke" });
  const shortErr = await shortSock.wait("error");
  check(
    "refused with a sentence the player can act on",
    shortErr.message === "Your balance is 0.0012 ETH. One life costs 0.0020 ETH: deposit more to play.",
    shortErr.message,
  );
  check("the refusal took nothing", (await lobbyOf(tokenShort)) === shortHave && (await books()).oceanCoins === 0);
  await shortSock.close();

  console.log("\n4. Spawn: one entry leaves the lobby; stake, pot and treasury get their parts");
  const st1 = await status();
  const bBefore = await books();
  const { s: a1, welcome: wa } = await Socket.open(token);
  check("signed-in welcome shows my lobby", wa.you?.lobbyCoins === lobby && wa.fishId === null, JSON.stringify(wa.you));
  const sp1 = await spawnFish(a1, "Tester");
  check("spawned reports stake and fee", sp1.stake === split.stake && sp1.fee === split.fee && sp1.id > 0, JSON.stringify(sp1));
  const you1 = await a1.wait("you");
  check("the socket is told the new lobby", you1.you.lobbyCoins === lobby - entry, `${you1.you.lobbyCoins}`);
  check("lobby debited exactly one entry", (await lobbyOf(token)) === lobby - entry);
  lobby -= entry;
  const bAfter = await checkBooks("after the spawn");
  const st2 = await status();
  check("books: the stake is in the ocean", bAfter.ocean - bBefore.ocean === wei(split.stake) && bAfter.oceanCoins === split.stake, `${bAfter.ocean - bBefore.ocean}`);
  check("books: the pot got its half of the fee", bAfter.pot - bBefore.pot === wei(split.toPot), `${bAfter.pot - bBefore.pot}`);
  check(
    "the treasury's lobby got the other half",
    Number(st2.treasuryLobbyCoins) - Number(st1.treasuryLobbyCoins) === split.toTreasury && st2.treasury === "treasury",
    `${st2.treasuryLobbyCoins} (${st2.treasury})`,
  );
  check("books: lobbies went down by entry minus the treasury's part", bBefore.lobby - bAfter.lobby === wei(entry - split.toTreasury));

  console.log("\n5. One fish per wallet");
  a1.clear();
  a1.send({ t: "spawn" });
  const dup = await a1.wait("error");
  check("a second spawn while alive is refused", /already have a fish/i.test(dup.message), dup.message);
  check("and costs nothing", (await lobbyOf(token)) === lobby);

  console.log("\n6. State frames and steering");
  await until(() => a1.me() !== undefined, 2000, 20);
  const first = a1.me();
  const t0 = a1.latest()?.time ?? 0;
  check("binary frames decode and contain my fish with its stake", !!first && first.id === sp1.id && first.coins === split.stake, JSON.stringify(first));
  const start = a1.me()!;
  const aim = Math.atan2(-start.y, -start.x); // toward the middle, away from the wall
  let steer = setInterval(() => a1.send({ t: "input", a: aim, b: 0, c: 0 }), 50);
  await sleep(1200);
  clearInterval(steer);
  const later = a1.me()!;
  const moved = Math.hypot(later.x - start.x, later.y - start.y);
  check("input steers: the position changed", moved > 60, `${moved.toFixed(0)} units`);
  check("input steers: the fish faces where I aimed", Math.abs(angleDelta(later.angle, aim)) < 0.2, `${later.angle.toFixed(2)} vs ${aim.toFixed(2)}`);

  console.log("\n7. A second socket of the same wallet takes over the fish");
  const { s: a2, welcome: wa2 } = await Socket.open(token);
  check("the new socket is handed the fish", wa2.fishId === sp1.id, `${wa2.fishId}`);
  await sleep(300);
  check("the new socket drives it, the old one watches", a2.latest()?.myId === sp1.id && a1.latest()?.myId === 0, `${a2.latest()?.myId} / ${a1.latest()?.myId}`);
  await a1.close();
  await sleep(300);
  const held = a2.me();
  check("closing the old socket does not orphan the fish", !!held && (held.flags & FLAG_ORPHAN) === 0, JSON.stringify(held));

  console.log("\n8. Holding cash-out past the minimum stay");
  a2.clear();
  steer = setInterval(() => a2.send({ t: "input", a: aim + 1.2, b: 0, c: 1 }), 50);
  await sleep(250);
  const early = a2.me();
  const age = (a2.latest()?.time ?? 0) - t0;
  if (early && age < RULES.minStaySeconds * TIME_SCALE - 0.3) {
    check("before the minimum stay, holding cash-out does nothing", (early.flags & (FLAG_CAN_CASH | FLAG_CASHING)) === 0 && early.cash === 0, JSON.stringify(early));
  } else {
    check("before the minimum stay, holding cash-out does nothing", false, `too late to observe (age ${age.toFixed(2)} s)`);
  }
  const out1 = await a2.wait("extracted", 15_000, (m) => m.mine);
  clearInterval(steer);
  const stayed = (a2.latest()?.time ?? 0) - t0;
  check("cashed out with exactly the coins the fish held", out1.coins === split.stake && out1.id === sp1.id, JSON.stringify(out1));
  check("not before minimum stay + hold", stayed >= (RULES.minStaySeconds + RULES.cashSeconds) * TIME_SCALE - 0.16, `${stayed.toFixed(2)} s`);
  const you2 = await a2.wait("you", 3000, (m) => m.you.lobbyCoins !== lobby);
  check("the lobby is credited exactly those coins, no toll", you2.you.lobbyCoins === lobby + out1.coins && (await lobbyOf(token)) === lobby + out1.coins, `${you2.you.lobbyCoins}`);
  lobby += out1.coins;
  const b8 = await checkBooks("after the cash-out");
  check("books: the ocean is empty again", b8.oceanCoins === 0 && b8.ocean === 0n);

  console.log("\n9. Disconnect mid-life: the fish cashes out by itself");
  const sp2 = await spawnFish(a2);
  lobby -= entry;
  check("spawned again", sp2.id > sp1.id && (await lobbyOf(token)) === lobby);
  await sleep(300);
  await a2.close();
  await sleep(400);
  const orphan = spec.fish(sp2.id);
  check("the fish stays in the ocean, marked as left alone", !!orphan && (orphan.flags & FLAG_ORPHAN) !== 0, JSON.stringify(orphan));
  const { s: a3, welcome: wa3 } = await Socket.open(token);
  await sleep(300);
  const back = a3.me();
  check("reconnecting hands the fish back and clears the mark", wa3.fishId === sp2.id && !!back && (back.flags & FLAG_ORPHAN) === 0, JSON.stringify(back));
  spec.clear();
  await a3.close();
  const gone = await spec.wait("extracted", 15_000, (m) => m.id === sp2.id);
  check("left alone again, it cashed out by itself", gone.coins === split.stake && gone.mine === false, JSON.stringify(gone));
  check("and the lobby is credited exactly its coins", (await lobbyOf(token)) === lobby + gone.coins, `${await lobbyOf(token)} vs ${lobby + gone.coins}`);
  lobby += gone.coins;
  await checkBooks("after the self cash-out");
  const hist = (await get("/history?limit=10")).body.recent as { type: string; coins: number }[];
  check("history remembers the spawn and the cash-out", hist.some((h) => h.type === "extract" && h.coins === split.stake) && hist.some((h) => h.type === "spawn"));

  console.log("\n10. The bank without a chain");
  const bank = await post("/cashout", {}, token);
  check("withdrawal refused (409) with a readable reason", bank.status === 409 && /practice ocean.*nothing to deposit or withdraw/.test(String(bank.body.error)), JSON.stringify(bank.body));
  const voucher = await post("/voucher", {}, token);
  check("voucher refused the same way", voucher.status === 409 && typeof voucher.body.error === "string");
  check("the bank without a session is 401", (await post("/cashout", {})).status === 401);
  check("the refusal moved nothing", (await lobbyOf(token)) === lobby);

  console.log("\n11. Crash with a fish alive (process killed, no drain)");
  const { s: a4 } = await Socket.open(token);
  const sp3 = await spawnFish(a4);
  lobby -= entry;
  check("a fish is alive and paid for", sp3.id > 0 && (await lobbyOf(token)) === lobby);
  const potBeforeCrash = (await books()).pot;
  await crash();
  await spec.close();
  await a4.close();

  // ════════════════ B. recovery, then a busy ocean ════════════════
  await boot({ BOT_COUNT: "6" });
  check("boot log reports the recovery", log.some((l) => /recovered the last ocean: 1 player\(s\) refunded 1800 coins/.test(l)), log.join(" | "));
  check("the crashed fish was refunded to its lobby", (await lobbyOf(token)) === lobby + split.stake, `${await lobbyOf(token)} vs ${lobby + split.stake}`);
  lobby += split.stake;
  const bRec = await checkBooks("after the crash recovery");
  check("the pot kept the fees across the crash", bRec.pot <= potBeforeCrash && bRec.pot + bRec.ocean === potBeforeCrash, `${bRec.pot} + ${bRec.ocean} vs ${potBeforeCrash}`);

  console.log("\n12. Pot faucet; bots and rain are paid by the pot");
  const bPot0 = await books();
  const potReply = await post("/dev/faucet-pot", { eth: "0.05" });
  const bPot1 = await books();
  check("pot faucet answers with the pot", potReply.status === 200 && typeof potReply.body.potCoins === "number", JSON.stringify(potReply.body));
  check("books: funded grew by exactly 0.05 ETH", bPot1.funded - bPot0.funded === wei(50_000));
  check("books: that ETH is in the pot or already in the water", bPot1.pot + bPot1.ocean - (bPot0.pot + bPot0.ocean) === wei(50_000));
  const botsIn = await until(async () => Number((await status()).bots) === 6, 12_000, 200);
  const st12 = await status();
  check("six bots are in the ocean", botsIn, `${st12.bots}`);
  check("bots carry pot coins: at least six stakes left the pot", Number(st12.botCoins) > 0 && Number(st12.oceanCoins) >= 6 * split.stake, `bots ${st12.botCoins}, ocean ${st12.oceanCoins}`);
  const { s: spec2 } = await Socket.open();
  const roster = await spec2.wait("roster");
  check("the roster lists the bots", (roster.add ?? []).filter((r) => r.bot).length === 6, JSON.stringify(roster.add));
  const rained = await until(async () => Number((await status()).floor) > 0, 8000, 200);
  check("rain puts orbs in the water", rained);
  const board = await spec2.wait("board", 3000);
  check("the board reports the pot and the floor", typeof board.pot === "number" && typeof board.floor === "number" && board.alive >= 6, JSON.stringify(board).slice(0, 200));
  await checkBooks("with bots and rain running");

  console.log("\n13. A life in the busy ocean");
  let extractedBusy = false;
  for (let attempt = 1; attempt <= 3 && !extractedBusy; attempt++) {
    const stA = await status();
    const { s } = await Socket.open(token);
    const sp = await spawnFish(s);
    lobby -= entry;
    const stB = await status();
    check(`life ${attempt}: lobby −1 entry, treasury +its share`, (await lobbyOf(token)) === lobby && Number(stB.treasuryLobbyCoins) - Number(stA.treasuryLobbyCoins) === split.toTreasury);
    s.clear();
    const drive = setInterval(() => {
      const m = s.me();
      const st = s.latest();
      if (!m || !st) return;
      // Swim at the nearest orb until cash-out opens, then hold it.
      let a = Math.atan2(-m.y, -m.x);
      let best = Infinity;
      for (const p of st.pellets) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d < best) {
          best = d;
          a = Math.atan2(p.y - m.y, p.x - m.x);
        }
      }
      s.send({ t: "input", a, b: 0, c: 1 });
    }, 50);
    const end = await Promise.race([
      s.wait("extracted", 25_000, (m) => m.mine),
      s.wait("death", 25_000, (m) => m.mine),
    ]);
    clearInterval(drive);
    await sleep(150);
    if (end.t === "extracted") {
      extractedBusy = true;
      check(`life ${attempt}: cashed out ${end.coins} coins, lobby credited exactly that`, end.coins >= 1 && (await lobbyOf(token)) === lobby + end.coins, `${await lobbyOf(token)} vs ${lobby + end.coins}`);
      lobby += end.coins;
    } else {
      check(`life ${attempt}: eaten by ${end.killerName} holding ${end.coins}; the lobby gets nothing`, end.cause === "eaten" && end.gained === Math.floor((end.coins * RULES.eatGainBps) / 10_000) && (await lobbyOf(token)) === lobby);
    }
    await checkBooks(`after life ${attempt}`);
    await s.close();
  }
  check("at least one life in the busy ocean ended in a cash-out", extractedBusy);

  console.log("\n14. Graceful stop with a fish alive");
  const { s: a5 } = await Socket.open(token);
  await spawnFish(a5);
  lobby -= entry;
  await sleep(800);
  const running = child!;
  const stop = await post("/dev/stop", {});
  check("the dev stop door answers", stop.status === 200 && stop.body.stopping === true);
  check("the server exits by itself", await exited(running, 6000));
  child = null;
  await a5.close();
  await spec2.close();
  const stopLine = log.find((l) => /\[stop\] \d+ player\(s\) refunded \d+ coins/.test(l)) ?? "";
  const refunded = Number(/refunded (\d+) coins/.exec(stopLine)?.[1] ?? "-1");
  check("the stop log says one player was refunded", /\[stop\] 1 player\(s\) refunded/.test(stopLine) && refunded >= 1, stopLine);
  check("the stop log says the books balance", log.some((l) => l.includes("[stop] books balanced")), log.slice(-4).join(" | "));

  // ════════════════ C. after the graceful stop ════════════════
  await boot({ BOT_COUNT: "6" });
  check("nothing to recover after a graceful stop", !log.some((l) => l.includes("recovered the last ocean")), log.join(" | "));
  check("the drained fish is in the lobby, coin for coin", (await lobbyOf(token)) === lobby + refunded, `${await lobbyOf(token)} vs ${lobby + refunded}`);
  lobby += refunded;
  await checkBooks("after the graceful restart");

  console.log("\n15. Crash with a fish, bots and orbs in the water");
  await until(async () => Number((await status()).bots) === 6, 12_000, 200);
  const { s: a6 } = await Socket.open(token);
  await spawnFish(a6);
  lobby -= entry;
  // Long enough for a periodic checkpoint to have run with everything in the water.
  await sleep(6500);
  const bBusy = await checkBooks("before the crash");
  const stillAlive = a6.me() !== undefined;
  await crash();
  await a6.close();

  // ════════════════ D. recovery of the busy crash ════════════════
  await boot({ BOT_COUNT: "0", RAIN_PER_MINUTE: "0" });
  const recLine = log.find((l) => l.includes("recovered the last ocean")) ?? "";
  const rec = /(\d+) player\(s\) refunded (\d+) coins, (\d+) orb\/bot coins back to the pot/.exec(recLine);
  check("boot log reports the recovery", !!rec, log.join(" | "));
  const recPlayers = Number(rec?.[1] ?? "-1");
  const recCoins = Number(rec?.[2] ?? "-1");
  const recFloor = Number(rec?.[3] ?? "-1");
  if (stillAlive) check("the fish alive at the crash was refunded", recPlayers === 1 && recCoins >= 1, recLine);
  else check("the fish had already left the ocean before the crash", recPlayers === 0, recLine);
  check("the lobby got exactly what the recovery says", (await lobbyOf(token)) === lobby + recCoins, `${await lobbyOf(token)} vs ${lobby + recCoins}`);
  lobby += recCoins;
  const bEnd = await checkBooks("at the end");
  check("orbs and bot coins went back to the pot", recFloor >= 6 * split.stake && bEnd.pot === bBusy.pot + bBusy.ocean - wei(recCoins), `floor ${recFloor}; pot ${bEnd.pot} vs ${bBusy.pot + bBusy.ocean - wei(recCoins)}`);
  check("the ocean is empty and nothing is owed to it", bEnd.oceanCoins === 0 && bEnd.ocean === 0n);
  check("every wei is in a lobby, a voucher or the pot", bEnd.deposited + bEnd.funded === bEnd.lobby + bEnd.claimable + bEnd.pot);
  check("the server never logged a drift or a failed tick", !allLogs.some((l) => /DRIFT|tick failed/.test(l)), allLogs.filter((l) => /DRIFT|tick failed/.test(l)).join(" | "));
}

main()
  .catch((err) => {
    failed++;
    console.error("\nFAIL the run stopped:", err);
    if (log.length) console.error(`--- server log ---\n${log.slice(-30).join("\n")}`);
  })
  .finally(async () => {
    await crash();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* the OS will clean its temp dir */
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
