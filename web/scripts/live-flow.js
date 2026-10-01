(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = "http://localhost:8962";
  const post = (p, b) => fetch(S + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  const addr = "0x00000000000000000000000000000000000a11ce";
  const out = {};
  out.pot = await post("/dev/faucet-pot", { eth: "0.3" });
  out.faucet = await post("/dev/faucet", { address: addr, eth: "0.02" });
  const { token } = await post("/auth/dev", { address: addr });
  localStorage.setItem("frenzy.session", token);
  const g = window.__game;
  g.reconnect();
  await wait(2500);
  out.afterSignIn = { phase: g.phase, practice: g.practice, live: g.welcome?.live, lobby: g.you?.lobbyCoins, note: g.welcome?.liveNote };
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.startsWith("Dive in"));
  out.button = btn ? btn.textContent : "no dive button: " + [...document.querySelectorAll(".card button")].map((b) => b.textContent).join(" | ");
  btn?.click();
  await wait(1500);
  out.afterSpawn = { phase: g.phase, lobby: g.you?.lobbyCoins, stake: g.stake, my: g.myCoins, fish: g.fish.size, orbs: g.pellets.size };
  // Swim on the pilot for a while, then hold the cash-out.
  await wait(47000);
  out.mid = { phase: g.phase, my: g.myCoins, kills: g.kills, opensIn: g.cashOpensIn(), fish: g.fish.size, orbs: g.pellets.size };
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
  for (let i = 0; i < 80 && g.phase === "playing"; i++) await wait(250);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "c" }));
  await wait(800);
  out.end = { phase: g.phase, lobby: g.you?.lobbyCoins, cashed: g.lastCash?.coins, death: g.lastDeath ? { by: g.lastDeath.killerName, coins: g.lastDeath.coins } : null };
  out.card = document.querySelector(".card h1")?.textContent;
  out.books = await fetch(S + "/books").then((r) => r.json());
  return out;
})()
