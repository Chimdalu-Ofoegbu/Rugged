// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  IMarket
/// @notice Minimal interface the Resolution contract uses to read and settle
///         an individual Market.
interface IMarket {
    /// @notice Settles the market. `yesWon == true` pays the YES side.
    ///         Only callable by the Resolution contract, only after expiry.
    function settle(bool yesWon) external;

    function marketId() external view returns (uint256);

    function coinAddress() external view returns (address);

    /// @notice Coin price recorded at the blacklist commit — the resolution baseline.
    function blacklistPrice() external view returns (uint256);

    /// @notice Unix timestamp the 24-hour market closes for betting / can resolve.
    function expiry() external view returns (uint256);

    function resolved() external view returns (bool);
}
