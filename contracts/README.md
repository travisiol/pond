# frenzy-contracts

One contract, `Arena.sol`. It holds the ETH the game is played with on
Robinhood Chain (chain id 4663, native currency ETH). The game itself runs on
the server; the chain only knows balances.

## What it does

- `deposit()` (payable): a player sends ETH in. The contract emits
  `Deposited(player, amount, id)`; the server watches that event and credits
  the player with exactly `amount`.
- `fund()` (payable), or plain ETH sent to the contract address: adds to the
  pot the server scatters as food. Emits `Funded(from, amount)`. Nothing funded
  is owed back to anyone. This is how a token's fee wallet feeds the game.
- `claim(cumulative, deadline, signature)`: pays the caller ETH against a
  voucher signed by the server (EIP-712, domain `FrenzyArena` / `1`, type
  `Claim(address account,uint256 cumulative,uint256 deadline)`). `cumulative`
  is the running total the account has ever been entitled to; the contract
  pays `cumulative - claimed[account]`. Re-submitting a voucher, or submitting
  an older one, reverts with `Arena: nothing to claim`. There is no nonce.
- Owner functions: `setSigner`, `setPaused`, `setMinDeposit`, `rescue`.

There is no per-player ledger on chain. Deposits and funding sit in one
balance; a signed voucher is the only thing that decides who takes what out.

## Trust points

Read these before putting money in.

- **The signer can authorise any payout.** Whatever the signer key signs is
  paid, to any account, up to the whole balance. If the server or its key is
  compromised, the contract can be emptied through `claim`. The defence is
  `setPaused(true)` then `setSigner(newKey)`.
- **The owner can rescue everything.** `rescue(to, amount)` sends any amount of
  the contract's ETH to any address, at any time, paused or not. That includes
  ETH players deposited and expect to claim. It is there to recover a bad
  deployment and to retire the contract. It does not adjust `claimed` or the
  totals, so vouchers already signed stay valid and revert with
  `Arena: ocean is short` until the ETH is back.
- The owner can also rotate the signer, which kills every voucher signed by the
  old key, and transfer or renounce ownership (OpenZeppelin `Ownable`).
- **Pausing** closes `deposit`, `fund`, plain ETH transfers and `claim`. A
  plain transfer sent while paused reverts; the sender keeps its ETH. Pausing
  does not close `rescue`.
- A contract that claims must be able to receive ETH, or its claim reverts
  with `Arena: transfer failed`.
- ETH forced into the contract without calling it (a self-destructing
  contract) shows up in `available()` but in none of the totals.
- The contract has not been audited.

## Run the tests

```
npm install
npx hardhat test
```

31 tests, all on the in-process Hardhat network. `contracts/test/` holds two
test-only helper contracts (a claimer that rejects ETH, a claimer that tries
to re-enter); they are never deployed by the scripts.

Compiling also rewrites `../web/src/lib/abi/Arena.ts`
(`export const arenaAbi = [...] as const;`). `npm run export-abi` does the
same on demand. Set `SKIP_ABI_EXPORT=true` to switch that off.

## Deploy

Dry run on the in-process network (nothing persists, no key needed):

```
npm run deploy:local
```

Robinhood Chain:

1. Put the deployer's key in `contracts/.env` as `DEPLOYER_PRIVATE_KEY=0x...`.
   The file is git-ignored. Never paste the key anywhere else.
2. Set `SIGNER_ADDRESS` to the address of the server's voucher key (the
   address, not the key). It is required on a live network.
3. Optionally set `OWNER_ADDRESS` (defaults to the deployer) and `MIN_DEPOSIT`
   in ETH, e.g. `0.001`. `MIN_DEPOSIT` is only applied when the deployer is the
   owner; otherwise the owner calls `setMinDeposit` itself.
4. `npm run deploy:robinhood`

The script prints the Arena address and the env lines for the server
(`ARENA_ADDRESS`, `CHAIN_ID`, `START_BLOCK`) and the web app
(`NEXT_PUBLIC_GAME_ARENA`), and writes `deployments/<network>.json`.

The live deployment path has not been run: no key was available when this
package was written. Only the in-process run has been exercised.
