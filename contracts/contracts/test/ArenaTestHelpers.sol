// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IArenaClaim {
    function claim(uint256 cumulative, uint256 deadline, bytes calldata signature) external returns (uint256);
}

/// @title RejectingClaimer
/// @notice Test-only. A contract that claims from the Arena but cannot
///         receive ETH, to prove the claim reverts with "transfer failed"
///         and records nothing. Never deploy this.
contract RejectingClaimer {
    function claim(address arena, uint256 cumulative, uint256 deadline, bytes calldata signature) external {
        IArenaClaim(arena).claim(cumulative, deadline, signature);
    }
}

/// @title ReentrantClaimer
/// @notice Test-only. Claims from the Arena and, while the ETH is arriving,
///         tries to claim again with a second, higher voucher. It swallows
///         the inner failure and records it, so a test can check both that
///         the re-entry was refused and that only the first voucher was
///         paid. Never deploy this.
contract ReentrantClaimer {
    address public arena;
    uint256 public secondCumulative;
    uint256 public secondDeadline;
    bytes public secondSignature;

    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryError;

    function attack(
        address arena_,
        uint256 cumulative,
        uint256 deadline,
        bytes calldata signature,
        uint256 secondCumulative_,
        uint256 secondDeadline_,
        bytes calldata secondSignature_
    ) external {
        arena = arena_;
        secondCumulative = secondCumulative_;
        secondDeadline = secondDeadline_;
        secondSignature = secondSignature_;
        IArenaClaim(arena_).claim(cumulative, deadline, signature);
    }

    receive() external payable {
        if (reentryAttempted) return;
        reentryAttempted = true;
        try IArenaClaim(arena).claim(secondCumulative, secondDeadline, secondSignature) {
            reentrySucceeded = true;
        } catch (bytes memory reason) {
            reentryError = reason;
        }
    }
}
