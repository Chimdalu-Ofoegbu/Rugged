// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  Resolution
/// @notice Settles a market at expiry: reads the lowest price across the
///         24-hour window from Pyth, decides YES/NO, takes the 2% fee
///         (1.2% treasury / 0.8% bond pool), pays winners, and records the
///         outcome into ReputationBond in the same transaction.
/// @dev    STUB — implemented in Phase 1 (project.md §1c).
contract Resolution {
    // Phase 1
}
