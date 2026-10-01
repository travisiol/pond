import { createPublicClient, defineChain, getAddress, http, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainConfigured, config } from "./config";
import { creditDeposit, creditFund, lastBlock, noteClaim, setLastBlock } from "./db";

/**
 * The chain, read only. The server never sends a transaction: it reads the
 * Arena's events to fill lobbies and the pot (native ETH, credited in wei),
 * and it signs vouchers players submit themselves. Everything here is
 * inert when CHAIN=off.
 */

export const chain = defineChain({
  id: config.chainId,
  name: config.chainId === 4663 ? "Robinhood Chain" : `Chain ${config.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

export const publicClient = createPublicClient({ chain, transport: http(config.rpcUrl) });

const arenaAbi = parseAbi([
  "function claimed(address) view returns (uint256)",
  "function available() view returns (uint256)",
  "function paused() view returns (bool)",
  "function signer() view returns (address)",
]);

const depositedEvent = parseAbiItem("event Deposited(address indexed player, uint256 amount, uint256 indexed id)");
const fundedEvent = parseAbiItem("event Funded(address indexed from, uint256 amount)");
const claimedEvent = parseAbiItem("event Claimed(address indexed account, uint256 paid, uint256 cumulative)");

const account = /^0x[0-9a-fA-F]{64}$/.test(config.payoutSignerKey)
  ? privateKeyToAccount(config.payoutSignerKey as `0x${string}`)
  : null;

export const signerAddress = account?.address ?? null;

export interface Voucher {
  account: string;
  cumulative: string;
  deadline: number;
  signature: `0x${string}`;
  arena: string;
  chainId: number;
}

/** Sign "this wallet is entitled to `cumulative` in total". */
export async function signVoucher(address: string, cumulative: bigint): Promise<Voucher> {
  if (!account || !chainConfigured()) throw new Error("Withdrawals are off: this server is not connected to a chain.");
  const arena = getAddress(config.arenaAddress);
  const deadline = Math.floor(Date.now() / 1000) + config.voucherMinutes * 60;
  const signature = await account.signTypedData({
    domain: { name: "FrenzyArena", version: "1", chainId: chain.id, verifyingContract: arena },
    types: {
      Claim: [
        { name: "account", type: "address" },
        { name: "cumulative", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Claim",
    message: { account: getAddress(address), cumulative, deadline: BigInt(deadline) },
  });
  return { account: getAddress(address), cumulative: cumulative.toString(), deadline, signature, arena, chainId: chain.id };
}

export interface ChainView {
  claimed: bigint;
  available: bigint;
  paused: boolean;
  signerMatches: boolean;
}

export async function readChain(address: string): Promise<ChainView | null> {
  if (!chainConfigured()) return null;
  const arena = getAddress(config.arenaAddress);
  try {
    const [claimed, available, paused, onChainSigner] = await Promise.all([
      publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "claimed", args: [getAddress(address)] }),
      publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "available" }),
      publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "paused" }),
      publicClient.readContract({ address: arena, abi: arenaAbi, functionName: "signer" }),
    ]);
    return {
      claimed,
      available,
      paused,
      signerMatches: !!signerAddress && onChainSigner.toLowerCase() === signerAddress.toLowerCase(),
    };
  } catch {
    return null;
  }
}

let polling = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Reads every Deposited / Funded / Claimed event since the last block seen,
 * a few blocks behind the head. Idempotent: the (tx, logIndex) pair is the
 * primary key, so a poll that repeats a range credits nothing twice.
 */
export async function pollChain(onCredit?: (address: string) => void): Promise<void> {
  if (!chainConfigured() || polling) return;
  polling = true;
  try {
    const arena = getAddress(config.arenaAddress);
    const head = Number(await publicClient.getBlockNumber());
    const to = head - config.confirmations;
    const from = lastBlock() + 1;
    if (to < from) return;
    const upper = Math.min(to, from + 5_000);
    const [deposits, funds, claims] = await Promise.all([
      publicClient.getLogs({ address: arena, event: depositedEvent, fromBlock: BigInt(from), toBlock: BigInt(upper) }),
      publicClient.getLogs({ address: arena, event: fundedEvent, fromBlock: BigInt(from), toBlock: BigInt(upper) }),
      publicClient.getLogs({ address: arena, event: claimedEvent, fromBlock: BigInt(from), toBlock: BigInt(upper) }),
    ]);
    for (const log of deposits) {
      const player = log.args.player;
      const amount = log.args.amount;
      if (!player || amount === undefined) continue;
      if (creditDeposit(player, amount, log.transactionHash, Number(log.logIndex), Number(log.blockNumber))) {
        onCredit?.(player.toLowerCase());
      }
    }
    for (const log of funds) {
      const from_ = log.args.from;
      const amount = log.args.amount;
      if (!from_ || amount === undefined) continue;
      creditFund(from_, amount, log.transactionHash, Number(log.logIndex), Number(log.blockNumber));
    }
    for (const log of claims) {
      const acct = log.args.account;
      const paid = log.args.paid;
      const cumulative = log.args.cumulative;
      if (!acct || paid === undefined || cumulative === undefined) continue;
      if (noteClaim(acct, paid, cumulative, log.transactionHash, Number(log.logIndex), Number(log.blockNumber))) {
        onCredit?.(acct.toLowerCase());
      }
    }
    setLastBlock(upper);
  } catch (err) {
    console.warn(`[chain] poll failed: ${(err as Error).message}`);
  } finally {
    polling = false;
  }
}

export function startChainWatcher(onCredit?: (address: string) => void): void {
  if (!chainConfigured()) return;
  void pollChain(onCredit);
  timer = setInterval(() => void pollChain(onCredit), config.chainPollSeconds * 1000);
}

export function stopChainWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
