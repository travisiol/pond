# FRENZY

Eat or be eaten. Every bite is ETH.

A fish-eat-fish arena in a 3D ocean, played for ETH on Robinhood Chain
(chain id 4663). Every fish is worth the ETH it has eaten; its size is its
value. The name is provisional and lives in `web/src/lib/site.ts` and the
server's `APP_NAME`.

Three packages, no workspaces:

| Folder | What |
| --- | --- |
| `web/` | The page: Next 16 static export, three.js ocean, wagmi wallet. `web/src/shared/` is the simulation, imported by the server too. |
| `server/` | The referee: 20 Hz authoritative simulation over WebSocket, the ETH ledger in SQLite, deposit watcher, voucher signer. It also serves `web/out`. |
| `contracts/` | `Arena.sol`: ETH in through `deposit`, out through server-signed `claim` vouchers, `fund` for the pot. |

## The rules of the money

- One life costs the same for everyone (`ENTRY_COINS`, default 0.002 ETH). Nobody buys a bigger fish.
- 10% of each entry is a fee (`FEE_BPS`): half goes to the pot, which rains back into the water as orbs, half to the treasury (`FEE_POT_SHARE_BPS`, `TREASURY_ADDRESS`). This is the only money that leaves the table.
- Orbs are ETH. Eating one adds its value to your fish.
- A fish 15% richer than another can swallow it: 80% of the victim's ETH goes to the eater, 20% scatters as orbs.
- Sprinting sheds your own ETH behind you.
- Cashing out opens after 45 s alive and takes 5 s, slowed and still edible. No fee on the way out. A dropped connection cashes out by itself after the same wait.
- Bots swim on pot money only, never cash out, and return what they hold to the pot when they grow past six entries.

So the game is zero-sum between players, minus the treasury's share, plus
whatever the pot adds. The pot is a subsidy: when it runs dry the rain and
the bots stop and players only win from each other. Keeping it funded
(`fund()` on the contract, or plain ETH sent to it) is what a token's
trading fees are for.

`npm run economy --prefix web` plays an hour with scripted players of
different skill and prints where every coin went.

## Run it locally

```bash
npm run install:all
npm run build
npm run server:dev
```

Then open http://localhost:8962. That server runs with the chain off: play
money, a faucet (`POST /dev/faucet {address, eth}`, `POST /dev/faucet-pot
{eth}`) and a no-signature sign-in (`POST /auth/dev {address}`).

With no server at all the page still works: it runs the same simulation in
the browser as a practice ocean with play money.

For page development: `npm run dev --prefix web` (port 3000 unless you pass
`-- --port`), talking to the server on 8962.

## Go live

Nothing is deployed. To open real-ETH play:

1. Deploy `Arena` (`contracts/README.md`) with `SIGNER_ADDRESS` = the address of the server's signing key and `OWNER_ADDRESS` = a wallet you control.
2. Run the server with `CHAIN=on`, `ARENA_ADDRESS`, `PAYOUT_SIGNER_KEY`, `TREASURY_ADDRESS`, `START_BLOCK` (see `server/.env.example`). It refuses to start with the dev doors open.
3. Build the page with `NEXT_PUBLIC_GAME_ARENA` set (see `web/.env.example`), or let the server serve it.
4. Fund the pot so the water has orbs and bots.

The server cannot run on Vercel (WebSocket, a 20 Hz loop, a SQLite file).
`server/Dockerfile`, `railway.json` and `fly.toml` build one service that is
the whole game. `vercel.json` builds the page alone; point it at the server
with `NEXT_PUBLIC_GAME_SERVER`.

## Trust, stated plainly

- The server is the referee. It decides who ate whom and signs every withdrawal. Whoever holds `PAYOUT_SIGNER_KEY` can authorise any payout the contract can cover.
- The contract owner can move ETH out with `rescue`, players' deposits included.
- The contract is unaudited, and the chain path (deposit event → balance, voucher → claim) has only been exercised in contract tests, never with a real wallet.
- Real-money games are regulated in many places. Check what applies to you before opening this to the public.

## Checks

```bash
npm test          # simulation checks + contract tests
npm run check     # lint + typecheck
npm run e2e --prefix server    # needs port 8962 free
npm run soak --prefix server   # 30 simulated minutes, ledger checked every tick
```
