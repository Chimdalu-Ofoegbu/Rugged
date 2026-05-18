// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TraceRegistry} from "../src/TraceRegistry.sol";

contract TraceRegistryTest is Test {
    TraceRegistry registry;
    address operator = makeAddr("operator");
    address stranger = makeAddr("stranger");

    function setUp() public {
        registry = new TraceRegistry(operator);
    }

    function test_constructor_setsOperator() public view {
        assertEq(registry.operator(), operator);
        assertEq(registry.owner(), address(this));
    }

    function test_registerTrace_byOperator() public {
        bytes32 hash = keccak256("swarm-trace-json");
        vm.prank(operator);
        registry.registerTrace(1, hash, "bafybeicq4i");

        (bytes32 h, string memory cid, uint256 ts) = registry.getTrace(1);
        assertEq(h, hash);
        assertEq(cid, "bafybeicq4i");
        assertEq(ts, block.timestamp);
    }

    function test_registerTrace_revertsForNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(TraceRegistry.NotOperator.selector);
        registry.registerTrace(1, bytes32(0), "cid");
    }

    function test_registerTrace_revertsOnDuplicate() public {
        vm.startPrank(operator);
        registry.registerTrace(1, keccak256("a"), "cid-a");
        vm.expectRevert(TraceRegistry.AlreadyRegistered.selector);
        registry.registerTrace(1, keccak256("b"), "cid-b");
        vm.stopPrank();
    }

    function test_setOperator_byOwner() public {
        registry.setOperator(stranger);
        assertEq(registry.operator(), stranger);

        vm.prank(stranger);
        registry.registerTrace(7, keccak256("x"), "cid-x");
        (, string memory cid,) = registry.getTrace(7);
        assertEq(cid, "cid-x");
    }

    function test_setOperator_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.setOperator(stranger);
    }
}
