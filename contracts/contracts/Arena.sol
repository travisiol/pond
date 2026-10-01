// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Arena
/// @notice The only thing FRENZY keeps on chain: ETH goes in through
///         `deposit`, comes back out through server-signed `claim`s, and
///         anyone can `fund` the pot that feeds the ocean.
/// @dev What happens between a deposit and a claim — who ate whom, how much
///      a fish weighed when it was swallowed, who made it out alive — is
///      decided by the game server, which is the referee. The chain does not
///      know the game; it knows balances. The server signs an EIP-712
///      `Claim(account, cumulative, deadline)` voucher where `cumulative` is
///      the running total of ETH this account has ever been entitled to take
///      out. `claim` pays `cumulative - claimed[account]`, so:
///
///        * a voucher is idempotent: re-submitting it reverts with
///          "Arena: nothing to claim" — that is the whole replay defence,
///          there is no nonce;
///        * a lost voucher costs nothing, the next one supersedes it;
///        * an older (lower) voucher arriving late simply reverts.
///
///      ETH is the chain's native currency, so a deposit is worth exactly
///      `msg.value`: no approval, no transfer tax. The server watches
///      `Deposited` events and credits the player with exactly `amount`.
///
///      ETH sent to this contract with no calldata is pot funding, the same
///      as calling `fund`. That is how a token's fee wallet feeds the game:
///      it just sends ETH here. Nothing funded is owed back to anyone.
///
///      There is no per-player ledger on chain. Deposits and funding sit in
///      one balance, and the only thing that decides who may take what out
///      of it is a signed voucher.
///
///      Trust, stated plainly: the signer can authorise any payout to any
///      account, up to the whole balance. The owner can rotate the signer
///      and can move ETH out with `rescue`. Whoever holds either key can
///      therefore reach every wei in here, players' deposits included. That
///      is the price of a referee that runs many ticks a second.
///
///      Reverts are strings on purpose: the client and the server show them
///      verbatim.
contract Arena is Ownable, EIP712, ReentrancyGuard {
    // ───────────────────────────── constants ─────────────────────────────

    /// @notice EIP-712 type hash for `Claim(address account,uint256 cumulative,uint256 deadline)`.
    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(address account,uint256 cumulative,uint256 deadline)");

    // ──────────────────────────────── state ──────────────────────────────

    /// @notice The game server's voucher signer. Anything it signs is payable.
    address public signer;
    /// @notice While true, `deposit`, `fund`, plain ETH transfers and `claim` are closed.
    bool public paused;
    /// @notice Smallest deposit accepted, in wei. The server enforces the play floor on top.
    uint256 public minDeposit;

    /// @notice Cumulative ETH already paid to `account`, in wei.
    mapping(address account => uint256 cumulative) public claimed;

    /// @notice Every wei that ever came in through `deposit`.
    uint256 public totalDeposited;
    /// @notice Every wei that ever came in through `fund` or a plain transfer.
    uint256 public totalFunded;
    /// @notice Every wei ever paid out through `claim`.
    uint256 public totalClaimed;
    /// @notice Number of deposits so far; also the id of the latest one.
    uint256 public depositCount;

    // ─────────────────────────────── events ──────────────────────────────

    event Deposited(address indexed player, uint256 amount, uint256 indexed id);
    event Funded(address indexed from, uint256 amount);
    event Claimed(address indexed account, uint256 paid, uint256 cumulative);
    event SignerChanged(address indexed previousSigner, address indexed newSigner);
    event PausedSet(bool paused);
    event MinDepositSet(uint256 minDeposit);
    event Rescued(address indexed to, uint256 amount);

    // ───────────────────────────── constructor ───────────────────────────

    /// @param signer_ The game server's voucher signer.
    /// @param initialOwner Owns the contract: rotates the signer, pauses, rescues.
    constructor(address signer_, address initialOwner) Ownable(initialOwner) EIP712("FrenzyArena", "1") {
        require(signer_ != address(0), "Arena: signer is zero");
        signer = signer_;
        emit SignerChanged(address(0), signer_);
    }

    // ─────────────────────────────── in ──────────────────────────────────

    /// @notice Puts the ETH you send into the ocean. The server credits you
    ///         with exactly `msg.value` and lets you spawn a fish with it.
    /// @dev The deposit id in the event is `depositCount` after this call,
    ///      so ids start at 1 and never repeat.
    function deposit() external payable {
        require(!paused, "Arena: paused");
        require(msg.value > 0, "Arena: amount is zero");
        require(msg.value >= minDeposit, "Arena: below minimum");
        totalDeposited += msg.value;
        depositCount += 1;
        emit Deposited(msg.sender, msg.value, depositCount);
    }

    /// @notice Adds the ETH you send to the pot the server scatters into the
    ///         ocean as food. Anyone can fund it; nothing funded is ever
    ///         owed back to the funder.
    function fund() external payable {
        _fund();
    }

    /// @notice Plain ETH sent here is pot funding, exactly like `fund`.
    /// @dev Reverts while paused, like `fund`: nothing is silently accepted
    ///      while the game is closed. A sender that cannot handle a revert
    ///      (a fee wallet on a schedule, say) will see its transfer fail and
    ///      keep its ETH until the game reopens. ETH can still be forced in
    ///      without running this code (a self-destructing contract, a block
    ///      reward); that ETH shows up in `available` but in no total.
    receive() external payable {
        _fund();
    }

    // ─────────────────────────────── out ─────────────────────────────────

    /// @notice Pays out everything owed to msg.sender up to `cumulative`.
    /// @dev The signature must come from `signer` over
    ///      `hashClaim(msg.sender, cumulative, deadline)`. The digest binds
    ///      `account`, so a voucher issued to one player is worthless in
    ///      anyone else's hands: it recovers a different address and fails
    ///      as "bad signature". State is updated before the ETH leaves, and
    ///      the call is guarded against re-entry. A caller that is a
    ///      contract must be able to receive ETH, or the claim reverts with
    ///      "Arena: transfer failed" and nothing is recorded.
    /// @param cumulative Total ETH this account has ever been entitled to, in wei.
    /// @param deadline Unix timestamp after which the voucher is dead.
    /// @param signature 65-byte ECDSA signature from `signer`.
    /// @return paid The amount transferred by this call, in wei.
    function claim(uint256 cumulative, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 paid)
    {
        require(!paused, "Arena: paused");
        require(block.timestamp <= deadline, "Arena: voucher expired");

        bytes32 digest = hashClaim(msg.sender, cumulative, deadline);
        require(ECDSA.recover(digest, signature) == signer, "Arena: bad signature");

        uint256 already = claimed[msg.sender];
        require(cumulative > already, "Arena: nothing to claim");

        paid = cumulative - already;
        require(address(this).balance >= paid, "Arena: ocean is short");

        claimed[msg.sender] = cumulative;
        totalClaimed += paid;
        emit Claimed(msg.sender, paid, cumulative);

        (bool ok,) = payable(msg.sender).call{value: paid}("");
        require(ok, "Arena: transfer failed");
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice The full EIP-712 digest a voucher for these values must be signed over.
    /// @dev Domain: name "FrenzyArena", version "1", this chain, this contract.
    function hashClaim(address account, uint256 cumulative, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, account, cumulative, deadline)));
    }

    /// @notice What `account` would receive from a voucher for `cumulative`.
    function claimableFor(address account, uint256 cumulative) external view returns (uint256) {
        uint256 already = claimed[account];
        return cumulative > already ? cumulative - already : 0;
    }

    /// @notice ETH currently held: every deposit and fund not yet claimed or rescued.
    function available() external view returns (uint256) {
        return address(this).balance;
    }

    // ─────────────────────────────── admin ───────────────────────────────

    /// @notice Rotates the voucher signer. Vouchers signed by the old key stop working immediately.
    function setSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "Arena: signer is zero");
        emit SignerChanged(signer, newSigner);
        signer = newSigner;
    }

    /// @notice Opens or closes the game's money doors. Use it if the signer key ever leaks.
    /// @dev Pausing closes `deposit`, `fund`, plain transfers and `claim`.
    ///      It does not close `rescue`.
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    /// @notice Sets the smallest deposit accepted, in wei.
    function setMinDeposit(uint256 value) external onlyOwner {
        minDeposit = value;
        emit MinDepositSet(value);
    }

    /// @notice Moves `amount` wei out of the contract to `to`.
    /// @dev Trust point, stated plainly: the owner can withdraw the entire
    ///      balance at any time, paused or not, including ETH players expect
    ///      to claim. It exists to recover a misconfigured deployment and to
    ///      retire the contract; players should treat the owner key as fully
    ///      trusted. It does not touch `claimed` or any total, so vouchers
    ///      already signed stay valid and will revert with "Arena: ocean is
    ///      short" if the ETH behind them has been rescued.
    function rescue(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Arena: to is zero");
        require(address(this).balance >= amount, "Arena: ocean is short");
        emit Rescued(to, amount);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "Arena: transfer failed");
    }

    // ─────────────────────────────── internal ────────────────────────────

    function _fund() private {
        require(!paused, "Arena: paused");
        require(msg.value > 0, "Arena: amount is zero");
        totalFunded += msg.value;
        emit Funded(msg.sender, msg.value);
    }
}
