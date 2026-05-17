// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  ReputationBond
/// @notice Prices iterativv's reputation on-chain. Users stake USDC behind
///         the maintainer; the contract tracks the hit rate of the last 30
///         resolved markets and slashes stakes proportionally below 70%.
/// @dev    STUB — implemented in Phase 1 (project.md §1d):
///         stake / unstake (4h cooldown); recordOutcome (Resolution only);
///         _slash; claimFees; getHitRate.
contract ReputationBond {
    // Phase 1
}
