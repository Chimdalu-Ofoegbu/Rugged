// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Minimal interface to MarketFactory — only the reverse-lookup we need.
interface IMarketFactoryView {
    function isMarket(address) external view returns (bool);
}

/// @title  RuggedPaymaster
/// @notice ERC-4337 v0.7 paymaster for Rugged on Arc. Combines two checks
///         per UserOperation, both enforced on-chain:
///
///         1. **Signature** — UserOp must be signed by the off-chain
///            `verifyingSigner`. The backend at POST /api/paymaster/sponsor
///            holds the private key and is the first line of defense (fast
///            4xx for bad scope). On-chain we verify the signature covers
///            the entire UserOp + chainId + paymaster address + validity
///            window, so the signed sponsorship can't be replayed across
///            chains or reused on a tampered UserOp.
///
///         2. **On-chain scope** — paymaster decodes the UserOp's call
///            target + function selector and revert-fails if the call
///            falls outside Rugged's policy. This is defense-in-depth:
///            even if the signer key is exfiltrated, sponsorship is
///            mathematically restricted to:
///
///              - USDC.approve(spender, amount)    — to allow Market pulls
///              - USDC.transfer(to, amount)        — for withdrawals
///              - Market.placeBet(isYes, amount)   — only on factory-created Markets
///              - Market.claim()                   — only on factory-created Markets
///
///            Any other (target, selector) pair reverts at validation time
///            with a specific reason so debugging is straightforward.
///
/// @dev    Assumes the smart-account wallet uses the canonical SimpleAccount
///         `execute(address dest, uint256 value, bytes data)` call pattern
///         (selector 0xb61d27f6) — the default in permissionless.js, the SDK
///         the Rugged frontend uses. Batched calls via executeBatch are not
///         supported in this version; users send approve + placeBet as two
///         separate sponsored UserOps. Adding executeBatch support is an
///         additive change in `_validateScope`.
///
///         We inherit BasePaymaster directly (not eth-infinitism's
///         VerifyingPaymaster) because the latter's _validatePaymasterUserOp
///         isn't marked `virtual` and can't be extended. The signature
///         verification below mirrors VerifyingPaymaster exactly so the
///         off-chain signing flow stays interchangeable.
contract RuggedPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;
    using MessageHashUtils for bytes32;

    /// @notice Tag visible on block explorers for debugging.
    string public constant VERSION = "1.2.0-arc-scoped-cancel";

    /// @notice Off-chain signer that authorizes sponsorship.
    address public immutable verifyingSigner;

    /// @notice USDC contract on Arc — locked at deploy.
    address public immutable usdc;

    /// @notice MarketFactory — paymaster calls `isMarket(target)` to verify
    /// any non-USDC target is a real Rugged Market.
    IMarketFactoryView public immutable marketFactory;

    // -----------------------------------------------------------------
    //  paymasterAndData layout (mirrors VerifyingPaymaster):
    //    [0:20]    paymaster address
    //    [20:36]   validationGasLimit (uint128) || postOpGasLimit (uint128)
    //    [36:100]  abi.encode(validUntil (uint48), validAfter (uint48))   = 64 bytes
    //    [100:]    signature (65 bytes typical, 64 also accepted)
    // -----------------------------------------------------------------
    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;       // = 52
    uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;       // = 116

    // -----------------------------------------------------------------
    //  Function selectors — precomputed so validation is cheap.
    // -----------------------------------------------------------------
    /// @dev SimpleAccount.execute(address,uint256,bytes)
    bytes4 internal constant EXECUTE_SELECTOR = 0xb61d27f6;
    /// @dev ERC-20 transfer(address,uint256)
    bytes4 internal constant USDC_TRANSFER_SELECTOR = 0xa9059cbb;
    /// @dev ERC-20 approve(address,uint256)
    bytes4 internal constant USDC_APPROVE_SELECTOR = 0x095ea7b3;
    /// @dev Market.placeBet(bool,uint256)
    bytes4 internal constant MARKET_PLACE_BET_SELECTOR = 0xf7f74b22;
    /// @dev Market.claim()
    bytes4 internal constant MARKET_CLAIM_SELECTOR = 0x4e71d92d;
    /// @dev Market.cancelBet(bool)
    bytes4 internal constant MARKET_CANCEL_BET_SELECTOR = 0x5ed6302d;

    // -----------------------------------------------------------------
    //  Errors — explicit revert reasons.
    // -----------------------------------------------------------------
    error ScopeCallDataTooShort();
    error ScopeOnlyExecuteAllowed(bytes4 outerSelector);
    error ScopeInnerCallTooShort();
    error ScopeTargetNotAllowed(address target);
    error ScopeSelectorNotAllowed(address target, bytes4 selector);

    constructor(
        IEntryPoint _entryPoint,
        address _verifyingSigner,
        address _usdc,
        IMarketFactoryView _marketFactory
    ) BasePaymaster(_entryPoint) {
        require(_verifyingSigner != address(0), "RuggedPaymaster: signer zero");
        require(_usdc != address(0), "RuggedPaymaster: usdc zero");
        require(address(_marketFactory) != address(0), "RuggedPaymaster: factory zero");
        verifyingSigner = _verifyingSigner;
        usdc = _usdc;
        marketFactory = _marketFactory;
    }

    // -----------------------------------------------------------------
    //  Signature verification — the hash we sign off-chain & verify here
    //  This is identical to eth-infinitism's VerifyingPaymaster.getHash
    //  so the off-chain signing code can match either contract.
    // -----------------------------------------------------------------
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public view returns (bytes32)
    {
        address sender = userOp.getSender();
        return keccak256(abi.encode(
            sender,
            userOp.nonce,
            keccak256(userOp.initCode),
            keccak256(userOp.callData),
            userOp.accountGasLimits,
            uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET : PAYMASTER_DATA_OFFSET])),
            userOp.preVerificationGas,
            userOp.gasFees,
            block.chainid,
            address(this),
            validUntil,
            validAfter
        ));
    }

    /// @notice Unpack the validUntil / validAfter / signature triple from
    /// the trailing portion of paymasterAndData.
    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public pure returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        (validUntil, validAfter) = abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:], (uint48, uint48));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    // -----------------------------------------------------------------
    //  Validation override — signature first, then on-chain scope.
    // -----------------------------------------------------------------
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 /* requiredPreFund */
    ) internal view override returns (bytes memory context, uint256 validationData) {
        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);
        require(
            signature.length == 64 || signature.length == 65,
            "RuggedPaymaster: invalid signature length"
        );
        bytes32 ethSignedHash = getHash(userOp, validUntil, validAfter).toEthSignedMessageHash();

        // Wrong signer → SIG_VALIDATION_FAILED; let EntryPoint surface it.
        // We do NOT run scope checks in this branch — if the sig is bad,
        // the call wouldn't be sponsored anyway.
        if (verifyingSigner != ECDSA.recover(ethSignedHash, signature)) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        // Signature OK → enforce on-chain scope. Revert on violation so
        // the user sees a specific reason rather than a generic SIG fail.
        _validateScope(userOp.callData);

        return ("", _packValidationData(false, validUntil, validAfter));
    }

    /// @dev Decode UserOp.callData expecting `execute(address,uint256,bytes)`,
    /// extract the inner target + selector, and enforce Rugged's allowlist.
    function _validateScope(bytes calldata callData) internal view {
        if (callData.length < 4) revert ScopeCallDataTooShort();

        bytes4 outerSelector = bytes4(callData[:4]);
        if (outerSelector != EXECUTE_SELECTOR) {
            revert ScopeOnlyExecuteAllowed(outerSelector);
        }

        // execute(address dest, uint256 value, bytes data)
        (address target, , bytes memory innerData) = abi.decode(callData[4:], (address, uint256, bytes));

        if (innerData.length < 4) revert ScopeInnerCallTooShort();
        bytes4 innerSelector;
        // The first 32 bytes of a `bytes memory` is its length; data starts at +32.
        assembly {
            innerSelector := mload(add(innerData, 0x20))
        }

        if (target == usdc) {
            if (innerSelector != USDC_APPROVE_SELECTOR && innerSelector != USDC_TRANSFER_SELECTOR) {
                revert ScopeSelectorNotAllowed(target, innerSelector);
            }
        } else if (marketFactory.isMarket(target)) {
            if (
                innerSelector != MARKET_PLACE_BET_SELECTOR
                && innerSelector != MARKET_CLAIM_SELECTOR
                && innerSelector != MARKET_CANCEL_BET_SELECTOR
            ) {
                revert ScopeSelectorNotAllowed(target, innerSelector);
            }
        } else {
            revert ScopeTargetNotAllowed(target);
        }
    }
}
