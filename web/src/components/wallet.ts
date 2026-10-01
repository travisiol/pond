"use client";

import { useCallback, useState } from "react";
import { parseEther } from "viem";
import { useConnect, useConnection, useConnectors, useDisconnect, useSignMessage, useSwitchChain, useWriteContract } from "wagmi";
import { api, setSession } from "@/lib/api";
import { arenaAbi } from "@/lib/abi/Arena";
import { robinhoodChain } from "@/lib/chain";
import type { GameClient } from "@/game/net";

function plain(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/rejected|denied|declined|cancel/i.test(text)) return "Your wallet declined. Nothing was signed and nothing moved.";
  if (/insufficient funds/i.test(text)) return "This wallet does not hold enough ETH on Robinhood Chain for that.";
  return text.split("\n")[0];
}

/**
 * Connect + sign in as one gesture: the wallet signs a sentence carrying a
 * nonce, the server answers with a session, and the socket reconnects with
 * it so the next welcome carries the balance.
 */
export function useWallet(client: GameClient) {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const sign = useSignMessage();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const sessionAddress = client.you?.address ?? null;
  const signedIn = !client.practice && !!sessionAddress && (!address || sessionAddress === address.toLowerCase());

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    setError(null);
    setNote(null);
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      setError(plain(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const signIn = useCallback(
    (connectorUid?: string) =>
      run("Signing in", async () => {
        let addr = address;
        if (!isConnected || !addr) {
          const connector = connectors.find((c) => c.uid === connectorUid) ?? connectors[0];
          if (!connector) throw new Error("No wallet found in this browser. On a phone, open this page inside your wallet's browser.");
          const r = await connect.mutateAsync({ connector });
          addr = r.accounts[0];
        }
        if (!addr) throw new Error("No wallet found in this browser.");
        const { message, nonce } = await api.nonce(addr);
        const signature = await sign.mutateAsync({ message });
        const v = await api.verify(addr, nonce, message, signature);
        setSession(v.token);
        client.reconnect();
      }),
    [address, isConnected, connectors, connect, sign, client, run],
  );

  const signOut = useCallback(() => {
    setSession(null);
    disconnect.mutate();
    client.reconnect();
  }, [disconnect, client]);

  const onChain = useCallback(async () => {
    if (chainId !== robinhoodChain.id) await switchChain.mutateAsync({ chainId: robinhoodChain.id });
  }, [chainId, switchChain]);

  /** Sends ETH to the Arena. The server credits the balance once the chain confirms it. */
  const deposit = useCallback(
    (arena: string, eth: string) =>
      run("Depositing", async () => {
        const value = parseEther(eth);
        if (value <= 0n) throw new Error("Enter an amount of ETH to deposit.");
        await onChain();
        const hash = await write.mutateAsync({ address: arena as `0x${string}`, abi: arenaAbi, functionName: "deposit", value });
        setNote(`Deposit sent (${hash.slice(0, 10)}…). Your balance updates once the chain confirms it.`);
      }),
    [onChain, write, run],
  );

  /** Turns the whole balance into a signed voucher and claims it on chain. */
  const withdraw = useCallback(
    () =>
      run("Withdrawing", async () => {
        const { voucher } = await api.cashout();
        await onChain();
        const hash = await write.mutateAsync({
          address: voucher.arena as `0x${string}`,
          abi: arenaAbi,
          functionName: "claim",
          args: [BigInt(voucher.cumulative), BigInt(voucher.deadline), voucher.signature],
        });
        setNote(`Withdrawal sent (${hash.slice(0, 10)}…). The ETH arrives in your wallet with that transaction.`);
      }),
    [onChain, write, run],
  );

  /** Re-sends a voucher that was signed but never claimed. */
  const reclaim = useCallback(
    () =>
      run("Withdrawing", async () => {
        const { voucher } = await api.voucher();
        await onChain();
        const hash = await write.mutateAsync({
          address: voucher.arena as `0x${string}`,
          abi: arenaAbi,
          functionName: "claim",
          args: [BigInt(voucher.cumulative), BigInt(voucher.deadline), voucher.signature],
        });
        setNote(`Withdrawal sent (${hash.slice(0, 10)}…).`);
      }),
    [onChain, write, run],
  );

  return { address, isConnected, connectors, signedIn, busy, error, note, signIn, signOut, deposit, withdraw, reclaim };
}
