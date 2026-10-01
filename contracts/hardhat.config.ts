import { HardhatUserConfig, task } from "hardhat/config";
import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import { exportAbis } from "./scripts/lib/exportAbi";

dotenv.config();

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/**
 * Robinhood Chain (Arbitrum Orbit). Chain id 4663 (0x1237).
 * Override the RPC with ROBINHOOD_RPC_URL if you run your own node.
 */
const ROBINHOOD_RPC_URL =
  process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ROBINHOOD_CHAIN_ID = Number(process.env.ROBINHOOD_CHAIN_ID ?? 4663);

/**
 * Every successful `hardhat compile` re-exports the ABIs into
 * ../web/src/lib/abi so the two packages can never drift apart.
 * Set SKIP_ABI_EXPORT=true to opt out (CI that only runs tests, for example).
 */
task(TASK_COMPILE, async (args, hre, runSuper) => {
  const result = await runSuper(args);
  if (process.env.SKIP_ABI_EXPORT !== "true") {
    await exportAbis(hre);
  }
  return result;
});

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 800 },
      // Hardhat 2 pins solc >= 0.8.20 to "paris", but OpenZeppelin 5.6's
      // Strings/Bytes (pulled in by every ERC721) use MCOPY, which needs
      // "cancun". Robinhood Chain (Arbitrum Orbit, ArbOS 30+) supports it.
      // Override with SOLIDITY_EVM_VERSION if you target an older chain.
      evmVersion: process.env.SOLIDITY_EVM_VERSION || "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    robinhood: {
      url: ROBINHOOD_RPC_URL,
      chainId: ROBINHOOD_CHAIN_ID,
      accounts,
    },
  },
  etherscan: {
    // Robinhood Chain's explorer is not in hardhat-verify's default list.
    // Fill ROBINHOOD_EXPLORER_API_URL / ROBINHOOD_EXPLORER_URL in .env to verify.
    apiKey: {
      robinhood: process.env.ROBINHOOD_EXPLORER_API_KEY ?? "no-key-required",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: ROBINHOOD_CHAIN_ID,
        urls: {
          apiURL: process.env.ROBINHOOD_EXPLORER_API_URL ?? "",
          browserURL: process.env.ROBINHOOD_EXPLORER_URL ?? "",
        },
      },
    ],
  },
  sourcify: { enabled: false },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 60_000,
  },
};

export default config;
