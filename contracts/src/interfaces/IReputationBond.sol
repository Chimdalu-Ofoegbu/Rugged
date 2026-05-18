// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  IReputationBond
/// @notice Minimal interface the Resolution and Market contracts use to talk
///         to the ReputationBond contract.
interface IReputationBond {
    /// @notice Records a resolved market's outcome into the rolling 30-market
    ///         window. `yesWon == true` means the coin rugged (a "hit" for the
    ///         maintainer). Only callable by the Resolution contract.
    function recordOutcome(uint256 marketId, bool yesWon) external;

    /// @notice Pulls `amount` USDC of protocol-fee income into the staker fee
    ///         pool (the 0.8% bondholder cut). Caller must have approved `amount`.
    function depositFees(uint256 amount) external;
}
