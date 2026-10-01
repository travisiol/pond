import * as fs from "fs";
import * as path from "path";
import hre from "hardhat";
import { ethers, network } from "hardhat";
import { deploymentsDir, exportAbis, type DeploymentRecord } from "./lib/exportAbi";

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

function addressFromEnv(name: string): string | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  if (!ethers.isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return ethers.getAddress(v);
}

const LOCAL_NETWORKS = ["hardhat", "localhost"];

/**
 * Deploys the Arena. It holds native ETH, so there is no token to point it at.
 *
 *   SIGNER_ADDRESS  the game server's voucher key (the address, never the key).
 *                   Required on a live network. On hardhat/localhost it falls
 *                   back to the deployer with a loud warning.
 *   OWNER_ADDRESS   owns the Arena: rotates the signer, pauses, rescues.
 *                   Defaults to the deployer.
 *   MIN_DEPOSIT     optional, in ETH (e.g. 0.001). Only applied when the
 *                   deployer is the owner, because setMinDeposit is owner-only.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY in contracts/.env for this network.");
  }
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = LOCAL_NETWORKS.includes(network.name);

  console.log(`Network   : ${network.name} (chainId ${chainId})`);
  console.log(`Deployer  : ${deployer.address}`);

  const configuredSigner = addressFromEnv("SIGNER_ADDRESS");
  if (!configuredSigner && !local) {
    throw new Error("SIGNER_ADDRESS is required on a live network: it is the address of the game server's voucher key.");
  }
  const signer = configuredSigner ?? deployer.address;
  if (!configuredSigner) {
    console.warn("WARNING   : SIGNER_ADDRESS not set — the deployer is the voucher signer (local networks only).");
  }
  const owner = addressFromEnv("OWNER_ADDRESS") ?? deployer.address;
  console.log(`Signer    : ${signer}`);
  console.log(`Owner     : ${owner}${owner === deployer.address ? " (deployer)" : ""}`);

  const arena = await (await ethers.getContractFactory("Arena")).deploy(signer, owner);
  await arena.waitForDeployment();
  const arenaAddress = await arena.getAddress();
  const receipt = await arena.deploymentTransaction()?.wait();
  const block = receipt?.blockNumber ?? 0;
  console.log(`Arena     : ${arenaAddress} (block ${block})`);

  const minDeposit = env("MIN_DEPOSIT");
  if (minDeposit) {
    if (owner === deployer.address) {
      await (await arena.setMinDeposit(ethers.parseEther(minDeposit))).wait();
      console.log(`MinDeposit: ${minDeposit} ETH`);
    } else {
      console.warn(`WARNING   : MIN_DEPOSIT not applied — the owner (${owner}) must call setMinDeposit itself.`);
    }
  }

  const record: DeploymentRecord = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    owner,
    signer,
    block,
    timestamp: new Date().toISOString(),
    contracts: { Arena: arenaAddress },
  };
  const dir = deploymentsDir(hre);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`Saved     : ${path.relative(process.cwd(), file)}`);

  await exportAbis(hre);

  if (network.name === "hardhat") {
    console.log("\nNote: the in-process hardhat network is gone when this script exits. This address is a dry run, not a deployment.");
  }

  console.log("\nServer env:");
  console.log(`  ARENA_ADDRESS=${arenaAddress}`);
  console.log(`  CHAIN_ID=${chainId}`);
  console.log(`  START_BLOCK=${block}`);
  console.log("  PAYOUT_SIGNER_KEY=<the private key whose address is the Signer above — never commit it>");
  console.log("Web env:");
  console.log(`  NEXT_PUBLIC_GAME_ARENA=${arenaAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
