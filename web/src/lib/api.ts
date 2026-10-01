import { serverUrl } from "@/lib/site";

/**
 * The game server's JSON routes. Every call returns the parsed body or
 * throws with the server's own sentence, which the UI shows verbatim.
 */

const SESSION_KEY = "frenzy.session";

export function getSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode */
  }
}

async function call<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) {
    const s = getSession();
    if (!s) throw new Error("Sign in first.");
    headers.authorization = `Bearer ${s}`;
  }
  let res: Response;
  try {
    res = await fetch(serverUrl() + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  } catch {
    throw new Error("The game server is not reachable.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body;
}

export interface Voucher {
  account: string;
  cumulative: string;
  deadline: number;
  signature: `0x${string}`;
  arena: string;
  chainId: number;
}

export interface MeResponse {
  address: string;
  name: string | null;
  lobbyCoins: number;
  lobbyWei: string;
  claimableWei: string;
  claimedWei: string;
  chain: { claimed: string; available: string; paused: boolean; signerMatches: boolean } | null;
  live: boolean;
  liveNote: string | null;
}

export const api = {
  nonce: (address: string) =>
    call<{ message: string; nonce: string }>("/auth/nonce", { method: "POST", body: JSON.stringify({ address }) }),
  verify: (address: string, nonce: string, message: string, signature: string) =>
    call<{ token: string }>("/auth/verify", { method: "POST", body: JSON.stringify({ address, nonce, message, signature }) }),
  devAuth: (address: string) => call<{ token: string }>("/auth/dev", { method: "POST", body: JSON.stringify({ address }) }),
  me: () => call<MeResponse>("/me", {}, true),
  /** Moves the whole lobby balance into a signed voucher the wallet can claim. */
  cashout: () => call<{ voucher: Voucher; moved: string }>("/cashout", { method: "POST", body: "{}" }, true),
  /** Re-issues the voucher for what is already owed (a lost or expired one). */
  voucher: () => call<{ voucher: Voucher }>("/voucher", { method: "POST", body: "{}" }, true),
  faucet: (address: string, eth: string) =>
    call<{ lobbyCoins: number }>("/dev/faucet", { method: "POST", body: JSON.stringify({ address, eth }) }),
};
