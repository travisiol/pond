/**
 * Everything that names the project lives here. A rename is this object
 * plus the NEXT_PUBLIC_GAME_* values in the environment.
 */
export const site = {
  name: "FRENZY",
  tagline: "Eat or be eaten. Every bite is ETH.",
  description:
    "A shark-eat-shark arena on Robinhood Chain. Every shark is worth the ETH it has eaten. Swallow smaller sharks, run from bigger ones, and cash out before something swallows you.",
  url: process.env.NEXT_PUBLIC_GAME_URL ?? "",
  x: process.env.NEXT_PUBLIC_GAME_X ?? "",
  /** The Arena contract. Empty until it is deployed. */
  arenaAddress: (process.env.NEXT_PUBLIC_GAME_ARENA ?? "") as `0x${string}` | "",
  /** The token the game is tied to. Empty until it exists. */
  token: {
    symbol: process.env.NEXT_PUBLIC_GAME_TOKEN_SYMBOL ?? "",
    address: (process.env.NEXT_PUBLIC_GAME_TOKEN ?? "") as `0x${string}` | "",
    buyUrl: process.env.NEXT_PUBLIC_GAME_TOKEN_BUY_URL ?? "",
  },
} as const;

const configuredServer = (process.env.NEXT_PUBLIC_GAME_SERVER ?? "").replace(/\/$/, "");

/**
 * Where the game server is. Three cases, in order:
 *   1. `NEXT_PUBLIC_GAME_SERVER` is set: the page was built for a known server;
 *   2. the page is not on localhost: the server served it (it hands out
 *      `web/out` itself), so it lives at the same origin;
 *   3. localhost: `next dev` on its own port, talking to the dev server.
 */
export function serverUrl(): string {
  if (configuredServer) return configuredServer;
  if (typeof window !== "undefined") {
    const { hostname, origin, protocol } = window.location;
    const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
    if (!local && (protocol === "http:" || protocol === "https:")) return origin;
  }
  return "http://localhost:8962";
}

export function socketUrl(): string {
  return serverUrl().replace(/^http/, "ws") + "/ws";
}
