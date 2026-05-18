// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {Market} from "../src/Market.sol";
import {Resolution} from "../src/Resolution.sol";
import {ReputationBond} from "../src/ReputationBond.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Integration suite — the full Rugged contract graph wired together.
contract ResolutionTest is Test {
    MockUSDC usdc;
    ReputationBond bond;
    Resolution resolution;
    MarketFactory factory;

    address treasury = makeAddr("treasury");
    address coin = makeAddr("coin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        bond = new ReputationBond(address(usdc), treasury);
        resolution = new Resolution(address(bond));
        bond.setResolution(address(resolution));
        factory = new MarketFactory(address(usdc), address(resolution), treasury, address(bond));
    }

    function _market(uint256 blacklistPrice) internal returns (Market) {
        uint256 id = factory.createMarket(coin, block.timestamp, blacklistPrice, 8000);
        return Market(factory.getMarket(id));
    }

    function _bet(Market m, address who, bool isYes, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(m), amt);
        m.placeBet(isYes, amt);
        vm.stopPrank();
    }

    // --- price math --------------------------------------------------------

    function test_resolve_yesWhenDropOver50() public {
        Market m = _market(1_000e6);
        vm.warp(m.expiry());
        resolution.resolve(address(m), 400e6); // -60% drop
        assertTrue(m.resolved());
        assertTrue(m.yesWon());
    }

    function test_resolve_noWhenDropUnder50() public {
        Market m = _market(1_000e6);
        vm.warp(m.expiry());
        resolution.resolve(address(m), 600e6); // -40% drop
        assertTrue(m.resolved());
        assertFalse(m.yesWon());
    }

    function test_resolve_exactlyHalfIsNoWin() public {
        Market m = _market(1_000e6);
        vm.warp(m.expiry());
        resolution.resolve(address(m), 500e6); // exactly -50%, not strictly >50%
        assertFalse(m.yesWon());
    }

    // --- access / timing ---------------------------------------------------

    function test_resolve_onlyResolver() public {
        Market m = _market(1_000e6);
        vm.warp(m.expiry());
        vm.prank(stranger);
        vm.expectRevert(Resolution.NotResolver.selector);
        resolution.resolve(address(m), 400e6);
    }

    function test_resolve_revertsBeforeExpiry() public {
        Market m = _market(1_000e6);
        vm.expectRevert(Resolution.NotYetExpired.selector);
        resolution.resolve(address(m), 400e6);
    }

    // --- bond integration --------------------------------------------------

    function test_resolve_recordsOutcomeInBond() public {
        Market m = _market(1_000e6);
        vm.warp(m.expiry());
        resolution.resolve(address(m), 400e6); // YES wins -> a hit

        assertEq(bond.outcomeCount(), 1);
        assertEq(bond.hitCount(), 1);
        assertEq(bond.getHitRate(), 10_000);

        (uint256 low, uint256 base, bool yesWon,) = resolution.outcomes(m.marketId());
        assertEq(low, 400e6);
        assertEq(base, 1_000e6);
        assertTrue(yesWon);
    }

    /// End-to-end: open a market, bet both sides, resolve, claim winnings.
    function test_fullFlow_betResolveClaim() public {
        Market m = _market(1_000e6);
        _bet(m, alice, true, 100e6); // YES
        _bet(m, bob, false, 100e6); // NO

        vm.warp(m.expiry());
        resolution.resolve(address(m), 300e6); // YES wins

        // losing pool 100e6 -> 2% fee -> distributable 98e6
        assertEq(m.distributable(), 98e6);

        vm.prank(alice);
        m.claim();
        assertEq(usdc.balanceOf(alice), 198e6); // 100 stake + 98 winnings

        // no bond stakers -> the 0.8% cut forwarded to treasury alongside 1.2%
        assertEq(usdc.balanceOf(treasury), 2e6);
    }
}
