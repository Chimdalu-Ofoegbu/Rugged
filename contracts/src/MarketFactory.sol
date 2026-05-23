// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Market} from "./Market.sol";

/// @title  MarketFactory
/// @notice Opens a 24-hour binary "drops >50%" market the moment the swarm
///         reaches consensus on a new iterativv blacklist commit.
/// @dev    project.md Phase 1 (1a).
///
///         Design note: project.md's createMarket signature omits the
///         blacklist-time price, but §1c requires that price to be "stored at
///         market creation" as the resolution baseline — so `blacklistPrice`
///         is added as a parameter here (the watcher's metadata_fetcher
///         supplies it).
contract MarketFactory is Ownable {
    address public immutable usdc;
    address public immutable resolution;
    address public immutable treasury;
    address public immutable reputationBond;

    /// @notice Total markets created — also the id of the next market.
    uint256 public marketCount;

    /// @notice marketId => Market contract address.
    mapping(uint256 => address) public markets;

    /// @notice Reverse lookup — was this address created by this factory?
    /// @dev    Used by RuggedPaymaster's on-chain scope check to verify that
    ///         a UserOperation's target is a real Rugged Market (not a
    ///         malicious lookalike) before sponsoring gas.
    mapping(address => bool) public isMarket;

    event MarketOpened(
        uint256 indexed marketId,
        address indexed market,
        address coinAddress,
        uint256 seedProbabilityBps,
        uint256 expiry
    );

    error ZeroAddress();
    error ZeroPrice();
    error InvalidProbability();

    constructor(address _usdc, address _resolution, address _treasury, address _reputationBond)
        Ownable(msg.sender)
    {
        if (
            _usdc == address(0) || _resolution == address(0) || _treasury == address(0)
                || _reputationBond == address(0)
        ) revert ZeroAddress();
        usdc = _usdc;
        resolution = _resolution;
        treasury = _treasury;
        reputationBond = _reputationBond;
    }

    /// @notice Deploy a new prediction market. Called by the backend operator
    ///         (owner) once the swarm fires consensus.
    /// @param  coinAddress         the blacklisted coin
    /// @param  blacklistTimestamp  unix time of the blacklist commit
    /// @param  blacklistPrice      coin price at blacklist time (resolution baseline)
    /// @param  seedProbabilityBps  swarm consensus probability, in basis points
    /// @param  duration            market lifetime in seconds; 0 → 24h default
    /// @return marketId            id of the created market
    function createMarket(
        address coinAddress,
        uint256 blacklistTimestamp,
        uint256 blacklistPrice,
        uint256 seedProbabilityBps,
        uint256 duration
    ) external onlyOwner returns (uint256 marketId) {
        if (coinAddress == address(0)) revert ZeroAddress();
        if (blacklistPrice == 0) revert ZeroPrice();
        if (seedProbabilityBps > 10_000) revert InvalidProbability();

        marketId = marketCount;
        Market market = new Market(
            usdc,
            marketId,
            coinAddress,
            blacklistTimestamp,
            blacklistPrice,
            seedProbabilityBps,
            duration,
            resolution,
            treasury,
            reputationBond
        );

        markets[marketId] = address(market);
        isMarket[address(market)] = true;
        marketCount = marketId + 1;

        emit MarketOpened(marketId, address(market), coinAddress, seedProbabilityBps, market.expiry());
    }

    /// @notice Address of a market by id (address(0) if it does not exist).
    function getMarket(uint256 marketId) external view returns (address) {
        return markets[marketId];
    }
}
