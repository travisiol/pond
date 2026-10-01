"use client";

import { useState } from "react";
import type { GameClient } from "@/game/net";
import { RULES, coinsToEth, splitEntry } from "@/shared/rules";
import { explorer } from "@/lib/chain";
import { site } from "@/lib/site";
import { useWallet } from "./wallet";

const pct = (bps: number) => `${bps / 100}%`;

export function Lobby({ client }: { client: GameClient }) {
  const wallet = useWallet(client);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [tab, setTab] = useState<"play" | "rules" | "wallet">("play");

  const w = client.welcome;
  const eco = w?.economy ?? { entryCoins: RULES.entryCoins, feeBps: RULES.feeBps, feePotShareBps: RULES.feePotShareBps };
  const split = splitEntry(eco.entryCoins, eco.feeBps, eco.feePotShareBps);
  const entryEth = coinsToEth(eco.entryCoins);
  const lobby = client.you?.lobbyCoins ?? 0;
  const live = !!w?.live && !client.practice;
  const arena = w?.arena || site.arenaAddress;
  const canPlayLive = wallet.signedIn && lobby >= eco.entryCoins;
  const owed = client.you ? BigInt(client.you.claimableWei) - BigInt(client.you.claimedWei) : 0n;
  const death = client.phase === "dead" ? client.lastDeath : null;
  const cash = client.phase === "cashed" ? client.lastCash : null;
  const stake = client.stake || split.stake;

  const play = () => {
    client.acknowledge();
    client.spawn(name.trim() || undefined);
  };

  return (
    <div className={`lobby${death ? " lost" : ""}`}>
      <div className="card">
        {death && (
          <div className="result lost">
            <h1>Eaten by {death.killerName ?? "something bigger"}.</h1>
            <p>
              Your shark was worth <b>{coinsToEth(death.coins)} ETH</b>. {coinsToEth(death.gained)} went into{" "}
              {death.killerName ?? "the eater"}, the rest is in the water as orbs.
            </p>
          </div>
        )}
        {cash && (
          <div className="result won">
            <h1>Cashed out {coinsToEth(cash.coins)} ETH.</h1>
            <p>
              You came in with {coinsToEth(stake)}.{" "}
              {cash.coins >= stake
                ? `That is +${coinsToEth(cash.coins - stake)} ETH on this life.`
                : `That is ${coinsToEth(stake - cash.coins)} ETH less than you started with.`}{" "}
              {client.practice ? "Play money: nothing to withdraw." : "It is in your balance, ready to play again or withdraw."}
            </p>
          </div>
        )}
        {!death && !cash && (
          <div className="intro">
            <h1>{site.name}</h1>
            <p>{site.tagline}</p>
          </div>
        )}

        <div className="tabs" role="tablist">
          {(["play", "rules", "wallet"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "play" ? "Play" : t === "rules" ? "How the money works" : "Balance"}
            </button>
          ))}
        </div>

        {tab === "play" && (
          <div className="pane">
            <ul className="three">
              <li>
                <b>Eat</b>
                Orbs are ETH. Sharks with a green ring and EAT are yours: sprint and swim into them.
              </li>
              <li>
                <b>Run</b>
                Anything {Math.round((RULES.eatRatio - 1) * 100)}% richer than you swallows you whole. Red ring and DANGER: swim away.
              </li>
              <li>
                <b>Cash out</b>
                Hold C for {w?.timing.cashSeconds ?? RULES.cashSeconds} seconds and leave with what you carry.
              </li>
            </ul>
            <label className="field">
              Name
              <input value={name} maxLength={14} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
            </label>
            {client.error && <p className="error">{client.error}</p>}
            <div className="actions">
              {client.practice ? (
                <button className="primary" onClick={play} disabled={client.phase === "connecting"}>
                  Dive in · play money
                </button>
              ) : !wallet.signedIn ? (
                <button className="primary" onClick={() => wallet.signIn()} disabled={!!wallet.busy}>
                  {wallet.busy ?? `Connect wallet to play for ${entryEth} ETH`}
                </button>
              ) : canPlayLive ? (
                <button className="primary" onClick={play}>
                  Dive in · {entryEth} ETH
                </button>
              ) : (
                <button className="primary" onClick={() => setTab("wallet")}>
                  Deposit to play · balance {coinsToEth(lobby)} ETH
                </button>
              )}
              {client.practice ? (
                client.serverReachable && (
                  <button className="secondary" onClick={() => client.setPractice(false)}>
                    Play for real ETH
                  </button>
                )
              ) : (
                <button className="secondary" onClick={() => client.setPractice(true)}>
                  Practice with play money
                </button>
              )}
            </div>
            {wallet.error && <p className="error">{wallet.error}</p>}
            <p className="fine">
              Point at the water and your shark swims there (the gold ring shows where). A and D also turn it. Hold the
              mouse button or Space to sprint. The radar
              shows what is behind you: red can eat you, green is food.
            </p>
            <p className="fine">
              {client.practice
                ? client.serverReachable
                  ? "Practice ocean: same rules and bots, nothing here is real ETH."
                  : "No game server answered, so this is the practice ocean: same rules and bots, play money."
                : live
                  ? `One life costs ${entryEth} ETH. You can lose all of it.`
                  : (w?.liveNote ?? "Connecting…")}
            </p>
          </div>
        )}

        {tab === "rules" && (
          <div className="pane">
            <table>
              <tbody>
                <tr>
                  <th>One life</th>
                  <td>
                    {entryEth} ETH, the same for everyone. Nobody buys a bigger shark.
                  </td>
                </tr>
                <tr>
                  <th>Your shark</th>
                  <td>
                    Starts worth {coinsToEth(split.stake)} ETH. Its size is its value.
                  </td>
                </tr>
                <tr>
                  <th>Entry fee</th>
                  <td>
                    {pct(eco.feeBps)} ({coinsToEth(split.fee, 5)} ETH): {coinsToEth(split.toPot, 5)} rains back into the
                    water as orbs, {coinsToEth(split.toTreasury, 5)} goes to the treasury. It is the only money that
                    leaves the table.
                  </td>
                </tr>
                <tr>
                  <th>Eating</th>
                  <td>
                    When a shark is swallowed, {pct(RULES.eatGainBps)} of its ETH goes to the eater and the rest scatters
                    as orbs for anyone.
                  </td>
                </tr>
                <tr>
                  <th>Sprinting</th>
                  <td>Costs you: it sheds your own ETH behind you as orbs.</td>
                </tr>
                <tr>
                  <th>Cashing out</th>
                  <td>
                    Opens after {w?.timing.minStaySeconds ?? RULES.minStaySeconds} s alive. Hold for{" "}
                    {w?.timing.cashSeconds ?? RULES.cashSeconds} s, slowed and still edible. No fee on the way out.
                  </td>
                </tr>
                <tr>
                  <th>Bots</th>
                  <td>
                    Swim on pot money only, never cash out, and hand it back to the pot when they grow too big. They
                    cannot take ETH off the table.
                  </td>
                </tr>
                <tr>
                  <th>So</th>
                  <td>
                    Every ETH a player wins is an ETH another player lost, or an orb the pot rained. Most lives end
                    eaten. Play with what you can lose.
                  </td>
                </tr>
              </tbody>
            </table>
            {site.token.symbol && (
              <p className="fine">
                ${site.token.symbol} is the game&apos;s token. Its trading fees are meant to fund the pot that rains orbs
                here.
              </p>
            )}
          </div>
        )}

        {tab === "wallet" && (
          <div className="pane">
            {client.practice ? (
              <p>
                Practice balance: <b>{coinsToEth(lobby)} ETH</b> of play money. It refills by itself and cannot be
                withdrawn.
              </p>
            ) : !wallet.signedIn ? (
              <>
                <p>Connect a wallet on Robinhood Chain to deposit, play and withdraw.</p>
                <div className="actions">
                  {wallet.connectors.map((c) => (
                    <button key={c.uid} className="secondary" onClick={() => wallet.signIn(c.uid)} disabled={!!wallet.busy}>
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="balance">
                  <span>Balance in the game</span>
                  <b>{coinsToEth(lobby)} ETH</b>
                </p>
                {!live && <p className="error">{w?.liveNote ?? "Deposits and withdrawals are closed."}</p>}
                <label className="field">
                  Deposit (ETH)
                  <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
                </label>
                <div className="actions">
                  <button className="primary" disabled={!live || !arena || !!wallet.busy} onClick={() => arena && wallet.deposit(arena, amount)}>
                    {wallet.busy === "Depositing" ? "Confirm in your wallet…" : "Deposit"}
                  </button>
                  <button className="secondary" disabled={!live || lobby <= 0 || !!wallet.busy} onClick={() => wallet.withdraw()}>
                    {wallet.busy === "Withdrawing" ? "Confirm in your wallet…" : `Withdraw ${coinsToEth(lobby)} ETH`}
                  </button>
                  {owed > 0n && (
                    <button className="secondary" disabled={!live || !!wallet.busy} onClick={() => wallet.reclaim()}>
                      Finish a pending withdrawal
                    </button>
                  )}
                </div>
                <p className="fine">
                  Signed in as {client.you?.address.slice(0, 6)}…{client.you?.address.slice(-4)}.{" "}
                  <button className="link" onClick={wallet.signOut}>
                    Sign out
                  </button>
                  {arena && (
                    <>
                      {" · "}
                      <a href={explorer.address(arena)} target="_blank" rel="noreferrer">
                        Arena contract
                      </a>
                    </>
                  )}
                </p>
              </>
            )}
            {wallet.error && <p className="error">{wallet.error}</p>}
            {wallet.note && <p className="fine">{wallet.note}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
