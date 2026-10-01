"use client";

import type { GameClient } from "@/game/net";
import { FLAG_CASHING } from "@/shared/protocol";
import { RULES, canEat, coinsToEth } from "@/shared/rules";
import { site } from "@/lib/site";
import { sound } from "@/lib/sound";

const hold = (set: (v: boolean) => void) => ({
  onPointerDown: (e: React.PointerEvent) => {
    e.preventDefault();
    set(true);
  },
  onPointerUp: () => set(false),
  onPointerLeave: () => set(false),
  onPointerCancel: () => set(false),
});

export function Hud({
  client,
  onBoost,
  onCash,
}: {
  client: GameClient;
  onBoost: (v: boolean) => void;
  onCash: (v: boolean) => void;
}) {
  const on = sound.use();
  const playing = client.phase === "playing";
  const me = client.fish.get(client.myId);
  const coins = me?.coins ?? client.myCoins;
  const entry = client.entry();
  const stake = client.stake || entry;
  const change = stake > 0 ? ((coins - stake) / stake) * 100 : 0;
  const opensIn = client.cashOpensIn();
  const cashing = !!me && (me.flags & FLAG_CASHING) !== 0;
  const board = client.board;
  // The two numbers that decide everything: what I can swallow, what can swallow me.
  const eatBelow = Math.floor(coins / RULES.eatRatio);
  const dangerAbove = Math.ceil(coins * RULES.eatRatio);
  // The nearest shark that can eat me, if it is close enough to matter.
  let hunter: { name: string; dist: number } | null = null;
  if (playing && me) {
    for (const f of client.fish.values()) {
      if (f.id === me.id || !canEat(f.coins, me.coins)) continue;
      const dist = Math.hypot(f.x - me.x, f.y - me.y);
      if (dist < 520 && (!hunter || dist < hunter.dist)) hunter = { name: f.name, dist };
    }
  }
  const meal = client.lastMeal && client.now - client.lastMeal.at < 2.6 ? client.lastMeal : null;

  return (
    <>
      <header className="topbar">
        <span className="wordmark">{site.name}</span>
        <span className={`mode ${client.practice ? "practice" : "live"}`}>
          {client.phase === "connecting"
            ? "connecting…"
            : client.practice
              ? "practice · play money"
              : client.welcome?.live
                ? "live · real ETH"
                : "test server · play money"}
        </span>
        <button className="ghost" onClick={() => sound.toggle()} aria-pressed={on}>
          {on ? "Sound on" : "Sound off"}
        </button>
      </header>

      {playing && (
        <div className="worth">
          <span className="label">Your shark is worth</span>
          <span className="eth">
            {coinsToEth(coins)} <small>ETH</small>
          </span>
          <span className={`delta ${change >= 0 ? "up" : "down"}`}>
            {change >= 0 ? "+" : ""}
            {change.toFixed(0)}% on the {coinsToEth(stake)} you came in with · {client.kills} eaten
          </span>
          <span className="limits">
            <b className="food">You can eat</b> anything under {coinsToEth(eatBelow)} ETH
            <br />
            <b className="threat">Eats you</b> anything over {coinsToEth(dangerAbove)} ETH
          </span>
        </div>
      )}

      {hunter && <div className="alarm" aria-hidden="true" />}
      {hunter && (
        <div className="warning" role="status">
          DANGER · {hunter.name} can eat you · {Math.round(hunter.dist / 10)} m
        </div>
      )}
      {meal && (
        <div key={meal.id} className="meal" role="status">
          You ate {meal.name}
          <b>+{coinsToEth(meal.coins)} ETH</b>
        </div>
      )}

      {board && (
        <aside className="board" aria-label="Biggest sharks">
          <h2>Biggest sharks</h2>
          <ol>
            {board.top.slice(0, 8).map((r) => (
              <li key={r.id} className={r.id === client.myId ? "me" : undefined}>
                <span>{r.id === client.myId ? "you" : r.name}</span>
                <b>{coinsToEth(r.coins)}</b>
              </li>
            ))}
          </ol>
          <p>
            {board.alive} sharks · {coinsToEth(board.floor)} ETH in orbs · pot {coinsToEth(board.pot)}
          </p>
        </aside>
      )}

      <ul className="feed" aria-live="polite">
        {client.feed.map((f) => (
          <li key={f.id} className={`${f.kind}${f.mine ? " mine" : ""}`}>
            {f.text} <b>{coinsToEth(f.coins)} ETH</b>
          </li>
        ))}
      </ul>

      {playing && (
        <div className="controls">
          <button className={`cash${opensIn > 0 ? " locked" : ""}${cashing ? " active" : ""}`} disabled={opensIn > 0} {...hold(onCash)}>
            <i style={{ width: `${(me?.cash ?? 0) * 100}%` }} />
            <span>
              {opensIn > 0
                ? `Cash out opens in ${Math.ceil(opensIn)} s`
                : cashing
                  ? `Keep holding… ${coinsToEth(coins)} ETH`
                  : `Hold C to cash out ${coinsToEth(coins)} ETH`}
            </span>
          </button>
          <button className="sprint" {...hold(onBoost)}>
            Sprint
          </button>
        </div>
      )}
    </>
  );
}
