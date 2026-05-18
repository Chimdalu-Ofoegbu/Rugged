// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IMarket} from "./interfaces/IMarket.sol";
import {IReputationBond} from "./interfaces/IReputationBond.sol";

/// @title  Resolution
/// @notice Settles expired markets and records outcomes into the ReputationBond.
/// @dev    project.md Phase 1 (1c).
///
///         Design note: project.md says Resolution "reads the lowest price
///         recorded across the 24h window from Pyth." On-chain Pyth exposes
///         only a current price — a windowed low must be *tracked off-chain*.
///         So the trusted `resolver` role (the backend, which polls Pyth)
///         supplies the observed 24h-low; the contract enforces the >50%-drop
///         math, drives Market.settle (which performs the 2% fee split), and
///         records the outcome into the bond. This also satisfies project.md's
///         documented "manual / judge resolution" demo fallback.
contract Resolution is Ownable {
    address public immutable reputationBond;

    /// @notice Trusted address allowed to submit resolution prices.
    address public resolver;

    struct Outcome {
        uint256 observedLowPrice;
        uint256 blacklistPrice;
        bool yesWon; // true => coin dropped >50% (rug confirmed)
        uint256 resolvedAt;
    }

    /// @notice marketId => resolution record.
    mapping(uint256 => Outcome) public outcomes;

    event MarketResolved(
        uint256 indexed marketId,
        address indexed market,
        uint256 observedLowPrice,
        uint256 blacklistPrice,
        bool yesWon
    );
    event ResolverUpdated(address indexed resolver);

    error ZeroAddress();
    error NotResolver();
    error AlreadyResolved();
    error NotYetExpired();

    constructor(address _reputationBond) Ownable(msg.sender) {
        if (_reputationBond == address(0)) revert ZeroAddress();
        reputationBond = _reputationBond;
        resolver = msg.sender;
        emit ResolverUpdated(msg.sender);
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    /// @notice Update the resolver role (owner only).
    function setResolver(address _resolver) external onlyOwner {
        if (_resolver == address(0)) revert ZeroAddress();
        resolver = _resolver;
        emit ResolverUpdated(_resolver);
    }

    /// @notice Resolve an expired market. `observedLowPrice` is the lowest
    ///         price seen across the 24h window (tracked off-chain via Pyth).
    ///         YES wins when the coin dropped strictly more than 50%.
    function resolve(address market, uint256 observedLowPrice) external onlyResolver {
        IMarket m = IMarket(market);
        if (m.resolved()) revert AlreadyResolved();
        if (block.timestamp < m.expiry()) revert NotYetExpired();

        uint256 blacklistPrice = m.blacklistPrice();
        // drop > 50%  <=>  lowPrice < blacklistPrice / 2  <=>  2*low < blacklist
        bool yesWon = observedLowPrice * 2 < blacklistPrice;

        uint256 id = m.marketId();
        outcomes[id] = Outcome({
            observedLowPrice: observedLowPrice,
            blacklistPrice: blacklistPrice,
            yesWon: yesWon,
            resolvedAt: block.timestamp
        });

        m.settle(yesWon);
        IReputationBond(reputationBond).recordOutcome(id, yesWon);

        emit MarketResolved(id, market, observedLowPrice, blacklistPrice, yesWon);
    }
}
