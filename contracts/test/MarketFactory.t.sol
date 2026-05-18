// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MarketFactory} from "../src/MarketFactory.sol";
import {Market} from "../src/Market.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MarketFactoryTest is Test {
    MockUSDC usdc;
    MarketFactory factory;

    address resolution = makeAddr("resolution");
    address treasury = makeAddr("treasury");
    address bond = makeAddr("bond");
    address coin = makeAddr("coin");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new MockUSDC();
        factory = new MarketFactory(address(usdc), resolution, treasury, bond);
    }

    function test_createMarket_storesCorrectParams() public {
        uint256 blacklistTs = block.timestamp;
        uint256 id = factory.createMarket(coin, blacklistTs, 1_000e6, 8300);

        assertEq(id, 0);
        assertEq(factory.marketCount(), 1);

        Market m = Market(factory.getMarket(0));
        assertEq(m.marketId(), 0);
        assertEq(m.coinAddress(), coin);
        assertEq(m.blacklistTimestamp(), blacklistTs);
        assertEq(m.blacklistPrice(), 1_000e6);
        assertEq(m.seedProbabilityBps(), 8300);
        assertEq(m.expiry(), blacklistTs + 24 hours);
        assertEq(address(m.usdc()), address(usdc));
        assertEq(m.resolution(), resolution);
        assertEq(m.treasury(), treasury);
        assertEq(m.reputationBond(), bond);
    }

    function test_createMarket_incrementsIds() public {
        factory.createMarket(coin, block.timestamp, 1e6, 5000);
        factory.createMarket(coin, block.timestamp, 2e6, 6000);
        factory.createMarket(coin, block.timestamp, 3e6, 7000);
        assertEq(factory.marketCount(), 3);
        assertTrue(factory.getMarket(0) != factory.getMarket(1));
        assertTrue(factory.getMarket(1) != factory.getMarket(2));
    }

    function test_createMarket_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        factory.createMarket(coin, block.timestamp, 1e6, 5000);
    }

    function test_createMarket_revertsZeroCoin() public {
        vm.expectRevert(MarketFactory.ZeroAddress.selector);
        factory.createMarket(address(0), block.timestamp, 1e6, 5000);
    }

    function test_createMarket_revertsZeroPrice() public {
        vm.expectRevert(MarketFactory.ZeroPrice.selector);
        factory.createMarket(coin, block.timestamp, 0, 5000);
    }

    function test_createMarket_revertsBadProbability() public {
        vm.expectRevert(MarketFactory.InvalidProbability.selector);
        factory.createMarket(coin, block.timestamp, 1e6, 10_001);
    }
}
