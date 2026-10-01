import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { parseEther } from "viem";
import { chainConfigured, config, entrySplit, liveNote, rainOrbCoins, treasuryAccount } from "./config";
import { devSession, issueNonce, resolveSession, verifySignature } from "./auth";
import { readChain, signVoucher, signerAddress } from "./chain";
import * as db from "./db";
import { RULES } from "../../web/src/shared/rules";
import type { Arena } from "./arena";

/**
 * The JSON routes that happen outside the socket: sign-in, the bank, the
 * numbers the landing shows, and the development doors.
 */

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": config.origin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("Body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// ─────────────────────────────── the page ───────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** Resolved once at boot: the page folder, or null when this is an API-only process. */
export const staticRoot: string | null = (() => {
  const candidate = config.staticDir ? resolve(config.staticDir) : resolve(process.cwd(), "..", "web", "out");
  return existsSync(resolve(candidate, "index.html")) ? candidate : null;
})();

/**
 * Serves `web/out` — the static export of the page — so this server is the
 * whole game on one origin: no CORS, no server URL to configure, and the
 * socket's `wss://` follows the page's `https://` by itself.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): boolean {
  if (!staticRoot) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const candidates = p.endsWith("/") ? [`${p}index.html`] : [p, `${p}.html`, `${p}/index.html`];
  let file: string | null = null;
  for (const c of candidates) {
    const full = resolve(staticRoot, `.${c}`);
    if (!full.startsWith(staticRoot + sep) && full !== staticRoot) continue; // no escaping the folder
    try {
      if (statSync(full).isFile()) {
        file = full;
        break;
      }
    } catch {
      /* next candidate */
    }
  }
  let status = 200;
  if (!file) {
    const notFound = resolve(staticRoot, "404.html");
    if (!existsSync(notFound)) return false;
    file = notFound;
    status = 404;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const immutable = p.startsWith("/_next/static/");
  res.writeHead(status, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  const address = resolveSession(h.slice(7).trim());
  return address;
}

let devStop: (() => void) | null = null;

/** The process registers how to stop gracefully; `POST /dev/stop` calls it. */
export function onDevStop(fn: () => void): void {
  devStop = fn;
}

/** "0.01" → wei. Plain decimals only, so a typo is an error and not a surprise. */
function ethAmount(raw: unknown, fallback: string): bigint {
  const s = raw === undefined || raw === null || raw === "" ? fallback : String(raw).trim();
  if (!/^\d{1,9}(\.\d{1,18})?$/.test(s)) throw new Error('Send "eth" as a plain decimal amount, for example "0.01".');
  const wei = parseEther(s);
  if (wei <= 0n) throw new Error("The amount must be more than zero.");
  return wei;
}

const NOT_SIGNED_IN = "Sign in with your wallet first.";

export async function handleHttp(req: IncomingMessage, res: ServerResponse, arena: Arena): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return json(res, 204, {});

  try {
    if (method === "GET" && path === "/status") {
      const s = arena.stats();
      const treasury = treasuryAccount();
      const treasuryLobbyWei = db.getAccount(treasury)?.lobby_wei ?? 0n;
      return json(res, 200, {
        name: config.appName,
        ...s,
        live: chainConfigured(),
        liveNote: liveNote(),
        practice: config.chain !== "on",
        arena: config.arenaAddress || null,
        chainId: config.chainId,
        signer: signerAddress,
        // The economy, in whole coins (1 coin = 0.000001 ETH) and basis points.
        entryCoins: config.entryCoins,
        feeBps: config.feeBps,
        feePotShareBps: config.feePotShareBps,
        entry: entrySplit(),
        rainOrbCoins: rainOrbCoins(),
        rainPerMinute: config.rainPerMinute,
        botCount: config.botCount,
        treasury,
        treasuryLobbyCoins: db.weiToCoins(treasuryLobbyWei),
        treasuryLobbyWei: treasuryLobbyWei.toString(),
        devFaucet: config.devFaucet,
        rules: RULES,
        timing: arena.world.timing,
        recent: db.recentHistory(20),
      });
    }

    if (method === "GET" && path === "/books") {
      const oceanCoins = arena.stats().oceanCoins;
      const b = db.books(oceanCoins);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(b)) out[k] = (v as bigint).toString();
      const checkpointCoins = db.checkpointTotal();
      return json(res, 200, {
        // Wei, as decimal strings: deposited + funded = lobby + claimable + pot + ocean.
        ...out,
        balanced: b.drift === 0n,
        oceanCoins,
        // What the crash shadow on disk says the ocean holds. Must equal oceanCoins.
        checkpointCoins,
        checkpointMatches: checkpointCoins === oceanCoins,
      });
    }

    if (method === "POST" && path === "/auth/nonce") {
      const body = await readJson(req);
      return json(res, 200, issueNonce(String(body.address ?? "")));
    }

    if (method === "POST" && path === "/auth/verify") {
      const body = await readJson(req);
      const token = await verifySignature(
        String(body.address ?? ""),
        String(body.nonce ?? ""),
        String(body.message ?? ""),
        String(body.signature ?? ""),
      );
      return json(res, 200, { token });
    }

    if (method === "POST" && path === "/auth/dev") {
      if (!config.devAuth) return json(res, 404, { error: "Not found." });
      const body = await readJson(req);
      const token = devSession(String(body.address ?? ""));
      return json(res, 200, { token });
    }

    if (method === "GET" && path === "/me") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: NOT_SIGNED_IN });
      const you = arena.youState(address);
      const chain = await readChain(address);
      return json(res, 200, {
        ...you,
        chain: chain
          ? { claimed: chain.claimed.toString(), available: chain.available.toString(), paused: chain.paused, signerMatches: chain.signerMatches }
          : null,
        live: chainConfigured(),
        liveNote: liveNote(),
      });
    }

    // The bank: everything in the lobby becomes a signed voucher the wallet claims on chain.
    if (method === "POST" && path === "/cashout") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: NOT_SIGNED_IN });
      if (!chainConfigured()) return json(res, 409, { error: liveNote() });
      const acct = db.ensureAccount(address);
      if (acct.lobby_wei <= 0n) {
        return json(res, 409, { error: "Your balance is 0 ETH: there is nothing to withdraw. Cash out a fish first." });
      }
      const { moved, cumulative } = db.cashOut(address);
      db.recordHistory("withdraw", address, acct.name, db.weiToCoins(moved));
      const voucher = await signVoucher(address, cumulative);
      arena.refreshYou(address);
      return json(res, 200, { voucher, moved: moved.toString() });
    }

    // The same voucher again, for a wallet that closed the page before claiming.
    if (method === "POST" && path === "/voucher") {
      const address = bearer(req);
      if (!address) return json(res, 401, { error: NOT_SIGNED_IN });
      if (!chainConfigured()) return json(res, 409, { error: liveNote() });
      const acct = db.ensureAccount(address);
      if (acct.claimable_wei <= 0n) return json(res, 409, { error: "You have not withdrawn anything yet." });
      const voucher = await signVoucher(address, acct.claimable_wei);
      return json(res, 200, { voucher });
    }

    if (method === "GET" && path === "/history") {
      const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? "20")) || 20));
      return json(res, 200, { recent: db.recentHistory(limit) });
    }

    if (method === "POST" && path === "/dev/faucet") {
      if (!config.devFaucet) return json(res, 404, { error: "Not found." });
      const body = await readJson(req);
      const address = String(body.address ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) return json(res, 400, { error: 'Send "address" as a 0x wallet address.' });
      db.faucet(address, ethAmount(body.eth, "0.01"));
      arena.refreshYou(address);
      return json(res, 200, arena.youState(address));
    }

    if (method === "POST" && path === "/dev/faucet-pot") {
      if (!config.devFaucet) return json(res, 404, { error: "Not found." });
      const body = await readJson(req);
      db.faucetPot(ethAmount(body.eth, "0.1"));
      const pot = db.potWei();
      return json(res, 200, { pot: pot.toString(), potCoins: db.weiToCoins(pot) });
    }

    // Graceful stop on demand (what SIGTERM does), for platforms that cannot send the signal.
    if (method === "POST" && path === "/dev/stop") {
      if (!config.devFaucet || !devStop) return json(res, 404, { error: "Not found." });
      json(res, 200, { stopping: true });
      devStop();
      return;
    }

    if (serveStatic(req, res, path)) return;
    return json(res, 404, { error: "Not found." });
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}
