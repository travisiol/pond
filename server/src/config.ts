/**
 * Everything the server reads from the environment, with the defaults a
 * fresh checkout runs on. Nothing here is secret except PAYOUT_SIGNER_KEY.
 */
import { RULES, coinsToEth, splitEntry } from "../../web/src/shared/rules";

const env = (k: string, d = ""): string => (process.env[k] ?? d).trim();
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isKey = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);

/** Where the treasury's share of the fee is booked when there is no chain and no address. */
const PRACTICE_TREASURY = "treasury";

export const config = {
  port: Number(env("PORT", "8962")),
  /** Where the SQLite file lives. */
  dbPath: env("DB_PATH", "./data/frenzy.sqlite"),
  /** Allowed browser origin for HTTP and WebSocket. "*" in development. */
  origin: env("ORIGIN", "*"),
  /** The game's name: the only place the server spells it. Shown in the wallet when signing in. */
  appName: env("APP_NAME", "FRENZY"),
  /**
   * The built page (`web/out`) to serve next to the API, so one process is
   * the whole game. Empty = auto: `../web/out` if it exists, else API only.
   */
  staticDir: env("STATIC_DIR"),
  sessionDays: Number(env("SESSION_DAYS", "7")),

  // ── The chain ───────────────────────────────────────────────────────
  /**
   * "on"  — deposits are read from the Arena contract's events and vouchers
   *         are signed. Needs ARENA_ADDRESS and PAYOUT_SIGNER_KEY.
   * "off" — no chain at all. Nothing can enter the lobby unless DEV_FAUCET
   *         is on, and nothing can ever be claimed. For local play and tests.
   */
  chain: env("CHAIN", "off") as "on" | "off",
  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  chainId: Number(env("CHAIN_ID", "4663")),
  arenaAddress: env("ARENA_ADDRESS"),
  /** Block to start reading events from on a fresh database. */
  startBlock: Number(env("START_BLOCK", "0")),
  /** Seconds between two polls of the chain. */
  chainPollSeconds: Number(env("CHAIN_POLL_SECONDS", "4")),
  /** Blocks behind the head we consider final. Arbitrum Orbit reorgs are rare; 2 is a cushion. */
  confirmations: Number(env("CONFIRMATIONS", "2")),
  /**
   * Development convenience. In production this belongs in a signer
   * service or a KMS, never in a file on the game server.
   */
  payoutSignerKey: env("PAYOUT_SIGNER_KEY"),
  /** How long a signed voucher stays valid. */
  voucherMinutes: Number(env("VOUCHER_MINUTES", "30")),

  // ── The ocean ───────────────────────────────────────────────────────
  /** What one life costs, in coins (1 coin = 0.000001 ETH). Every fish enters at this price. */
  entryCoins: Number(env("ENTRY_COINS", String(RULES.entryCoins))),
  /** Basis points of every entry taken as a fee before the fish spawns. */
  feeBps: Number(env("FEE_BPS", String(RULES.feeBps))),
  /** Basis points of that fee that go to the pot; the rest goes to the treasury. */
  feePotShareBps: Number(env("FEE_POT_SHARE_BPS", String(RULES.feePotShareBps))),
  /** Wallet credited with the treasury's share. It cashes out with a voucher like anyone else. */
  treasuryAddress: env("TREASURY_ADDRESS").toLowerCase(),
  /**
   * Fish the server plays itself so the ocean is never empty. Each one is
   * staked from the pot (no fee), and none of them ever cashes out.
   */
  botCount: Number(env("BOT_COUNT", "14")),
  /**
   * Fastest the pot restocks the water, in orbs per minute. It stops at
   * RULES.rainTargetOrbs orbs. 0 disables rain.
   */
  rainPerMinute: Number(env("RAIN_PER_MINUTE", "2400")),
  /** Seconds between two ocean checkpoints (who holds what) written to disk. */
  checkpointSeconds: Number(env("CHECKPOINT_SECONDS", "5")),
  /**
   * Multiplier on the waiting clocks for local play: 0.1 makes the 45 s
   * minimum stay 4.5 s and the 5 s cash-out hold 0.5 s. Never in production.
   */
  timeScale: Number(env("TIME_SCALE", "1")),

  // ── Development doors ───────────────────────────────────────────────
  /** `POST /dev/faucet` credits a lobby without a deposit. Never with a chain. */
  devFaucet: env("DEV_FAUCET") === "true",
  /** `POST /auth/dev` opens a session without a signature. Tests only. */
  devAuth: env("DEV_AUTH") === "true",
};

/** How one entry is split. Fixed for the life of the process. */
export function entrySplit(): { stake: number; fee: number; toPot: number; toTreasury: number } {
  return splitEntry(config.entryCoins, config.feeBps, config.feePotShareBps);
}

/** One rain orb, in coins. */
export function rainOrbCoins(): number {
  return Math.max(1, Math.floor(config.entryCoins * RULES.rainOrbEntryFraction));
}

/**
 * The ledger account that receives the treasury's share of every fee: the
 * configured wallet, or a fixed placeholder when there is no chain at all.
 */
export function treasuryAccount(): string {
  if (isAddress(config.treasuryAddress)) return config.treasuryAddress;
  return PRACTICE_TREASURY;
}

export function chainConfigured(): boolean {
  return config.chain === "on" && isAddress(config.arenaAddress) && isKey(config.payoutSignerKey);
}

/** Why the chain is off, in words a player can act on. */
export function liveNote(): string | null {
  if (config.chain !== "on") {
    return "This is a practice ocean: the ETH here is play money, so there is nothing to deposit or withdraw.";
  }
  if (!isAddress(config.arenaAddress)) return "The Arena contract is not deployed yet: deposits and withdrawals open when it is.";
  if (!isKey(config.payoutSignerKey)) return "The server has no signing key yet: withdrawals open when it does.";
  return null;
}

/** "0.0020 ETH" for a number of coins. */
export function eth(coins: number): string {
  return `${coinsToEth(coins)} ETH`;
}

export function assertConfig(): void {
  if (config.chain !== "on" && config.chain !== "off") throw new Error('CHAIN must be "on" or "off"');
  if (config.chain === "on" && !chainConfigured()) {
    throw new Error(`CHAIN=on but the chain is not configured: ${liveNote()}`);
  }

  if (!Number.isInteger(config.entryCoins) || config.entryCoins < 100 || config.entryCoins > 1_000_000_000) {
    throw new Error("ENTRY_COINS must be a whole number of coins between 100 and 1000000000 (1 coin = 0.000001 ETH)");
  }
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 5_000) {
    throw new Error("FEE_BPS must be a whole number between 0 and 5000");
  }
  if (!Number.isInteger(config.feePotShareBps) || config.feePotShareBps < 0 || config.feePotShareBps > 10_000) {
    throw new Error("FEE_POT_SHARE_BPS must be a whole number between 0 and 10000");
  }
  const split = entrySplit();
  if (split.toTreasury > 0 && !isAddress(config.treasuryAddress)) {
    // CHAIN=off with no treasury at all is fine: the share is booked on a placeholder account.
    if (config.chain === "on" || config.treasuryAddress !== "") {
      throw new Error(
        `The treasury takes ${split.toTreasury} coins of every entry (FEE_BPS=${config.feeBps}, FEE_POT_SHARE_BPS=${config.feePotShareBps}): ` +
          "TREASURY_ADDRESS must be the 0x wallet that receives them. Set it, or set FEE_POT_SHARE_BPS=10000 to send the whole fee to the pot.",
      );
    }
  }

  if (!Number.isInteger(config.botCount) || config.botCount < 0 || config.botCount > 200) {
    throw new Error("BOT_COUNT must be a whole number between 0 and 200");
  }
  if (!(config.rainPerMinute >= 0)) throw new Error("RAIN_PER_MINUTE must be 0 or more");
  if (!(config.checkpointSeconds > 0)) throw new Error("CHECKPOINT_SECONDS must be > 0");
  if (!(config.timeScale > 0)) throw new Error("TIME_SCALE must be > 0");
  if (config.chain === "on" && config.timeScale !== 1) throw new Error("TIME_SCALE must be 1 when CHAIN=on");
  if (config.chain === "on" && config.devFaucet) throw new Error("DEV_FAUCET cannot be on together with CHAIN=on");
  if (config.chain === "on" && config.devAuth) throw new Error("DEV_AUTH cannot be on together with CHAIN=on");
}
