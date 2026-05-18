// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ReputationBond} from "../src/ReputationBond.sol";
import {TraceRegistry} from "../src/TraceRegistry.sol";
import {Resolution} from "../src/Resolution.sol";
import {MarketFactory} from "../src/MarketFactory.sol";

/// @notice Deploys the Rugged contract suite to Arc testnet in dependency
///         order, then wires the cross-references.
///
///         Reads from the environment (exported from the repo-root .env by
///         scripts/deploy.sh): DEPLOYER_PRIVATE_KEY, USDC_ADDRESS,
///         TREASURY_ADDRESS, OPERATOR_ADDRESS.
contract Deploy is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");

        vm.startBroadcast(deployerPk);

        // 1. ReputationBond — needs USDC + treasury
        ReputationBond bond = new ReputationBond(usdc, treasury);

        // 2. TraceRegistry — standalone, operator-gated
        TraceRegistry registry = new TraceRegistry(operator);

        // 3. Resolution — needs the bond address
        Resolution resolution = new Resolution(address(bond));

        // 4. MarketFactory — needs USDC, resolution, treasury, bond
        MarketFactory factory =
            new MarketFactory(usdc, address(resolution), treasury, address(bond));

        // 5. Wire: only Resolution may record outcomes into the bond
        bond.setResolution(address(resolution));

        vm.stopBroadcast();

        console.log("=== Rugged contracts deployed to Arc testnet ===");
        console.log("REPUTATION_BOND_ADDRESS  =", address(bond));
        console.log("TRACE_REGISTRY_ADDRESS   =", address(registry));
        console.log("MARKET_RESOLUTION_ADDRESS=", address(resolution));
        console.log("MARKET_FACTORY_ADDRESS   =", address(factory));
    }
}
