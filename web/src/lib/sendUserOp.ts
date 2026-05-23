// sendUserOp — the gas-free transaction primitive.
//
// Pipeline (matches what viem v2 / permissionless v0.2 expect):
//
//   1. client.prepareUserOperation({ calls }) — viem walks gas estimation,
//      factory/factoryData, AND invokes our paymaster.getPaymasterData hook
//      (configured in smartAccount.ts). The returned op already has paymaster,
//      paymasterData, paymasterVerificationGasLimit, paymasterPostOpGasLimit
//      set, in viem's UNPACKED v0.7 shape.
//
//   2. client.account.signUserOperation(prepared) — the SimpleAccount packs
//      the op internally, asks EntryPoint.getUserOpHash, signs with EIP-191
//      via Privy's embedded EOA, and returns the signature hex.
//
//   3. toPackedUserOperation({ ...prepared, signature }) — convert to the
//      on-chain v0.7 PackedUserOperation shape (initCode, accountGasLimits,
//      gasFees, paymasterAndData all collapsed into bytes).
//
//   4. POST the packed op to /api/bundler/submit. The backend self-bundler
//      calls EntryPoint.handleOps from the funded deployer key and returns
//      the on-chain tx hash + UserOp receipt.

import type { SmartAccountClient } from "permissionless";
import { encodeFunctionData, type Hex } from "viem";
import { toPackedUserOperation, type UserOperation } from "viem/account-abstraction";

import { API_BASE } from "../config";

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
/// Exported because some callers (e.g. tests, manual flows) want to compose
/// the inner call before handing it to sendUserOp.
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

/// Build, sponsor (via the client's getPaymasterData hook), sign, and submit
/// a UserOperation. Throws on any step — the error message names the failure.
export async function sendUserOp(
  client: SmartAccountClient,
  call: { target: `0x${string}`; data: Hex; value?: bigint },
): Promise<SendUserOpResult> {
  if (!client.account) throw new Error("smart account not initialized");

  // Steps 1+2: viem's high-level helpers. `prepareUserOperation` is on the
  // client and fills factory/gas/fees + invokes our paymaster.getPaymasterData
  // hook. `signUserOperation` lives on the account.
  const prepared = (await (client as unknown as {
    prepareUserOperation: (args: {
      calls: Array<{ to: `0x${string}`; value: bigint; data: Hex }>;
    }) => Promise<Record<string, unknown>>;
  }).prepareUserOperation({
    calls: [{ to: call.target, value: call.value ?? 0n, data: call.data }],
  })) as Record<string, unknown>;

  const account = client.account as unknown as {
    signUserOperation: (parameters: Record<string, unknown> & { chainId?: number }) => Promise<Hex>;
  };
  const signature = await account.signUserOperation(prepared);

  // Step 3: pack for the on-chain ABI shape our backend bundler expects.
  // Viem's toPackedUserOperation handles the field concatenation rules
  // (factory||factoryData, verifGasLimit||callGasLimit, fees, paymaster blob).
  // We assert the UserOperation shape — the type-narrowing through
  // prepareUserOperation's generic chain is more cost than it's worth here.
  const finalOp = { ...prepared, signature } as unknown as UserOperation;
  const packed = toPackedUserOperation(finalOp);

  // Step 4: POST to the self-bundler and wait for the EntryPoint receipt.
  const res = await fetch(`${API_BASE}/bundler/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userOp: {
        sender: packed.sender,
        nonce: `0x${packed.nonce.toString(16)}`,
        initCode: packed.initCode,
        callData: packed.callData,
        accountGasLimits: packed.accountGasLimits,
        preVerificationGas: `0x${packed.preVerificationGas.toString(16)}`,
        gasFees: packed.gasFees,
        paymasterAndData: packed.paymasterAndData,
        signature: packed.signature,
      },
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(body.error ?? body.detail ?? `Bundler refused (HTTP ${res.status})`);
  }
  const body = (await res.json()) as {
    userOpHash: string;
    txHash: string;
    blockNumber: number;
    success: boolean;
    actualGasCost: number;
    actualGasUsed: number;
    revertReason: string | null;
  };

  if (!body.success) {
    throw new Error(
      "UserOp validated but inner call reverted" +
      (body.revertReason ? `: ${body.revertReason}` : ""),
    );
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
