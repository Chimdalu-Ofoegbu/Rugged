// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MarketFactory} from "../src/MarketFactory.sol";

/// @notice Redeploy MarketFactory after the additive `isMarket` reverse-lookup
///         change. Resolution + ReputationBond + TraceRegistry don't depend
///         on the factory address — they're left untouched.
///
///         Reads from .env: DEPLOYER_PRIVATE_KEY, USDC_ADDRESS,
///         MARKET_RESOLUTION_ADDRESS, TREASURY_ADDRESS, REPUTATION_BOND_ADDRESS.
contract DeployMarketFactory is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address resolution = vm.envAddress("MARKET_RESOLUTION_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address bond = vm.envAddress("REPUTATION_BOND_ADDRESS");

        vm.startBroadcast(deployerPk);
        MarketFactory factory = new MarketFactory(usdc, resolution, treasury, bond);
        vm.stopBroadcast();

        console.log("=== MarketFactory redeployed (with isMarket reverse lookup) ===");
        console.log("MARKET_FACTORY_ADDRESS =", address(factory));
        console.log("");
        console.log("Update .env, then redeploy RuggedPaymaster:");
        console.log("  bash scripts/deploy_paymaster.sh");
    }
}
