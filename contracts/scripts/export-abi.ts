import hre from "hardhat";
import { exportAbis } from "./lib/exportAbi";

/**
 * Manual ABI export. `hardhat compile` already runs this automatically;
 * use `npm run export-abi` to regenerate ../web/src/lib/abi/Arena.ts
 * (`export const arenaAbi = [...] as const;`). `hardhat run` compiles first,
 * so the file always matches the current Arena.sol.
 */
async function main() {
  await exportAbis(hre);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
