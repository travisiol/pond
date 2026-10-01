// Local play on any OS: chain off, play money, the dev doors open.
//   node --import tsx scripts/dev-local.mjs
process.env.CHAIN ??= "off";
process.env.DEV_FAUCET ??= "true";
process.env.DEV_AUTH ??= "true";
await import("../src/index.ts");
