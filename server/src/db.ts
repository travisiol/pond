import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { coinsToWei, weiToCoins } from "../../web/src/shared/rules";
import { config } from "./config";

export { coinsToWei, weiToCoins };

/**
 * SQLite through Node's built-in driver: no native build step, one file on
 * disk. Every movement of money outside the ocean goes through here, in
 * wei kept as decimal strings (bigint end to end, never a float).
 *
 * Inside the ocean money is whole coins (1 coin = 10^12 wei) held by the
 * simulation in memory. The `checkpoint` table plus the `floor_coins`
 * counter shadow it, so a crash can never lose a coin. The shadow's TOTAL
 * equals the live ocean's total after every committed transaction:
 *
 *   - `enter` adds the fish's stake to its owner's row, in the same
 *     transaction that debits the lobby and books the fee;
 *   - `drawPot` adds what left the pot (rain, bot stakes) to `floor_coins`;
 *   - `settle` — cash-outs, retiring bots, the periodic checkpoint, the
 *     graceful stop — pays out and rewrites the whole shadow from the live
 *     ocean in one transaction.
 *
 * Only who-holds-what can be a few seconds stale (fish eat each other
 * between two checkpoints). On the next boot whatever the shadow holds is
 * handed back: players' coins to their lobby, floor and bot coins to the pot.
 */

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS accounts (
    address TEXT PRIMARY KEY,
    lobby_wei TEXT NOT NULL DEFAULT '0',
    claimable_wei TEXT NOT NULL DEFAULT '0',
    claimed_wei TEXT NOT NULL DEFAULT '0',
    name TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chain_events (
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    address TEXT NOT NULL,
    amount_wei TEXT NOT NULL,
    block INTEGER NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkpoint (
    owner TEXT PRIMARY KEY,
    coins INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    address TEXT,
    name TEXT,
    coins INTEGER NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS history_at ON history(at);
`);

/** Runs `fn` as one transaction: everything it does lands, or none of it. */
function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─────────────────────────────── meta ────────────────────────────────

function metaGet(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

function metaSet(key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function potWei(): bigint {
  return BigInt(metaGet("pot_wei", "0"));
}

function setPot(v: bigint): void {
  if (v < 0n) throw new Error("pot would go negative");
  metaSet("pot_wei", v.toString());
}

export function lastBlock(): number {
  return Number(metaGet("last_block", String(config.startBlock)));
}

export function setLastBlock(n: number): void {
  metaSet("last_block", String(n));
}

/** Coins the shadow holds that belong to nobody: orbs in the water and the bots' bodies. */
function shadowFloor(): number {
  return Number(metaGet("floor_coins", "0"));
}

function setShadowFloor(n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new Error(`floor_coins would be ${n}`);
  metaSet("floor_coins", String(n));
}

// ───────────────────────────── accounts ──────────────────────────────

export interface AccountRow {
  address: string;
  lobby_wei: bigint;
  claimable_wei: bigint;
  claimed_wei: bigint;
  name: string | null;
}

export function getAccount(address: string): AccountRow | null {
  const row = db.prepare("SELECT * FROM accounts WHERE address = ?").get(address.toLowerCase()) as
    | { address: string; lobby_wei: string; claimable_wei: string; claimed_wei: string; name: string | null }
    | undefined;
  if (!row) return null;
  return {
    address: row.address,
    lobby_wei: BigInt(row.lobby_wei),
    claimable_wei: BigInt(row.claimable_wei),
    claimed_wei: BigInt(row.claimed_wei),
    name: row.name,
  };
}

export function ensureAccount(address: string): AccountRow {
  const a = address.toLowerCase();
  db.prepare("INSERT OR IGNORE INTO accounts(address, created_at) VALUES (?, ?)").run(a, Date.now());
  return getAccount(a)!;
}

export function setName(address: string, name: string | null): void {
  ensureAccount(address);
  db.prepare("UPDATE accounts SET name = ? WHERE address = ?").run(name, address.toLowerCase());
}

function setLobby(address: string, v: bigint): void {
  if (v < 0n) throw new Error("lobby would go negative");
  db.prepare("UPDATE accounts SET lobby_wei = ? WHERE address = ?").run(v.toString(), address.toLowerCase());
}

/** Adds coins to a lobby. Call inside a transaction. */
function creditLobby(address: string, coins: number): void {
  if (coins <= 0) return;
  const acct = ensureAccount(address);
  setLobby(address, acct.lobby_wei + coinsToWei(coins));
}

// ─────────────────────────── chain events ────────────────────────────

export function chainEventSeen(txHash: string, logIndex: number): boolean {
  return !!db.prepare("SELECT 1 FROM chain_events WHERE tx_hash = ? AND log_index = ?").get(txHash, logIndex);
}

/** A `Deposited` event: the lobby grows by exactly the wei the contract received. */
export function creditDeposit(address: string, wei: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  const a = address.toLowerCase();
  return tx(() => {
    const acct = ensureAccount(a);
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'deposit', ?, ?, ?)").run(
      txHash,
      logIndex,
      a,
      wei.toString(),
      block,
    );
    setLobby(a, acct.lobby_wei + wei);
    return true;
  });
}

/** A `Funded` event: the pot grows. */
export function creditFund(from: string, wei: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  return tx(() => {
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'fund', ?, ?, ?)").run(
      txHash,
      logIndex,
      from.toLowerCase(),
      wei.toString(),
      block,
    );
    setPot(potWei() + wei);
    return true;
  });
}

/** A `Claimed` event: remembered so the bank panel can show what the chain paid. */
export function noteClaim(address: string, paid: bigint, cumulative: bigint, txHash: string, logIndex: number, block: number): boolean {
  if (chainEventSeen(txHash, logIndex)) return false;
  const a = address.toLowerCase();
  return tx(() => {
    ensureAccount(a);
    db.prepare("INSERT INTO chain_events(tx_hash, log_index, kind, address, amount_wei, block) VALUES (?, ?, 'claim', ?, ?, ?)").run(
      txHash,
      logIndex,
      a,
      paid.toString(),
      block,
    );
    db.prepare("UPDATE accounts SET claimed_wei = ? WHERE address = ?").run(cumulative.toString(), a);
    return true;
  });
}

let faucetSerial = 0;
const faucetTx = (): string => `faucet:${Date.now()}:${++faucetSerial}:${Math.random().toString(36).slice(2)}`;

/**
 * Development faucet: ETH that was never deposited. Recorded as a
 * pseudo-deposit so the books still balance — the "contract" in this mode
 * is imaginary and owes exactly what the faucet printed.
 */
export function faucet(address: string, wei: bigint): void {
  if (!config.devFaucet) throw new Error("The faucet is off.");
  creditDeposit(address, wei, faucetTx(), 0, 0);
}

export function faucetPot(wei: bigint): void {
  if (!config.devFaucet) throw new Error("The faucet is off.");
  creditFund("faucet", wei, faucetTx(), 0, 0);
}

// ──────────────────────────── the ocean ──────────────────────────────

export interface EntrySplit {
  stake: number;
  fee: number;
  toPot: number;
  toTreasury: number;
}

/**
 * One life. The lobby pays the full entry; the stake becomes the fish's
 * body in the ocean (a checkpoint row), the pot and the treasury's lobby
 * share the fee. One transaction. Returns false, touching nothing, when
 * the lobby cannot cover the entry.
 */
export function enter(address: string, split: EntrySplit, treasury: string): boolean {
  const a = address.toLowerCase();
  const entry = split.stake + split.fee;
  if (split.toPot + split.toTreasury !== split.fee || split.stake <= 0) throw new Error("enter: the split does not add up");
  const wei = coinsToWei(entry);
  return tx(() => {
    const acct = ensureAccount(a);
    if (acct.lobby_wei < wei) return false;
    setLobby(a, acct.lobby_wei - wei);
    db.prepare("INSERT INTO checkpoint(owner, coins) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET coins = coins + excluded.coins").run(
      a,
      split.stake,
    );
    if (split.toPot > 0) setPot(potWei() + coinsToWei(split.toPot));
    // Read after the debit: the treasury may be the very wallet that is entering.
    if (split.toTreasury > 0) creditLobby(treasury, split.toTreasury);
    return true;
  });
}

/** Pot → ocean, for rain and bot stakes. Returns false when the pot is short. */
export function drawPot(coins: number): boolean {
  const wei = coinsToWei(coins);
  return tx(() => {
    const pot = potWei();
    if (pot < wei) return false;
    setPot(pot - wei);
    setShadowFloor(shadowFloor() + coins);
    return true;
  });
}

export interface Settlement {
  /** Coins leaving the ocean for a lobby: a cash-out, or a refund on a graceful stop. */
  credits?: { owner: string; coins: number }[];
  /** Coins leaving the ocean for the pot: a bot that swam off, or the floor on a graceful stop. */
  toPot?: number;
  /** What the ocean holds once those have left: one row per player fish… */
  rows: { owner: string; coins: number }[];
  /** …and everything that belongs to nobody (orbs and bot bodies). */
  floor: number;
}

/**
 * Pays out what left the ocean and rewrites the crash shadow from what is
 * still in it, in one transaction. With nothing to pay this is the plain
 * periodic checkpoint.
 */
export function settle(s: Settlement): void {
  tx(() => {
    for (const c of s.credits ?? []) creditLobby(c.owner, c.coins);
    if (s.toPot && s.toPot > 0) setPot(potWei() + coinsToWei(s.toPot));
    db.exec("DELETE FROM checkpoint");
    const ins = db.prepare("INSERT INTO checkpoint(owner, coins) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET coins = coins + excluded.coins");
    for (const r of s.rows) ins.run(r.owner.toLowerCase(), r.coins);
    setShadowFloor(s.floor);
  });
}

/**
 * Hands back whatever the last checkpoint says was in the ocean. Called
 * once at boot, before the world exists. Returns what it did for the log.
 */
export function recoverCheckpoint(): { players: number; coins: number; floor: number } {
  return tx(() => {
    const rows = db.prepare("SELECT owner, coins FROM checkpoint").all() as { owner: string; coins: number }[];
    const floor = shadowFloor();
    let coins = 0;
    for (const r of rows) {
      creditLobby(r.owner, r.coins);
      coins += r.coins;
    }
    if (floor > 0) setPot(potWei() + coinsToWei(floor));
    db.exec("DELETE FROM checkpoint");
    setShadowFloor(0);
    return { players: rows.length, coins, floor };
  });
}

/** Everything the shadow says is in the ocean. Equals the live total when the ledger is right. */
export function checkpointTotal(): number {
  const rows = db.prepare("SELECT COALESCE(SUM(coins), 0) AS s FROM checkpoint").get() as { s: number };
  return Number(rows.s) + shadowFloor();
}

// ─────────────────────────────── bank ────────────────────────────────

/** Lobby → claimable. Everything in the lobby becomes voucher entitlement. */
export function cashOut(address: string): { moved: bigint; cumulative: bigint } {
  const a = address.toLowerCase();
  return tx(() => {
    const acct = ensureAccount(a);
    const moved = acct.lobby_wei;
    const cumulative = acct.claimable_wei + moved;
    db.prepare("UPDATE accounts SET lobby_wei = '0', claimable_wei = ? WHERE address = ?").run(cumulative.toString(), a);
    return { moved, cumulative };
  });
}

// ───────────────────────────── history ───────────────────────────────

export function recordHistory(type: string, address: string | null, name: string | null, coins: number, detail?: string): void {
  db.prepare("INSERT INTO history(at, type, address, name, coins, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    Date.now(),
    type,
    address,
    name,
    coins,
    detail ?? null,
  );
}

export function recentHistory(limit = 20): { at: number; type: string; name: string | null; coins: number; detail: string | null }[] {
  return db.prepare("SELECT at, type, name, coins, detail FROM history ORDER BY id DESC LIMIT ?").all(limit) as {
    at: number;
    type: string;
    name: string | null;
    coins: number;
    detail: string | null;
  }[];
}

// ───────────────────────────── the books ─────────────────────────────

export interface Books {
  deposited: bigint;
  funded: bigint;
  lobby: bigint;
  claimable: bigint;
  pot: bigint;
  ocean: bigint;
  /** deposited + funded − (lobby + claimable + pot + ocean). Must be 0. */
  drift: bigint;
}

/**
 * The one equation the whole ledger rests on. Every wei that ever came in
 * is either waiting in a lobby, promised by a voucher, sitting in the pot,
 * or inside the ocean. `oceanCoins` is the live world's total (or the
 * checkpoint's, when the world is not running).
 */
export function books(oceanCoins: number): Books {
  const sum = (sql: string): bigint => {
    const rows = db.prepare(sql).all() as { v: string }[];
    let t = 0n;
    for (const r of rows) t += BigInt(r.v);
    return t;
  };
  const deposited = sum("SELECT amount_wei AS v FROM chain_events WHERE kind = 'deposit'");
  const funded = sum("SELECT amount_wei AS v FROM chain_events WHERE kind = 'fund'");
  const lobby = sum("SELECT lobby_wei AS v FROM accounts");
  const claimable = sum("SELECT claimable_wei AS v FROM accounts");
  const pot = potWei();
  const ocean = coinsToWei(oceanCoins);
  return { deposited, funded, lobby, claimable, pot, ocean, drift: deposited + funded - (lobby + claimable + pot + ocean) };
}

// ─────────────────────────────── auth ────────────────────────────────

export function insertNonce(nonce: string, address: string): void {
  db.prepare("INSERT INTO nonces(nonce, address, created_at) VALUES (?, ?, ?)").run(nonce, address, Date.now());
}

export function consumeNonce(nonce: string): string | null {
  const row = db.prepare("SELECT address, created_at FROM nonces WHERE nonce = ?").get(nonce) as
    | { address: string; created_at: number }
    | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce);
  if (Date.now() - row.created_at > 10 * 60_000) return null;
  return row.address;
}

export function insertSession(token: string, address: string): void {
  db.prepare("INSERT INTO sessions(token, address, created_at) VALUES (?, ?, ?)").run(token, address, Date.now());
}

export function sessionAddress(token: string): string | null {
  const row = db.prepare("SELECT address, created_at FROM sessions WHERE token = ?").get(token) as
    | { address: string; created_at: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.created_at > config.sessionDays * 86_400_000) return null;
  return row.address;
}

export function prune(): void {
  db.prepare("DELETE FROM nonces WHERE created_at < ?").run(Date.now() - 10 * 60_000);
  db.prepare("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - config.sessionDays * 86_400_000);
}
