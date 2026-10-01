import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { assertConfig, chainConfigured, config, entrySplit, eth, liveNote, rainOrbCoins, treasuryAccount } from "./config";
import { resolveSession } from "./auth";
import { startChainWatcher, stopChainWatcher, signerAddress } from "./chain";
import * as db from "./db";
import { clientIp, handleHttp, onDevStop, staticRoot } from "./http";
import { Arena, type Client } from "./arena";
import type { ClientMessage } from "../../web/src/shared/protocol";

/**
 * Boot: one HTTP server for the JSON routes, one WebSocket server on the
 * same port for the ocean. `ws://host/ws` is the only socket path.
 */

try {
  assertConfig();
} catch (err) {
  console.error(`[boot] refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

// Whatever the last run left in the ocean goes back where it came from
// before the world exists, so no coin is ever lost to a crash.
const recovered = db.recoverCheckpoint();
if (recovered.players > 0 || recovered.floor > 0) {
  console.log(
    `[boot] recovered the last ocean: ${recovered.players} player(s) refunded ${recovered.coins} coins, ${recovered.floor} orb/bot coins back to the pot`,
  );
}
{
  const b = db.books(0);
  if (b.drift !== 0n) console.error(`[boot] books DRIFT ${b.drift.toString()} wei with an empty ocean: the ledger does not add up`);
}

const arena = new Arena();
arena.start();

const server = createServer((req, res) => {
  void handleHttp(req, res, arena);
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 2048 });

wss.on("connection", (ws: WebSocket, req) => {
  const origin = req.headers.origin;
  if (config.origin !== "*" && origin && origin !== config.origin) {
    ws.close(1008, "origin");
    return;
  }
  const client: Client = arena.connect(ws, clientIp(req));
  let greeted = false;

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      if (greeted) return;
      greeted = true;
      const address = resolveSession(typeof msg.session === "string" ? msg.session : null);
      arena.hello(client, address);
      return;
    }
    if (!greeted) return;
    if (msg.t === "input") arena.input(client, msg.a, msg.b, msg.c);
    else if (msg.t === "spawn") arena.spawnRequest(client, msg.name);
    else if (msg.t === "ping") arena.send(client, { t: "pong", n: Number(msg.n) || 0, serverTime: arena.world.time });
  });

  ws.on("close", () => arena.disconnect(client));
  ws.on("error", () => arena.disconnect(client));
});

startChainWatcher((address) => arena.refreshYou(address));
setInterval(() => db.prune(), 10 * 60_000).unref();

server.on("error", (err) => {
  console.error(`[boot] cannot listen on :${config.port}: ${(err as Error).message}`);
  process.exit(1);
});

server.listen(config.port, () => {
  const split = entrySplit();
  console.log(`[boot] ${config.appName} ocean on :${config.port} — ws://localhost:${config.port}/ws`);
  console.log(`[boot] chain ${chainConfigured() ? `on (arena ${config.arenaAddress}, signer ${signerAddress})` : `off — ${liveNote()}`}`);
  console.log(
    `[boot] one life ${eth(config.entryCoins)}: ${split.stake} coins into the fish, ${split.toPot} to the pot, ${split.toTreasury} to the treasury (${treasuryAccount()})`,
  );
  console.log(
    `[boot] bots ${config.botCount}, rain ${config.rainPerMinute}/min of ${rainOrbCoins()} coins, pot ${eth(db.weiToCoins(db.potWei()))}, time scale ${config.timeScale}`,
  );
  console.log(staticRoot ? `[boot] serving the page from ${staticRoot}` : "[boot] no built page found (web/out): API and socket only");
  if (config.devFaucet) console.log('[boot] DEV_FAUCET is on: POST /dev/faucet {address, eth}, POST /dev/faucet-pot {eth}, POST /dev/stop');
  if (config.devAuth) console.log("[boot] DEV_AUTH is on: POST /auth/dev {address}");
});

let stopping = false;

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`[stop] ${signal}: emptying the ocean`);
  stopChainWatcher();
  const d = arena.drain();
  console.log(`[stop] ${d.players} player(s) refunded ${d.coins} coins, ${d.floor} coins back to the pot`);
  const b = db.books(0);
  console.log(`[stop] books ${b.drift === 0n ? "balanced" : `DRIFT ${b.drift.toString()}`}`);
  for (const c of wss.clients) c.close(1001, "restart");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Windows cannot deliver SIGTERM to a process: the faucet's dev door asks for the same graceful stop.
onDevStop(() => setImmediate(() => shutdown("dev stop")));
