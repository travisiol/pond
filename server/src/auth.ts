import { randomBytes } from "node:crypto";
import { verifyMessage, isAddress, getAddress } from "viem";
import { config } from "./config";
import { consumeNonce, insertNonce, insertSession, sessionAddress } from "./db";

/**
 * The door is a signature, not a transaction. The wallet signs one plain
 * sentence carrying a nonce; the server checks it with ecrecover and hands
 * back a session token. Smart-contract wallets (ERC-1271) are turned away
 * on purpose: a key that can sign is what the game asks for.
 */

export function buildMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    `Sign in to ${config.appName}.`,
    "",
    "This signature costs nothing and moves nothing.",
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

export function issueNonce(addressRaw: string): { message: string; nonce: string } {
  if (!isAddress(addressRaw)) throw new Error("Not a wallet address.");
  const address = getAddress(addressRaw);
  const nonce = randomBytes(16).toString("hex");
  insertNonce(nonce, address.toLowerCase());
  return { message: buildMessage(address, nonce, new Date().toISOString()), nonce };
}

export async function verifySignature(
  addressRaw: string,
  nonce: string,
  message: string,
  signature: string,
): Promise<string> {
  if (!isAddress(addressRaw)) throw new Error("Not a wallet address.");
  const address = getAddress(addressRaw);
  const issuedTo = consumeNonce(nonce);
  if (!issuedTo || issuedTo !== address.toLowerCase()) throw new Error("That sign-in request has expired. Try again.");
  if (!message.includes(`Nonce: ${nonce}`) || !message.includes(`Wallet: ${address}`)) {
    throw new Error("The signed sentence does not match.");
  }
  let ok = false;
  try {
    ok = await verifyMessage({ address, message, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("Could not sign in. Use an ordinary browser wallet that holds its own key.");
  return openSession(address);
}

/** Tests only: a session for any address, no signature. Off unless DEV_AUTH=true. */
export function devSession(addressRaw: string): string {
  if (!config.devAuth) throw new Error("Dev sign-in is off.");
  if (!isAddress(addressRaw)) throw new Error("Not a wallet address.");
  return openSession(getAddress(addressRaw));
}

function openSession(address: string): string {
  const token = randomBytes(32).toString("hex");
  insertSession(token, address.toLowerCase());
  return token;
}

export function resolveSession(token: string | undefined | null): string | null {
  if (!token || token.length !== 64) return null;
  return sessionAddress(token);
}
