// Public viem clients for Arc Testnet.
//
// Used for: chain reads (market state, balances, allowances, isMarket).
// NOT used for: signing UserOps — that's the smart-account client in
// ./smartAccount.ts which has its own signer chain.

import { createPublicClient, http } from "viem";

import { arcTestnet } from "../arc-chain";

export const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(),
});
