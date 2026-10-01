/**
 * Every number the game is made of, in one place. The server, the browser
 * and the headless tests all import this file, so a rule has one value.
 *
 * Money inside the arena is counted in whole "coins":
 * 1 coin = 0.000001 ETH (10^12 wei). Nothing in the arena is fractional,
 * so the books can be checked to the coin after every tick.
 */
export const RULES = {
  /** Simulation rate. The server steps the world this many times a second. */
  tickHz: 20,
  /** The ocean is a disc. The edge is a wall: it stops you, it does not kill. */
  arenaRadius: 2600,

  /**
   * What one life costs by default: 0.002 ETH. Every fish enters at the
   * same price, so nobody buys size. The server may run another price and
   * says so in its welcome.
   */
  entryCoins: 2_000,
  /**
   * Taken from every entry before the fish spawns, in basis points. Half
   * rains back into the water as orbs, half goes to the treasury. This is
   * the only money that ever leaves the table.
   */
  feeBps: 1_000,
  /** Share of that fee that goes to the pot (and so back to players). */
  feePotShareBps: 5_000,

  /** Cruise speed of a fresh fish, units per second. Bigger fish are slower. */
  baseSpeed: 190,
  speedExponent: 0.14,
  /** Sprinting multiplies speed and sheds coins behind you. */
  boostFactor: 1.8,
  /** Turn rate of a fresh fish, radians per second. */
  turnRate: 4.4,
  turnExponent: 0.12,

  /** Body length of a fresh fish, and how length grows with value. */
  baseLength: 64,
  lengthExponent: 0.4,
  /** Longest a fish can get, however rich. */
  maxLength: 520,

  /** You can swallow a fish once you hold this many times what it holds. */
  eatRatio: 1.15,
  /** Basis points of the victim's coins that go straight into the eater. */
  eatGainBps: 8_000,
  /** The rest lands in the water as this many orbs, for anyone. */
  eatScatterOrbs: 8,

  /** After spawning you can neither be eaten nor eat fish for this long. */
  spawnShieldSeconds: 3,
  /** You cannot start cashing out before you have been alive this long. */
  minStaySeconds: 45,
  /** Seconds you must hold the cash-out, slow and edible, before you are out. */
  cashSeconds: 5,
  /** Letting go drains the meter this many times faster than it fills. */
  cashDrainFactor: 3,
  /** Speed multiplier while cashing out. */
  cashSlow: 0.55,

  /** Below this fraction of one entry, sprinting is off. */
  boostMinEntryFraction: 0.5,
  /** Seconds between two sheds while sprinting. */
  boostShedInterval: 0.25,
  /** Fraction of your coins each shed drops behind you, floored at one coin. */
  boostShedRate: 0.012,

  /** Orbs this close to a mouth are pulled in and swallowed. */
  magnetReach: 46,
  magnetSpeed: 420,
  pickupSlack: 6,
  /** Above this many orbs the smallest merge into their neighbours. */
  maxPellets: 3000,

  /** One rain orb, as a fraction of an entry (1/400 = 0.000005 ETH by default). */
  rainOrbEntryFraction: 0.0025,
  /**
   * The pot keeps about this many orbs in the water, while it can pay for
   * them. That is one entry's worth of ETH lying around at any moment.
   */
  rainTargetOrbs: 1100,
  /** A bot that has grown to this many entries swims off and returns it all to the pot. */
  botRetireEntries: 6,
} as const;

/** 1 coin = 10^12 wei. Kept out of RULES so RULES stays plain JSON. */
export const WEI_PER_COIN = BigInt("1000000000000");

/** How many entries a stack of coins is worth. This is what size follows. */
export function massOf(coins: number, entry: number): number {
  return Math.max(0.05, coins / Math.max(1, entry));
}

export function lengthFor(coins: number, entry: number): number {
  return Math.min(RULES.maxLength, RULES.baseLength * Math.pow(massOf(coins, entry), RULES.lengthExponent));
}

/** Collision radius of the body: a fish is about a third as wide as it is long. */
export function radiusFor(coins: number, entry: number): number {
  return lengthFor(coins, entry) * 0.27;
}

export function speedFor(coins: number, entry: number): number {
  return RULES.baseSpeed / Math.pow(Math.max(0.4, massOf(coins, entry)), RULES.speedExponent);
}

export function turnRateFor(coins: number, entry: number): number {
  return RULES.turnRate / Math.pow(Math.max(0.4, massOf(coins, entry)), RULES.turnExponent);
}

export function magnetRadiusFor(coins: number, entry: number): number {
  return radiusFor(coins, entry) * 1.6 + RULES.magnetReach;
}

export function canEat(eaterCoins: number, preyCoins: number): boolean {
  return eaterCoins * 100 >= preyCoins * Math.round(RULES.eatRatio * 100) && eaterCoins > preyCoins;
}

/** What is left of an entry after the fee, and where the fee goes. */
export function splitEntry(entry: number, feeBps: number = RULES.feeBps, potShareBps: number = RULES.feePotShareBps) {
  const fee = Math.floor((entry * feeBps) / 10_000);
  const toPot = Math.floor((fee * potShareBps) / 10_000);
  return { stake: entry - fee, fee, toPot, toTreasury: fee - toPot };
}

/** Whole coins → an ETH string: "0.0020", "0.000045", "1.2500". */
export function coinsToEth(coins: number, minDecimals = 4): string {
  const sign = coins < 0 ? "-" : "";
  const abs = Math.abs(Math.round(coins));
  const whole = Math.floor(abs / 1_000_000);
  let frac = String(abs % 1_000_000).padStart(6, "0");
  while (frac.length > minDecimals && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${sign}${whole}.${frac}`;
}

/** "0.002" → whole coins, floored. Returns null for garbage. */
export function ethToCoins(input: string | number): number | null {
  const s = String(input).trim().replace(",", ".");
  if (!/^\d*(\.\d+)?$/.test(s) || s === "" || s === ".") return null;
  const [w = "0", f = ""] = s.split(".");
  const coins = Number(w || "0") * 1_000_000 + Number((f + "000000").slice(0, 6));
  return Number.isFinite(coins) ? coins : null;
}

export function coinsToWei(coins: number): bigint {
  if (!Number.isInteger(coins) || coins < 0) throw new Error(`coinsToWei: bad coins ${coins}`);
  return BigInt(coins) * WEI_PER_COIN;
}

/** Whole coins a wei balance is worth, floored. Dust stays as wei. */
export function weiToCoins(wei: bigint): number {
  return Number(wei / WEI_PER_COIN);
}
