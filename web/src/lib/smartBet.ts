// smartBet — high-level operations on Rugged markets via the gas-abstracted
// smart-account flow (Privy → SimpleAccount → RuggedPaymaster → self-bundler).
//
// Each operation returns the on-chain receipt from the EntryPoint UserOp event.
// No native gas prompt is ever surfaced to the user — paymaster pays.
//
// These wrap sendUserOp() with the right calldata for each contract entry
// point. Call them from React components (or the browser console) once you
// have a SmartAccountClient from useSmartAccount().

import { encodeFunctionData, type Hex } from "viem";

import type { SmartAccountClient } from "permissionless";
import { CONTRACTS } from "../config";
import { ERC20_ABI, MARKET_ABI } from "../abis";
import { sendUserOp, type SendUserOpResult } from "./sendUserOp";

/// Approve `amount` USDC for the given Market (or any spender) via a sponsored
/// UserOp. Pre-flight allowance with `currentAllowance()` before calling so we
/// don't burn a UserOp when the allowance already covers it.
export async function approveUsdc(
  client: SmartAccountClient,
  spender: `0x${string}`,
  amountMicroUsdc: bigint,
): Promise<SendUserOpResult> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [spender, amountMicroUsdc],
  });
  return sendUserOp(client, { target: CONTRACTS.usdc, data });
}

/// Place a USDC bet on a Market. Caller must ensure the market has allowance
/// — either by `approveUsdc(client, marketAddress, amount)` first OR via the
/// `placeBet` helper below which auto-approves.
export async function placeBetRaw(
  client: SmartAccountClient,
  marketAddress: `0x${string}`,
  isYes: boolean,
  amountMicroUsdc: bigint,
): Promise<SendUserOpResult> {
  const data = encodeFunctionData({
    abi: MARKET_ABI,
    functionName: "placeBet",
    args: [isYes, amountMicroUsdc],
  });
  return sendUserOp(client, { target: marketAddress, data });
}

/// All-in-one: approve (if needed) + placeBet. Returns both UserOp results
/// so callers can surface both tx hashes if they want, or only the bet hash.
///
/// Costs 1 UserOp if the allowance already covers `amount`, else 2.
export async function placeBet(
  client: SmartAccountClient,
  opts: {
    marketAddress: `0x${string}`;
    isYes: boolean;
    amountMicroUsdc: bigint;
    currentAllowance?: bigint;
  },
): Promise<{ approve: SendUserOpResult | null; bet: SendUserOpResult }> {
  const { marketAddress, isYes, amountMicroUsdc, currentAllowance } = opts;
  let approve: SendUserOpResult | null = null;
  if ((currentAllowance ?? 0n) < amountMicroUsdc) {
    approve = await approveUsdc(client, marketAddress, amountMicroUsdc);
  }
  const bet = await placeBetRaw(client, marketAddress, isYes, amountMicroUsdc);
  return { approve, bet };
}

/// Claim winnings on a resolved Market.
export async function claimMarket(
  client: SmartAccountClient,
  marketAddress: `0x${string}`,
): Promise<SendUserOpResult> {
  const data = encodeFunctionData({
    abi: MARKET_ABI,
    functionName: "claim",
    args: [],
  });
  return sendUserOp(client, { target: marketAddress, data });
}

/// Cancel a still-open bet on the given side. Refunds full stake to the
/// smart-account wallet on success.
export async function cancelMarketBet(
  client: SmartAccountClient,
  marketAddress: `0x${string}`,
  isYes: boolean,
): Promise<SendUserOpResult> {
  const data = encodeFunctionData({
    abi: MARKET_ABI,
    functionName: "cancelBet",
    args: [isYes],
  });
  return sendUserOp(client, { target: marketAddress, data });
}

/// USDC.transfer — for "withdraw to external address" from the smart account.
export async function transferUsdc(
  client: SmartAccountClient,
  to: `0x${string}`,
  amountMicroUsdc: bigint,
): Promise<SendUserOpResult> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to, amountMicroUsdc],
  });
  return sendUserOp(client, { target: CONTRACTS.usdc, data });
}
