import { defineChain } from "viem";

/**
 * Robinhood Chain, chain id 4663, gas and game money in ETH. RPC and
 * explorer URLs are the public defaults and can be overridden from the
 * environment.
 */
export const ROBINHOOD_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ROBINHOOD_CHAIN_ID ?? 4663);

const RPC_URL = process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

export const EXPLORER_URL = (
  process.env.NEXT_PUBLIC_ROBINHOOD_EXPLORER_URL ?? "https://explorer.mainnet.chain.robinhood.com"
).replace(/\/$/, "");

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: EXPLORER_URL },
  },
  testnet: false,
});

export const explorer = {
  address: (a: string) => `${EXPLORER_URL}/address/${a}`,
  tx: (h: string) => `${EXPLORER_URL}/tx/${h}`,
};
