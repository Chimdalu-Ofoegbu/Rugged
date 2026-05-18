// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Market} from "../src/Market.sol";
import {ReputationBond} from "../src/ReputationBond.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MarketTest is Test {
    MockUSDC usdc;
    ReputationBond bond;
    Market market;

    address treasury = makeAddr("treasury");
    address coin = makeAddr("coin");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");

    uint256 blacklistTs;

    function setUp() public {
        usdc = new MockUSDC();
        bond = new ReputationBond(address(usdc), treasury);
        blacklistTs = block.timestamp;
        // resolution = address(this) so the test can drive settle()
        market = _newMarket(blacklistTs);
    }

    function _newMarket(uint256 ts) internal returns (Market) {
        return new Market(
            address(usdc), 0, coin, ts, 1_000e6, 8300, address(this), treasury, address(bond)
        );
    }

    function _bet(Market m, address who, bool isYes, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(m), amt);
        m.placeBet(isYes, amt);
        vm.stopPrank();
    }

    function _stakeBond(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.startPrank(who);
        usdc.approve(address(bond), amt);
        bond.stake(amt);
        vm.stopPrank();
    }

    // --- betting -----------------------------------------------------------

    function test_placeBet_updatesPools() public {
        _bet(market, alice, true, 100e6);
        _bet(market, bob, false, 60e6);

        assertEq(market.yesPool(), 100e6);
        assertEq(market.noPool(), 60e6);
        assertEq(market.yesStake(alice), 100e6);
        assertEq(market.noStake(bob), 60e6);
        assertEq(usdc.balanceOf(address(market)), 160e6);
    }

    function test_placeBet_revertsZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(Market.ZeroAmount.selector);
        market.placeBet(true, 0);
    }

    function test_placeBet_revertsAfterExpiry() public {
        vm.warp(market.expiry());
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(market), 10e6);
        vm.expectRevert(Market.BettingClosed.selector);
        market.placeBet(true, 10e6);
        vm.stopPrank();
    }

    function test_getOdds_seedBeforeBets() public view {
        (uint256 yesBps, uint256 noBps) = market.getOdds();
        assertEq(yesBps, 8300);
        assertEq(noBps, 1700);
    }

    function test_getOdds_afterBets() public {
        _bet(market, alice, true, 100e6);
        _bet(market, bob, false, 50e6);
        (uint256 yesBps, uint256 noBps) = market.getOdds();
        assertEq(yesBps, 6666); // 100e6 * 10000 / 150e6, integer division
        assertEq(noBps, 3334);
    }

    // --- settlement --------------------------------------------------------

    function test_settle_onlyResolution() public {
        vm.warp(market.expiry());
        vm.prank(stranger);
        vm.expectRevert(Market.NotResolution.selector);
        market.settle(true);
    }

    function test_settle_revertsBeforeExpiry() public {
        vm.expectRevert(Market.NotYetExpired.selector);
        market.settle(true);
    }

    /// project.md required test: fee split is exactly 1.2% / 0.8%.
    function test_settle_feeSplit_1_2_and_0_8() public {
        // a bond staker so the 0.8% cut stays in the bond (not forwarded)
        _stakeBond(carol, 1_000e6);
        uint256 bondBefore = usdc.balanceOf(address(bond));

        _bet(market, alice, true, 100e6); // YES (winning side)
        _bet(market, bob, false, 60e6); // NO  (losing pool)

        vm.warp(market.expiry());
        market.settle(true); // YES wins

        uint256 losingPool = 60e6;
        uint256 treasuryCut = (losingPool * 120) / 10_000; // 1.2%
        uint256 bondCut = (losingPool * 80) / 10_000; // 0.8%

        assertEq(treasuryCut, 720_000); // 0.72 USDC
        assertEq(bondCut, 480_000); // 0.48 USDC
        assertEq(usdc.balanceOf(treasury), treasuryCut);
        assertEq(usdc.balanceOf(address(bond)) - bondBefore, bondCut);
        assertEq(market.distributable(), losingPool - treasuryCut - bondCut);
        assertEq(market.winningPool(), 100e6);
    }

    function test_claim_winnerPayout() public {
        _bet(market, alice, true, 100e6);
        _bet(market, bob, false, 60e6);
        vm.warp(market.expiry());
        market.settle(true);

        // alice is the only YES staker -> takes the whole distributable pool
        uint256 distributable = market.distributable();
        vm.prank(alice);
        market.claim();
        assertEq(usdc.balanceOf(alice), 100e6 + distributable);
    }

    function test_claim_loserReverts() public {
        _bet(market, alice, true, 100e6);
        _bet(market, bob, false, 60e6);
        vm.warp(market.expiry());
        market.settle(true); // YES wins; bob loses

        vm.prank(bob);
        vm.expectRevert(Market.NothingToClaim.selector);
        market.claim();
    }

    function test_claim_revertsTwice() public {
        _bet(market, alice, true, 100e6);
        vm.warp(market.expiry());
        market.settle(true);

        vm.startPrank(alice);
        market.claim();
        vm.expectRevert(Market.AlreadyClaimed.selector);
        market.claim();
        vm.stopPrank();
    }

    function test_settle_noWinners_routesToTreasury() public {
        // only NO bets, but YES wins -> no winners
        _bet(market, bob, false, 50e6);
        vm.warp(market.expiry());
        market.settle(true);

        assertEq(usdc.balanceOf(treasury), 50e6);
        assertEq(market.distributable(), 0);
        assertEq(market.winningPool(), 0);
    }
}
