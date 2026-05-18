// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReputationBond} from "../src/ReputationBond.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract ReputationBondTest is Test {
    MockUSDC usdc;
    ReputationBond bond;

    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        bond = new ReputationBond(address(usdc), treasury);
        bond.setResolution(address(this)); // test drives recordOutcome
    }

    function _stake(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(bond), amt);
        bond.stake(amt);
        vm.stopPrank();
    }

    // --- staking -----------------------------------------------------------

    function test_stake_firstStakerOneToOne() public {
        _stake(alice, 1_000e6);
        assertEq(bond.sharesOf(alice), 1_000e6);
        assertEq(bond.totalShares(), 1_000e6);
        assertEq(bond.totalAssets(), 1_000e6);
        assertEq(bond.assetsOf(alice), 1_000e6);
    }

    function test_stake_proportionalShares() public {
        _stake(alice, 1_000e6);
        _stake(bob, 500e6);
        assertEq(bond.sharesOf(bob), 500e6);
        assertEq(bond.totalAssets(), 1_500e6);
        assertEq(bond.assetsOf(alice), 1_000e6);
        assertEq(bond.assetsOf(bob), 500e6);
    }

    // --- unstake cooldown --------------------------------------------------

    function test_unstake_cooldownEnforced() public {
        _stake(alice, 1_000e6);

        vm.startPrank(alice);
        bond.unstake(1_000e6);
        vm.expectRevert(ReputationBond.CooldownActive.selector);
        bond.claimUnstake();
        vm.stopPrank();

        vm.warp(block.timestamp + bond.COOLDOWN());
        vm.prank(alice);
        bond.claimUnstake();

        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(bond.sharesOf(alice), 0);
        assertEq(bond.totalAssets(), 0);
    }

    function test_unstake_revertsWhenPendingExists() public {
        _stake(alice, 1_000e6);
        vm.startPrank(alice);
        bond.unstake(400e6);
        vm.expectRevert(ReputationBond.PendingExists.selector);
        bond.unstake(400e6);
        vm.stopPrank();
    }

    // --- hit rate + slashing ----------------------------------------------

    function test_recordOutcome_onlyResolution() public {
        vm.prank(stranger);
        vm.expectRevert(ReputationBond.NotResolution.selector);
        bond.recordOutcome(1, true);
    }

    function test_recordOutcome_updatesHitRate() public {
        bond.recordOutcome(1, true);
        bond.recordOutcome(2, true);
        bond.recordOutcome(3, true);
        bond.recordOutcome(4, false); // 3 hits / 4 = 7500 bps
        assertEq(bond.outcomeCount(), 4);
        assertEq(bond.hitCount(), 3);
        assertEq(bond.getHitRate(), 7500);
    }

    /// project.md required test: slash fires at the correct threshold.
    function test_slash_firesBelowFloor() public {
        _stake(alice, 1_000e6);
        // one miss -> hit rate 0% -> shortfall 7000 bps -> slash 70%
        bond.recordOutcome(1, false);

        assertEq(bond.getHitRate(), 0);
        assertEq(bond.totalAssets(), 300e6);
        assertEq(bond.assetsOf(alice), 300e6);
        assertEq(usdc.balanceOf(treasury), 700e6);
    }

    function test_slash_doesNotFireAtFloor() public {
        _stake(alice, 1_000e6);
        for (uint256 i = 0; i < 7; i++) {
            bond.recordOutcome(i, true);
        }
        for (uint256 i = 0; i < 3; i++) {
            bond.recordOutcome(7 + i, false);
        }
        // 7 hits / 10 = 7000 bps == floor, not below -> no slash
        assertEq(bond.getHitRate(), 7000);
        assertEq(bond.totalAssets(), 1_000e6);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_window_capsAt30() public {
        for (uint256 i = 0; i < 35; i++) {
            bond.recordOutcome(i, true);
        }
        assertEq(bond.outcomeCount(), 30);
        assertEq(bond.getHitRate(), 10_000);
    }

    // --- fee pool ----------------------------------------------------------

    function test_depositFees_proRata() public {
        _stake(alice, 1_000e6);
        _stake(bob, 1_000e6); // 50 / 50

        usdc.mint(address(this), 100e6);
        usdc.approve(address(bond), 100e6);
        bond.depositFees(100e6);

        assertEq(bond.pendingFees(alice), 50e6);
        assertEq(bond.pendingFees(bob), 50e6);

        vm.prank(alice);
        bond.claimFees();
        assertEq(usdc.balanceOf(alice), 50e6);

        vm.prank(bob);
        bond.claimFees();
        assertEq(usdc.balanceOf(bob), 50e6);
    }

    function test_depositFees_noStakers_routesToTreasury() public {
        usdc.mint(address(this), 100e6);
        usdc.approve(address(bond), 100e6);
        bond.depositFees(100e6);
        assertEq(usdc.balanceOf(treasury), 100e6);
    }
}
