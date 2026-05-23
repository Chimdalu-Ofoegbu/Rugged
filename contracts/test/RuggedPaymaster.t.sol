// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RuggedPaymaster, IMarketFactoryView} from "../src/RuggedPaymaster.sol";

/// @dev Tiny stub that pretends to be MarketFactory for unit tests. The
/// real factory is heavier (deploys child contracts in createMarket) and
/// not necessary here — we only need the `isMarket(address) → bool` view.
contract FakeMarketFactory is IMarketFactoryView {
    mapping(address => bool) public override isMarket;

    function _set(address m, bool v) external {
        isMarket[m] = v;
    }
}

contract RuggedPaymasterTest is Test {
    EntryPoint ep;
    RuggedPaymaster paymaster;
    FakeMarketFactory factory;

    uint256 signerKey = 0xA11CE;
    address signer;

    address user = makeAddr("user");
    address attacker = makeAddr("attacker");
    address usdc = makeAddr("usdc");
    address validMarket = makeAddr("validMarket");
    address fakeMarket = makeAddr("fakeMarket");

    // Selectors mirrored from the contract for test assertions
    bytes4 constant EXECUTE_SEL = 0xb61d27f6;
    bytes4 constant USDC_APPROVE_SEL = 0x095ea7b3;
    bytes4 constant USDC_TRANSFER_SEL = 0xa9059cbb;
    bytes4 constant PLACE_BET_SEL = 0xf7f74b22;
    bytes4 constant CLAIM_SEL = 0x4e71d92d;

    function setUp() public {
        ep = new EntryPoint();
        signer = vm.addr(signerKey);
        factory = new FakeMarketFactory();
        factory._set(validMarket, true);
        paymaster = new RuggedPaymaster(IEntryPoint(address(ep)), signer, usdc, IMarketFactoryView(address(factory)));
        vm.deal(address(this), 10 ether);
        paymaster.deposit{value: 1 ether}();
    }

    // -----------------------------------------------------------------
    //  Construction
    // -----------------------------------------------------------------
    function test_construct_storesAllImmutables() public view {
        assertEq(address(paymaster.entryPoint()), address(ep));
        assertEq(paymaster.verifyingSigner(), signer);
        assertEq(paymaster.usdc(), usdc);
        assertEq(address(paymaster.marketFactory()), address(factory));
    }

    function test_construct_revertsOnZeroUsdc() public {
        vm.expectRevert(bytes("RuggedPaymaster: usdc zero"));
        new RuggedPaymaster(IEntryPoint(address(ep)), signer, address(0), IMarketFactoryView(address(factory)));
    }

    function test_construct_revertsOnZeroFactory() public {
        vm.expectRevert(bytes("RuggedPaymaster: factory zero"));
        new RuggedPaymaster(IEntryPoint(address(ep)), signer, usdc, IMarketFactoryView(address(0)));
    }

    function test_version_tag() public view {
        assertEq(paymaster.VERSION(), "1.2.0-arc-scoped-cancel");
    }

    // -----------------------------------------------------------------
    //  Scope enforcement — allowed call paths
    // -----------------------------------------------------------------
    function test_scope_allowsUSDCApprove() public {
        bytes memory inner = abi.encodeWithSelector(USDC_APPROVE_SEL, validMarket, uint256(1_000_000));
        _expectScopeValid(_execCallData(usdc, 0, inner));
    }

    function test_scope_allowsUSDCTransfer() public {
        bytes memory inner = abi.encodeWithSelector(USDC_TRANSFER_SEL, attacker, uint256(1_000_000));
        _expectScopeValid(_execCallData(usdc, 0, inner));
    }

    function test_scope_allowsMarketPlaceBet() public {
        bytes memory inner = abi.encodeWithSelector(PLACE_BET_SEL, true, uint256(1_000_000));
        _expectScopeValid(_execCallData(validMarket, 0, inner));
    }

    function test_scope_allowsMarketClaim() public {
        bytes memory inner = abi.encodeWithSelector(CLAIM_SEL);
        _expectScopeValid(_execCallData(validMarket, 0, inner));
    }

    // -----------------------------------------------------------------
    //  Scope enforcement — refused call paths
    // -----------------------------------------------------------------
    function test_scope_revertsOnUnknownTarget() public {
        // A target that isn't USDC and isn't in factory.isMarket()
        bytes memory inner = abi.encodeWithSelector(PLACE_BET_SEL, true, uint256(1_000_000));
        bytes memory callData = _execCallData(fakeMarket, 0, inner);
        _expectScopeRevert(callData, abi.encodeWithSignature("ScopeTargetNotAllowed(address)", fakeMarket));
    }

    function test_scope_revertsOnUsdcWrongSelector() public {
        // Calling some arbitrary function on USDC — e.g. transferFrom
        bytes4 transferFrom = 0x23b872dd;
        bytes memory inner = abi.encodeWithSelector(transferFrom, attacker, attacker, uint256(1_000_000));
        bytes memory callData = _execCallData(usdc, 0, inner);
        _expectScopeRevert(callData, abi.encodeWithSignature("ScopeSelectorNotAllowed(address,bytes4)", usdc, transferFrom));
    }

    function test_scope_revertsOnMarketWrongSelector() public {
        // Calling a non-allowlisted function on a valid Market — e.g. settle()
        bytes4 settle = 0x55ee7c6d; // arbitrary non-allowed selector for this test
        bytes memory inner = abi.encodeWithSelector(settle, true);
        bytes memory callData = _execCallData(validMarket, 0, inner);
        _expectScopeRevert(callData, abi.encodeWithSignature("ScopeSelectorNotAllowed(address,bytes4)", validMarket, settle));
    }

    function test_scope_revertsOnNonExecuteOuter() public {
        // executeBatch or any non-execute outer selector → reject.
        bytes4 executeBatchSel = 0x47e1da2a; // executeBatch(address[],uint256[],bytes[])
        bytes memory callData = abi.encodeWithSelector(executeBatchSel);
        _expectScopeRevert(callData, abi.encodeWithSignature("ScopeOnlyExecuteAllowed(bytes4)", executeBatchSel));
    }

    function test_scope_revertsOnTooShortCallData() public {
        bytes memory callData = hex"112233"; // 3 bytes, less than a selector
        _expectScopeRevert(callData, abi.encodeWithSignature("ScopeCallDataTooShort()"));
    }

    // -----------------------------------------------------------------
    //  Signature failure path — scope check should NOT execute and the
    //  parent's SIG_VALIDATION_FAILED should propagate cleanly.
    // -----------------------------------------------------------------
    function test_badSignature_returnsSigFailed_doesNotRunScope() public {
        // Use an out-of-scope target so we know the scope check would
        // revert IF it ran. With a bad sig, parent returns SIG_FAIL
        // and our override short-circuits before _validateScope.
        bytes memory inner = abi.encodeWithSelector(PLACE_BET_SEL, true, uint256(1));
        bytes memory callData = _execCallData(fakeMarket, 0, inner);
        PackedUserOperation memory op = _emptyOp();
        op.callData = callData;
        op.paymasterAndData = _signAndPack(op, uint48(block.timestamp + 3600), 0, 0xBADBAD);

        vm.prank(address(ep));
        (, uint256 vd) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(uint160(vd), 1, "bad sig should set SIG_VALIDATION_FAILED");
        // If scope had executed, we'd have hit ScopeTargetNotAllowed and reverted.
    }

    function test_validateUserOp_revertsIfNotEntryPoint() public {
        PackedUserOperation memory op = _emptyOp();
        op.paymasterAndData = _signAndPack(op, uint48(block.timestamp + 3600), 0, signerKey);
        vm.prank(attacker);
        vm.expectRevert(bytes("Sender not EntryPoint"));
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    // -----------------------------------------------------------------
    //  Owner controls (inherited)
    // -----------------------------------------------------------------
    function test_withdrawTo_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        paymaster.withdrawTo(payable(attacker), 0.1 ether);
    }

    // =================================================================
    //  Helpers
    // =================================================================
    function _execCallData(address target, uint256 value, bytes memory inner) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EXECUTE_SEL, target, value, inner);
    }

    /// @dev Build a signed UserOp with the given callData and prank EntryPoint
    /// to call validatePaymasterUserOp. Asserts the validationData reports
    /// success (no signature failure + no scope revert).
    function _expectScopeValid(bytes memory callData) internal {
        PackedUserOperation memory op = _emptyOp();
        op.callData = callData;
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = uint48(block.timestamp - 1);
        op.paymasterAndData = _signAndPack(op, validUntil, validAfter, signerKey);

        vm.prank(address(ep));
        (, uint256 vd) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(uint160(vd), 0, "scope should accept this call");
    }

    /// @dev Same but expects a specific custom-error revert with encoded args.
    function _expectScopeRevert(bytes memory callData, bytes memory expectedError) internal {
        PackedUserOperation memory op = _emptyOp();
        op.callData = callData;
        uint48 validUntil = uint48(block.timestamp + 1 hours);
        uint48 validAfter = uint48(block.timestamp - 1);
        op.paymasterAndData = _signAndPack(op, validUntil, validAfter, signerKey);

        vm.prank(address(ep));
        vm.expectRevert(expectedError);
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function _emptyOp() internal view returns (PackedUserOperation memory op) {
        op.sender = user;
        op.nonce = 0;
        op.initCode = "";
        op.callData = "";
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(100_000), uint128(100_000)));
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32(abi.encodePacked(uint128(1e9), uint128(1e9)));
        op.paymasterAndData = abi.encodePacked(
            address(0),
            uint128(100_000), uint128(100_000),
            uint256(0), uint256(0)
        );
        op.signature = "";
    }

    function _signAndPack(
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 key
    ) internal view returns (bytes memory) {
        bytes memory withoutSig = abi.encodePacked(
            address(paymaster),
            uint128(100_000), uint128(100_000),
            abi.encode(validUntil, validAfter)
        );
        op.paymasterAndData = withoutSig;
        bytes32 hash = paymaster.getHash(op, validUntil, validAfter);
        bytes32 ethSigned = MessageHashUtils.toEthSignedMessageHash(hash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ethSigned);
        bytes memory signature = abi.encodePacked(r, s, v);
        return abi.encodePacked(withoutSig, signature);
    }
}
