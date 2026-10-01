import { Bots } from "../../web/src/shared/bots";
import type { World } from "../../web/src/shared/sim";
import { drawPot } from "./db";
import { config, entrySplit } from "./config";

export type { Bots };

/**
 * The shared bot brain, paid for by the pot. Bots enter at different
 * sizes around what a player's shark is worth after the fee (bots pay no
 * fee), so there is always something to eat and something to run from,
 * and only if the pot can cover it: a dry pot means no new bots. Pot coins on a bot are
 * still pot coins — a bot never cashes out, a bot that grows too rich
 * swims off and `retire` hands everything it held back to the pot, and on
 * a restart the bots' coins go back to the pot too.
 */
export function makeBots(world: World, retire: (coins: number) => void): Bots {
  const stake = entrySplit().stake;
  return new Bots(world, {
    count: config.botCount,
    stake: (size) => {
      const coins = Math.floor(stake * size);
      return drawPot(coins) ? coins : 0;
    },
    retire,
  });
}
