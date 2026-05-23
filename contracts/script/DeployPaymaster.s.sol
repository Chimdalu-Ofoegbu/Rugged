// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {RuggedPaymaster, IMarketFactoryView} from "../src/RuggedPaymaster.sol";

/// @notice Deploys the RuggedPaymaster on Arc Testnet.
///
///         Reads from the environment (exported from the repo-root .env by
///         scripts/deploy_paymaster.sh):
///           - DEPLOYER_PRIVATE_KEY        — funds + owns the paymaster
///           - PAYMASTER_SIGNER_ADDRESS    — off-chain verifying signer
///           - USDC_ADDRESS                — Arc-testnet USDC
///           - MARKET_FACTORY_ADDRESS      — Rugged MarketFactory (with isMarket support)
///           - ENTRYPOINT_ADDRESS          — canonical ERC-4337 v0.7 EntryPoint
///                                           (defaults to 0x00000…32 if not set)
///           - PAYMASTER_INITIAL_DEPOSIT_WEI — optional, in wei (defaults to 0)
///
///         Prints the deployed paymaster address; copy it back into .env as
///         PAYMASTER_ADDRESS so the backend + frontend can pick it up.
contract DeployPaymaster is Script {
    address constant DEFAULT_ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifyingSigner = vm.envAddress("PAYMASTER_SIGNER_ADDRESS");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address marketFactory = vm.envAddress("MARKET_FACTORY_ADDRESS");

        // Allow override of the EntryPoint address (mostly for local Anvil
        // tests). On any real chain — Arc included — use the canonical address.
        address entryPointAddr = vm.envOr("ENTRYPOINT_ADDRESS", DEFAULT_ENTRYPOINT_V07);

        // Optional initial deposit so the paymaster can immediately sponsor.
        uint256 initialDeposit = vm.envOr("PAYMASTER_INITIAL_DEPOSIT_WEI", uint256(0));

        require(verifyingSigner != address(0), "PAYMASTER_SIGNER_ADDRESS missing");
        require(usdc != address(0), "USDC_ADDRESS missing");
        require(marketFactory != address(0), "MARKET_FACTORY_ADDRESS missing");
        require(entryPointAddr.code.length > 0, "ENTRYPOINT_ADDRESS has no code on this chain");
        require(marketFactory.code.length > 0, "MARKET_FACTORY_ADDRESS has no code on this chain");

        vm.startBroadcast(deployerPk);

        RuggedPaymaster paymaster = new RuggedPaymaster(
            IEntryPoint(entryPointAddr),
            verifyingSigner,
            usdc,
            IMarketFactoryView(marketFactory)
        );

        if (initialDeposit > 0) {
            paymaster.deposit{value: initialDeposit}();
        }

        vm.stopBroadcast();

        console.log("=== RuggedPaymaster deployed ===");
        console.log("PAYMASTER_ADDRESS         =", address(paymaster));
        console.log("ENTRYPOINT_ADDRESS        =", entryPointAddr);
        console.log("PAYMASTER_SIGNER_ADDRESS  =", verifyingSigner);
        console.log("USDC_ADDRESS              =", usdc);
        console.log("MARKET_FACTORY_ADDRESS    =", marketFactory);
        console.log("VERSION                   =", paymaster.VERSION());
        console.log("INITIAL_DEPOSIT_WEI       =", initialDeposit);
        console.log("");
        console.log("Next steps:");
        console.log("  1. Replace PAYMASTER_ADDRESS in .env with the value above.");
        console.log("  2. Fund it: send ARC and call paymaster.deposit{value: X}()");
        console.log("     to forward to EntryPoint. Funds in the old paymaster");
        console.log("     can be reclaimed via owner.withdrawTo() if needed.");
    }
}
