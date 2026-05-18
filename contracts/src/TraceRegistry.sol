// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title  TraceRegistry
/// @notice Permanent on-chain audit trail for Rugged. For every market the
///         swarm opens, the backend records the SHA-256 hash and IPFS CID of
///         the full multi-agent reasoning trace here.
/// @dev    project.md Phase 1 (1e). Operator-gated writes; one trace per market.
contract TraceRegistry is Ownable {
    struct Trace {
        bytes32 traceHash; // SHA-256 of the full swarm reasoning JSON
        string ipfsCid; // CID of the JSON pinned to IPFS / Irys
        uint256 registeredAt; // block timestamp; 0 means "not yet registered"
    }

    /// @notice The backend address permitted to register traces.
    address public operator;

    /// @notice marketId => reasoning trace.
    mapping(uint256 => Trace) public traces;

    event TraceRegistered(uint256 indexed marketId, bytes32 traceHash, string ipfsCid);
    event OperatorUpdated(address indexed operator);

    error NotOperator();
    error AlreadyRegistered();
    error ZeroAddress();

    constructor(address _operator) Ownable(msg.sender) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @notice Update the operator address (owner only).
    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorUpdated(_operator);
    }

    /// @notice Register the reasoning trace for a market. One-shot per market.
    function registerTrace(uint256 marketId, bytes32 traceHash, string calldata ipfsCid)
        external
        onlyOperator
    {
        if (traces[marketId].registeredAt != 0) revert AlreadyRegistered();
        traces[marketId] = Trace({traceHash: traceHash, ipfsCid: ipfsCid, registeredAt: block.timestamp});
        emit TraceRegistered(marketId, traceHash, ipfsCid);
    }

    /// @notice Read a market's trace.
    function getTrace(uint256 marketId)
        external
        view
        returns (bytes32 traceHash, string memory ipfsCid, uint256 registeredAt)
    {
        Trace storage t = traces[marketId];
        return (t.traceHash, t.ipfsCid, t.registeredAt);
    }
}
