// Viem chain object for Arc Testnet — Privy + permissionless need this
// to construct UserOperations and route RPC calls correctly. We define
// it from our `config.ts` values rather than relying on a viem preset
// (Arc isn't shipped as a viem `Chain` constant yet).

import { defineChain } from "viem";
import { ARC_CHAIN_ID, ARC_RPC_URL } from "./config";

export const arcTestnet = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc Testnet",
  network: "arc-testnet",
  nativeCurrency: {
    name: "Arc",
    symbol: "ARC",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
    public: { http: [ARC_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://testnet-explorer.arc.network" },
  },
  testnet: true,
});
