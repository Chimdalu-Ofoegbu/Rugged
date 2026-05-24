// sendUserOp — the gas-free transaction primitive.
//
// Avoids viem's high-level `client.prepareUserOperation` because that
// invokes the bundlerTransport for eth_estimateUserOperationGas, which
// would hit a non-existent local Skandha. We do everything manually
// against the public Arc client + our own backend instead:
//
//   1. Get nonce + factoryArgs from the SmartAccount.
//   2. Build callData via SimpleAccount.execute(target, value, data).
//   3. Hardcode conservative gas limits (paymaster pays — no incentive
//      to be precise).
//   4. POST the (still-unsigned) packed UserOp to /api/paymaster/sponsor.
//      Backend signs the sponsorship, returns paymasterAndData.
//   5. Unpack the blob into viem's UserOperation fields.
//   6. account.signUserOperation(...) — Privy iframe signs the EIP-191
//      hash internally.
//   7. POST the fully-signed PackedUserOperation to /api/bundler/submit.
//      Backend self-bundler relays it through EntryPoint.handleOps.

import type { SmartAccountClient } from "permissionless";
import { decodeAbiParameters, encodeFunctionData, type Hex } from "viem";
import { toPackedUserOperation, type UserOperation } from "viem/account-abstraction";

import { API_BASE, ARC_CHAIN_ID } from "../config";
import { publicClient } from "./viemClient";

/// Decode a Solidity revert payload into a human-readable string. Handles:
///   - Standard Error(string): `0x08c379a0` + ABI-encoded string
///   - Standard Panic(uint256): `0x4e487b71` + uint256 panic code
///   - Empty revert (returndatasize == 0)
///   - Custom errors / unknown selectors — falls through with the raw hex
/// Without this the user sees ~200 chars of hex spilling out of the modal.
export function decodeRevertReason(data: string | null | undefined): string {
  if (!data) return "(no revert data)";
  const hex = data.startsWith("0x") ? data : `0x${data}`;
  if (hex === "0x" || hex.length <= 2) return "(empty revert — likely out-of-gas or assert)";
  const selector = hex.slice(0, 10).toLowerCase();
  const payload = ("0x" + hex.slice(10)) as Hex;
  // Error(string) — `revert("ERC20: transfer amount exceeds balance")` etc.
  if (selector === "0x08c379a0") {
    try {
      const [reason] = decodeAbiParameters([{ type: "string" }], payload);
      const trimmed = String(reason).trim();
      return trimmed.length ? trimmed : "(empty Error(string))";
    } catch {
      return `Error(string) — undecodable payload ${hex.slice(0, 80)}…`;
    }
  }
  // Panic(uint256) — solc-inserted bounds/overflow/etc. checks.
  if (selector === "0x4e487b71") {
    try {
      const [code] = decodeAbiParameters([{ type: "uint256" }], payload);
      const codeNum = Number(code);
      const codeMap: Record<number, string> = {
        0x01: "assertion failed",
        0x11: "arithmetic overflow/underflow",
        0x12: "division or modulo by zero",
        0x21: "enum out of range",
        0x22: "storage byte array incorrectly encoded",
        0x31: "pop on empty array",
        0x32: "array index out of bounds",
        0x41: "out of memory",
        0x51: "called zero-initialized variable of internal function type",
      };
      const label = codeMap[codeNum] ?? `panic code 0x${codeNum.toString(16)}`;
      return `Panic: ${label}`;
    } catch {
      return `Panic(uint256) — undecodable payload`;
    }
  }
  // Custom error or unrecognized — return shortened selector + raw.
  const shortHex = hex.length > 80 ? `${hex.slice(0, 76)}…` : hex;
  return `Custom error ${selector} (${shortHex})`;
}

export type SendUserOpResult = {
  userOpHash: Hex;
  txHash: Hex;
  blockNumber: number;
  success: boolean;
  actualGasCost: number;
  actualGasUsed: number;
  revertReason: string | null;
  gasCostUsd: 0;
};

/// Build calldata for a SimpleAccount.execute(target, value, data) call.
export function executeCall(target: `0x${string}`, value: bigint, data: Hex): Hex {
  return encodeFunctionData({
    abi: [{
      type: "function",
      name: "execute",
      inputs: [
        { name: "dest", type: "address" },
        { name: "value", type: "uint256" },
        { name: "func", type: "bytes" },
      ],
      outputs: [],
      stateMutability: "nonpayable",
    }],
    functionName: "execute",
    args: [target, value, data],
  });
}

/// Split the on-chain paymasterAndData blob into viem's v0.7 unpacked fields.
/// Mirrors smartAccount.ts's getPaymasterData hook layout.
///   [0:20]    paymaster address
///   [20:36]   validationGasLimit (uint128) || postOpGasLimit (uint128)
///   [36:]     paymasterData (timestamps + signature)
function unpackPaymasterAndData(blob: Hex) {
  const raw = blob.startsWith("0x") ? blob.slice(2) : blob;
  const paymaster = ("0x" + raw.slice(0, 40)) as `0x${string}`;
  const verifGasHex = "0x" + raw.slice(40, 72);
  const postOpGasHex = "0x" + raw.slice(72, 104);
  const paymasterData = ("0x" + raw.slice(104)) as `0x${string}`;
  return {
    paymaster,
    paymasterVerificationGasLimit: BigInt(verifGasHex),
    paymasterPostOpGasLimit: BigInt(postOpGasHex),
    paymasterData,
  };
}

function toHex(n: bigint): Hex {
  return ("0x" + n.toString(16)) as Hex;
}

/// Build, sponsor, sign, and submit a UserOperation manually.
export async function sendUserOp(
  client: SmartAccountClient,
  call: { target: `0x${string}`; data: Hex; value?: bigint },
): Promise<SendUserOpResult> {
  if (!client.account) throw new Error("smart account not initialized");
  const account = client.account as unknown as {
    address: `0x${string}`;
    getNonce: () => Promise<bigint>;
    getFactoryArgs: () => Promise<{ factory?: `0x${string}`; factoryData?: Hex }>;
    signUserOperation: (
      op: UserOperation & { chainId?: number },
    ) => Promise<Hex>;
  };

  const sender = account.address;

  // 1. Nonce + factory (latter only set if the account isn't deployed yet).
  const [nonce, factoryArgs] = await Promise.all([
    account.getNonce(),
    account.getFactoryArgs(),
  ]);

  // 2. Inner call.
  const callData = executeCall(call.target, call.value ?? 0n, call.data);

  // 3. Gas — generous fixed values. Paymaster covers the cost so over-
  // estimation just means a little extra wei sits in EntryPoint, refunded
  // on postOp. Bigger verificationGasLimit on first op to cover deployment.
  const isFirstOp = !!factoryArgs.factory;
  const verificationGasLimit = isFirstOp ? 800_000n : 200_000n;
  const callGasLimit = 250_000n;
  const preVerificationGas = 70_000n;
  const gasPrice = await publicClient.getGasPrice();
  const maxPriorityFeePerGas = gasPrice > 1_000_000_000n ? gasPrice : 1_000_000_000n;
  const maxFeePerGas = maxPriorityFeePerGas * 2n;

  // 4. Assemble the unsigned op (no paymaster fields yet, no signature).
  const unsigned: UserOperation = {
    sender,
    nonce,
    factory: factoryArgs.factory,
    factoryData: factoryArgs.factoryData,
    callData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    signature: "0x" as Hex,
  } as unknown as UserOperation;

  // 5. POST to /api/paymaster/sponsor with the packed shape the backend
  //    verifies. Backend signs over the same bytes the on-chain paymaster
  //    will check; the blob it returns we splice back into the unpacked op.
  const packedNoPayMaster = toPackedUserOperation(unsigned);
  const sponsorRes = await fetch(`${API_BASE}/paymaster/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userOp: {
        sender: packedNoPayMaster.sender,
        nonce: toHex(packedNoPayMaster.nonce),
        initCode: packedNoPayMaster.initCode,
        callData: packedNoPayMaster.callData,
        accountGasLimits: packedNoPayMaster.accountGasLimits,
        preVerificationGas: toHex(packedNoPayMaster.preVerificationGas),
        gasFees: packedNoPayMaster.gasFees,
        paymasterAndData: "0x",
        signature: "0x",
      },
      wallet: sender,
      chainId: ARC_CHAIN_ID,
    }),
  });
  if (!sponsorRes.ok) {
    const err = (await sponsorRes.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(err.error ?? err.detail ?? `Paymaster refused (HTTP ${sponsorRes.status})`);
  }
  const sponsorBody = (await sponsorRes.json()) as { paymasterAndData: Hex };
  const pmFields = unpackPaymasterAndData(sponsorBody.paymasterAndData);

  // 6. Splice paymaster fields back, then sign.
  const sponsored: UserOperation = {
    ...unsigned,
    ...pmFields,
  } as UserOperation;
  const signature = await account.signUserOperation({
    ...sponsored,
    chainId: ARC_CHAIN_ID,
  });

  // 7. Pack the fully-signed op + POST to /api/bundler/submit.
  const finalPacked = toPackedUserOperation({
    ...sponsored,
    signature,
  } as UserOperation);
  const submitRes = await fetch(`${API_BASE}/bundler/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userOp: {
        sender: finalPacked.sender,
        nonce: toHex(finalPacked.nonce),
        initCode: finalPacked.initCode,
        callData: finalPacked.callData,
        accountGasLimits: finalPacked.accountGasLimits,
        preVerificationGas: toHex(finalPacked.preVerificationGas),
        gasFees: finalPacked.gasFees,
        paymasterAndData: finalPacked.paymasterAndData,
        signature: finalPacked.signature,
      },
    }),
  });
  if (!submitRes.ok) {
    const err = (await submitRes.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(err.error ?? err.detail ?? `Bundler refused (HTTP ${submitRes.status})`);
  }
  const body = (await submitRes.json()) as {
    userOpHash: string;
    txHash: string;
    blockNumber: number;
    success: boolean;
    actualGasCost: number;
    actualGasUsed: number;
    revertReason: string | null;
  };

  if (!body.success) {
    const decoded = decodeRevertReason(body.revertReason);
    // Log the raw hex for debugging — Solidity custom errors aren't decodable
    // without the contract ABI, and dev needs the raw bytes to look up the
    // selector against the deployed contracts.
    if (body.revertReason) {
      // eslint-disable-next-line no-console
      console.warn("[sendUserOp] inner call reverted. raw:", body.revertReason);
    }
    throw new Error(`Inner call reverted: ${decoded}`);
  }

  return {
    userOpHash: body.userOpHash as Hex,
    txHash: body.txHash as Hex,
    blockNumber: body.blockNumber,
    success: body.success,
    actualGasCost: body.actualGasCost,
    actualGasUsed: body.actualGasUsed,
    revertReason: body.revertReason,
    gasCostUsd: 0,
  };
}
