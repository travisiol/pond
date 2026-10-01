import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { Signer } from "ethers";

/** ETH helper: eth("0.5") = 0.5 * 1e18 wei. */
const eth = (n: number | string) => ethers.parseEther(String(n));

/**
 * deployer  owns the Arena
 * signer    the game server's voucher key
 * alice/bob players
 */
async function deployFixture() {
  const [deployer, signer, alice, bob, stranger] = await ethers.getSigners();
  const arena = await (await ethers.getContractFactory("Arena")).deploy(signer.address, deployer.address);
  const arenaAddress = await arena.getAddress();
  return { deployer, signer, alice, bob, stranger, arena, arenaAddress };
}

/** Signs a Claim voucher exactly as the game server does. */
async function voucher(
  arenaAddress: string,
  signer: Signer,
  account: string,
  cumulative: bigint,
  deadline: number | bigint,
): Promise<string> {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return signer.signTypedData(
    { name: "FrenzyArena", version: "1", chainId, verifyingContract: arenaAddress },
    { Claim: [{ name: "account", type: "address" }, { name: "cumulative", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { account, cumulative, deadline },
  );
}

const inAnHour = async () => (await time.latest()) + 3600;

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: deposits", () => {
  it("credits exactly msg.value and numbers deposits from 1", async () => {
    const { arena, arenaAddress, alice, bob } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).deposit({ value: eth("0.1") }))
      .to.emit(arena, "Deposited")
      .withArgs(alice.address, eth("0.1"), 1n);
    await expect(arena.connect(bob).deposit({ value: eth("0.05") }))
      .to.emit(arena, "Deposited")
      .withArgs(bob.address, eth("0.05"), 2n);
    expect(await arena.totalDeposited()).to.equal(eth("0.15"));
    expect(await arena.depositCount()).to.equal(2n);
    expect(await ethers.provider.getBalance(arenaAddress)).to.equal(eth("0.15"));
    expect(await arena.available()).to.equal(eth("0.15"));
  });

  it("takes the ETH out of the depositor's wallet", async () => {
    const { arena, arenaAddress, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).deposit({ value: eth(1) })).to.changeEtherBalances(
      [alice, arenaAddress],
      [-eth(1), eth(1)],
    );
  });

  it("rejects a zero deposit", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).deposit({ value: 0 })).to.be.revertedWith("Arena: amount is zero");
    expect(await arena.depositCount()).to.equal(0n);
  });

  it("enforces the minimum deposit, inclusive", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.setMinDeposit(eth("0.01"))).to.emit(arena, "MinDepositSet").withArgs(eth("0.01"));
    await expect(arena.connect(alice).deposit({ value: eth("0.01") - 1n })).to.be.revertedWith("Arena: below minimum");
    await expect(arena.connect(alice).deposit({ value: eth("0.01") }))
      .to.emit(arena, "Deposited")
      .withArgs(alice.address, eth("0.01"), 1n);
  });

  it("rejects deposits while paused and takes them again once reopened", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.setPaused(true)).to.emit(arena, "PausedSet").withArgs(true);
    await expect(arena.connect(alice).deposit({ value: eth(1) })).to.be.revertedWith("Arena: paused");
    await arena.setPaused(false);
    await arena.connect(alice).deposit({ value: eth(1) });
    expect(await arena.totalDeposited()).to.equal(eth(1));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: funding", () => {
  it("takes funding from anyone and counts it apart from deposits", async () => {
    const { arena, deployer, bob } = await loadFixture(deployFixture);
    await expect(arena.fund({ value: eth(2) })).to.emit(arena, "Funded").withArgs(deployer.address, eth(2));
    await expect(arena.connect(bob).fund({ value: eth("0.5") })).to.emit(arena, "Funded").withArgs(bob.address, eth("0.5"));
    expect(await arena.totalFunded()).to.equal(eth("2.5"));
    expect(await arena.totalDeposited()).to.equal(0n);
    expect(await arena.depositCount()).to.equal(0n);
    expect(await arena.available()).to.equal(eth("2.5"));
  });

  it("counts a plain ETH transfer as funding", async () => {
    const { arena, arenaAddress, stranger } = await loadFixture(deployFixture);
    await expect(stranger.sendTransaction({ to: arenaAddress, value: eth(3) }))
      .to.emit(arena, "Funded")
      .withArgs(stranger.address, eth(3));
    expect(await arena.totalFunded()).to.equal(eth(3));
    expect(await arena.totalDeposited()).to.equal(0n);
    expect(await arena.available()).to.equal(eth(3));
  });

  it("rejects zero funding, by call or by plain transfer", async () => {
    const { arena, arenaAddress, stranger } = await loadFixture(deployFixture);
    await expect(arena.fund({ value: 0 })).to.be.revertedWith("Arena: amount is zero");
    await expect(stranger.sendTransaction({ to: arenaAddress, value: 0 })).to.be.revertedWith("Arena: amount is zero");
  });

  it("accepts nothing while paused: fund and plain transfers both revert", async () => {
    const { arena, arenaAddress, stranger } = await loadFixture(deployFixture);
    await arena.setPaused(true);
    await expect(arena.fund({ value: eth(1) })).to.be.revertedWith("Arena: paused");
    await expect(stranger.sendTransaction({ to: arenaAddress, value: eth(1) })).to.be.revertedWith("Arena: paused");
    expect(await arena.available()).to.equal(0n);
    expect(await arena.totalFunded()).to.equal(0n);
  });

  it("rejects ETH sent with unknown calldata", async () => {
    const { arenaAddress, stranger } = await loadFixture(deployFixture);
    await expect(stranger.sendTransaction({ to: arenaAddress, value: eth(1), data: "0xdeadbeef" })).to.be.reverted;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: claims", () => {
  it("pays the voucher in ETH and records it", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) }); // somebody got eaten
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, alice.address, eth(3), deadline);

    const tx = arena.connect(alice).claim(eth(3), deadline, sig);
    await expect(tx).to.emit(arena, "Claimed").withArgs(alice.address, eth(3), eth(3));
    await expect(tx).to.changeEtherBalances([alice, arenaAddress], [eth(3), -eth(3)]);
    expect(await arena.claimed(alice.address)).to.equal(eth(3));
    expect(await arena.totalClaimed()).to.equal(eth(3));
    expect(await arena.available()).to.equal(eth(7));
  });

  it("replaying a voucher reverts with nothing to claim", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, alice.address, eth(3), deadline);
    await arena.connect(alice).claim(eth(3), deadline, sig);
    await expect(arena.connect(alice).claim(eth(3), deadline, sig)).to.be.revertedWith("Arena: nothing to claim");
    expect(await arena.totalClaimed()).to.equal(eth(3));
  });

  it("cumulative grows across two vouchers and only the delta is paid", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const deadline = await inAnHour();
    const sig1 = await voucher(arenaAddress, signer, alice.address, eth(3), deadline);
    await arena.connect(alice).claim(eth(3), deadline, sig1);

    const sig2 = await voucher(arenaAddress, signer, alice.address, eth("4.5"), deadline);
    const tx = arena.connect(alice).claim(eth("4.5"), deadline, sig2);
    await expect(tx).to.emit(arena, "Claimed").withArgs(alice.address, eth("1.5"), eth("4.5"));
    await expect(tx).to.changeEtherBalance(alice, eth("1.5"));
    expect(await arena.claimed(alice.address)).to.equal(eth("4.5"));
    expect(await arena.totalClaimed()).to.equal(eth("4.5"));
    expect(await arena.claimableFor(alice.address, eth("4.5"))).to.equal(0n);
    expect(await arena.claimableFor(alice.address, eth(5))).to.equal(eth("0.5"));
    expect(await arena.claimableFor(alice.address, eth(1))).to.equal(0n);
  });

  it("a lower voucher arriving late reverts", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const deadline = await inAnHour();
    const older = await voucher(arenaAddress, signer, alice.address, eth(2), deadline);
    const newer = await voucher(arenaAddress, signer, alice.address, eth(3), deadline);
    await arena.connect(alice).claim(eth(3), deadline, newer);
    await expect(arena.connect(alice).claim(eth(2), deadline, older)).to.be.revertedWith("Arena: nothing to claim");
  });

  it("a voucher issued to another account is worthless", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const deadline = await inAnHour();
    const alices = await voucher(arenaAddress, signer, alice.address, eth(1), deadline);
    await expect(arena.connect(bob).claim(eth(1), deadline, alices)).to.be.revertedWith("Arena: bad signature");
    expect(await arena.claimed(alice.address)).to.equal(0n);
    expect(await arena.claimed(bob.address)).to.equal(0n);
  });

  it("rejects an expired voucher and honours one exactly at its deadline", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const past = (await time.latest()) - 1;
    const expired = await voucher(arenaAddress, signer, alice.address, eth(1), past);
    await expect(arena.connect(alice).claim(eth(1), past, expired)).to.be.revertedWith("Arena: voucher expired");

    const deadline = (await time.latest()) + 100;
    const sig = await voucher(arenaAddress, signer, alice.address, eth(1), deadline);
    await time.setNextBlockTimestamp(deadline);
    await arena.connect(alice).claim(eth(1), deadline, sig);

    const sig2 = await voucher(arenaAddress, signer, alice.address, eth(2), deadline);
    await expect(arena.connect(alice).claim(eth(2), deadline, sig2)).to.be.revertedWith("Arena: voucher expired");
  });

  it("rejects a voucher from the wrong signer, or with tampered values", async () => {
    const { arena, arenaAddress, signer, stranger, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const deadline = await inAnHour();
    const forged = await voucher(arenaAddress, stranger, alice.address, eth(1), deadline);
    await expect(arena.connect(alice).claim(eth(1), deadline, forged)).to.be.revertedWith("Arena: bad signature");

    const real = await voucher(arenaAddress, signer, alice.address, eth(1), deadline);
    await expect(arena.connect(alice).claim(eth(9), deadline, real)).to.be.revertedWith("Arena: bad signature");
    await expect(arena.connect(alice).claim(eth(1), deadline + 1, real)).to.be.revertedWith("Arena: bad signature");
  });

  it("a voucher signed for another Arena is worthless here", async () => {
    const { arena, signer, deployer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const other = await (await ethers.getContractFactory("Arena")).deploy(signer.address, deployer.address);
    const deadline = await inAnHour();
    const sig = await voucher(await other.getAddress(), signer, alice.address, eth(1), deadline);
    await expect(arena.connect(alice).claim(eth(1), deadline, sig)).to.be.revertedWith("Arena: bad signature");
  });

  it("refuses to pay more than it holds", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    const deadline = await inAnHour();
    const tooMuch = await voucher(arenaAddress, signer, alice.address, eth(1) + 1n, deadline);
    await expect(arena.connect(alice).claim(eth(1) + 1n, deadline, tooMuch)).to.be.revertedWith("Arena: ocean is short");
    expect(await arena.claimed(alice.address)).to.equal(0n);

    // Once the pot is topped up the very same voucher pays.
    await arena.fund({ value: 1n });
    await arena.connect(alice).claim(eth(1) + 1n, deadline, tooMuch);
    expect(await arena.available()).to.equal(0n);
  });

  it("pays nothing while paused, then pays the same voucher once reopened", async () => {
    const { arena, arenaAddress, signer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, alice.address, eth("0.5"), deadline);
    await arena.setPaused(true);
    await expect(arena.connect(alice).claim(eth("0.5"), deadline, sig)).to.be.revertedWith("Arena: paused");
    await arena.setPaused(false);
    await arena.connect(alice).claim(eth("0.5"), deadline, sig);
    expect(await arena.available()).to.equal(eth("0.5"));
  });

  it("matches hashClaim to the off-chain typed data", async () => {
    const { arena, arenaAddress, signer, alice } = await loadFixture(deployFixture);
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, alice.address, eth(7), deadline);
    const digest = await arena.hashClaim(alice.address, eth(7), deadline);
    expect(ethers.recoverAddress(digest, sig)).to.equal(signer.address);
  });

  it("a claimer that cannot receive ETH reverts with transfer failed and nothing is recorded", async () => {
    const { arena, arenaAddress, signer, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    const rejecter = await (await ethers.getContractFactory("RejectingClaimer")).deploy();
    const rejecterAddress = await rejecter.getAddress();
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, rejecterAddress, eth("0.4"), deadline);
    await expect(rejecter.claim(arenaAddress, eth("0.4"), deadline, sig)).to.be.revertedWith("Arena: transfer failed");
    expect(await arena.claimed(rejecterAddress)).to.equal(0n);
    expect(await arena.totalClaimed()).to.equal(0n);
    expect(await arena.available()).to.equal(eth(1));
  });

  it("refuses a re-entrant claim: the second voucher is not paid inside the first", async () => {
    const { arena, arenaAddress, signer, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(10) });
    const attacker = await (await ethers.getContractFactory("ReentrantClaimer")).deploy();
    const attackerAddress = await attacker.getAddress();
    const deadline = await inAnHour();
    // Both vouchers are genuine. The attacker tries to cash the second one
    // while the ETH of the first is still arriving.
    const first = await voucher(arenaAddress, signer, attackerAddress, eth(1), deadline);
    const second = await voucher(arenaAddress, signer, attackerAddress, eth(10), deadline);

    await expect(attacker.attack(arenaAddress, eth(1), deadline, first, eth(10), deadline, second)).to.changeEtherBalances(
      [attackerAddress, arenaAddress],
      [eth(1), -eth(1)],
    );
    expect(await attacker.reentryAttempted()).to.equal(true);
    expect(await attacker.reentrySucceeded()).to.equal(false);
    expect(await attacker.reentryError()).to.equal(arena.interface.getError("ReentrancyGuardReentrantCall")!.selector);
    expect(await arena.claimed(attackerAddress)).to.equal(eth(1));
    expect(await arena.totalClaimed()).to.equal(eth(1));
    expect(await arena.available()).to.equal(eth(9));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: admin", () => {
  it("rotates the signer and kills the old key's vouchers", async () => {
    const { arena, arenaAddress, signer, stranger, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    const deadline = await inAnHour();
    const old = await voucher(arenaAddress, signer, alice.address, eth("0.1"), deadline);
    await expect(arena.setSigner(stranger.address)).to.emit(arena, "SignerChanged").withArgs(signer.address, stranger.address);
    expect(await arena.getFunction("signer")()).to.equal(stranger.address);
    await expect(arena.connect(alice).claim(eth("0.1"), deadline, old)).to.be.revertedWith("Arena: bad signature");
    const fresh = await voucher(arenaAddress, stranger, alice.address, eth("0.1"), deadline);
    await expect(arena.connect(alice).claim(eth("0.1"), deadline, fresh)).to.changeEtherBalance(alice, eth("0.1"));
    await expect(arena.setSigner(ethers.ZeroAddress)).to.be.revertedWith("Arena: signer is zero");
  });

  it("only the owner can administer", async () => {
    const { arena, alice } = await loadFixture(deployFixture);
    await expect(arena.connect(alice).setSigner(alice.address)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.connect(alice).setPaused(true)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    await expect(arena.connect(alice).setMinDeposit(1)).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
  });

  it("rescue is owner-only", async () => {
    const { arena, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    await expect(arena.connect(alice).rescue(alice.address, eth(1))).to.be.revertedWithCustomError(arena, "OwnableUnauthorizedAccount");
    expect(await arena.available()).to.equal(eth(1));
  });

  it("rescue moves ETH out, deposits included, even while paused — the documented trust point", async () => {
    const { arena, arenaAddress, stranger, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    await arena.setPaused(true);
    const tx = arena.rescue(stranger.address, eth("0.4"));
    await expect(tx).to.emit(arena, "Rescued").withArgs(stranger.address, eth("0.4"));
    await expect(tx).to.changeEtherBalances([stranger, arenaAddress], [eth("0.4"), -eth("0.4")]);
    expect(await arena.available()).to.equal(eth("0.6"));
    // Rescue is not a claim and not a deposit reversal: the totals do not move.
    expect(await arena.totalDeposited()).to.equal(eth(1));
    expect(await arena.totalClaimed()).to.equal(0n);
  });

  it("rescue refuses the zero address, more than the balance, and a receiver that rejects ETH", async () => {
    const { arena, deployer, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    await expect(arena.rescue(ethers.ZeroAddress, 1)).to.be.revertedWith("Arena: to is zero");
    await expect(arena.rescue(deployer.address, eth(1) + 1n)).to.be.revertedWith("Arena: ocean is short");
    const rejecter = await (await ethers.getContractFactory("RejectingClaimer")).deploy();
    await expect(arena.rescue(await rejecter.getAddress(), eth(1))).to.be.revertedWith("Arena: transfer failed");
    expect(await arena.available()).to.equal(eth(1));
  });

  it("a rescued ocean leaves signed vouchers unpayable until it is refilled", async () => {
    const { arena, arenaAddress, signer, deployer, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(bob).deposit({ value: eth(1) });
    const deadline = await inAnHour();
    const sig = await voucher(arenaAddress, signer, alice.address, eth(1), deadline);
    await arena.rescue(deployer.address, eth(1));
    await expect(arena.connect(alice).claim(eth(1), deadline, sig)).to.be.revertedWith("Arena: ocean is short");
  });

  it("sets the owner and signer at deployment and refuses a zero signer", async () => {
    const { arena, deployer, signer, stranger } = await loadFixture(deployFixture);
    expect(await arena.owner()).to.equal(deployer.address);
    expect(await arena.getFunction("signer")()).to.equal(signer.address);
    expect(await arena.paused()).to.equal(false);
    expect(await arena.minDeposit()).to.equal(0n);

    const factory = await ethers.getContractFactory("Arena");
    await expect(factory.deploy(ethers.ZeroAddress, deployer.address)).to.be.revertedWith("Arena: signer is zero");
    const owned = await factory.deploy(signer.address, stranger.address);
    expect(await owned.owner()).to.equal(stranger.address);
    await expect(owned.setPaused(true)).to.be.revertedWithCustomError(owned, "OwnableUnauthorizedAccount");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Arena: accounting", () => {
  it("balance equals deposits plus funding minus claims across a mixed session", async () => {
    const { arena, arenaAddress, signer, stranger, alice, bob } = await loadFixture(deployFixture);
    await arena.connect(alice).deposit({ value: eth(2) });
    await arena.connect(bob).deposit({ value: eth(3) });
    await arena.fund({ value: eth(1) });
    await stranger.sendTransaction({ to: arenaAddress, value: eth("0.5") });

    const deadline = await inAnHour();
    // Bob ate Alice and some food: he leaves with more than he brought.
    const bobs = await voucher(arenaAddress, signer, bob.address, eth("5.25"), deadline);
    await arena.connect(bob).claim(eth("5.25"), deadline, bobs);
    const alices = await voucher(arenaAddress, signer, alice.address, eth("0.25"), deadline);
    await arena.connect(alice).claim(eth("0.25"), deadline, alices);

    expect(await arena.totalDeposited()).to.equal(eth(5));
    expect(await arena.totalFunded()).to.equal(eth("1.5"));
    expect(await arena.totalClaimed()).to.equal(eth("5.5"));
    expect(await arena.depositCount()).to.equal(2n);
    const expected = eth(5) + eth("1.5") - eth("5.5");
    expect(await arena.available()).to.equal(expected);
    expect(await ethers.provider.getBalance(arenaAddress)).to.equal(expected);
  });
});
