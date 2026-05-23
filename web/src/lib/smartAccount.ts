// Smart-account adapter: wrap a Privy embedded wallet as a SimpleSmartAccount.
//
// Privy gives us an EOA-style wallet via useWallets(). For ERC-4337 v0.7 we need
// a smart-contract account that signs UserOperations. We use permissionless +
// viem's account-abstraction to wrap the EOA as a SimpleAccount.
//
// Sponsorship is wired into the client via the `paymaster.getPaymasterData`
// hook — viem's `prepareUserOperation` invokes it during op construction so
// the paymaster fields are present BEFORE signing. That matches what the
// RuggedPaymaster contract verifies on-chain (the user sig covers the
// paymaster bytes via EntryPoint.getUserOpHash).

import type { ConnectedWallet } from "@privy-io/react-auth";
import { createPublicClient, http, type Hex } from "viem";
import { toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { toSimpleSmartAccount } from "permissionless/accounts";
import { createSmartAccountClient, type SmartAccountClient } from "permissionless";

import { arcTestnet } from "../arc-chain";
import { API_BASE, CONTRACTS } from "../config";

/// Submission goes through our self-bundler at /api/bundler/submit, not a
/// viem-compatible JSON-RPC bundler. The client still needs a `bundlerTransport`
/// to construct, but we never call client.sendUserOperation — sendUserOp.ts
/// posts directly to our backend instead.
const BUNDLER_URL = (import.meta.env.VITE_BUNDLER_URL as string | undefined)
  ?? "http://127.0.0.1:14337/rpc";

/// Backend response from POST /api/paymaster/sponsor.
type SponsorResponse = {
  paymasterAndData: Hex;
  validUntil: number;
  validAfter: number;
  scope: string;
};

/// Split the on-chain paymasterAndData blob into viem's v0.7 unpacked fields.
/// Layout (matches RuggedPaymaster.sol):
///   [0:20]    paymaster address
///   [20:36]   validationGasLimit (uint128) || postOpGasLimit (uint128)
///   [36:100]  abi.encode(uint48 validUntil, uint48 validAfter)
///   [100:]    65-byte signature
function unpackPaymasterAndData(blob: Hex) {
  const raw = blob.startsWith("0x") ? blob.slice(2) : blob;
  const bytes = new Uint8Array(raw.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);

  const paymaster = ("0x" + raw.slice(0, 40)) as `0x${string}`;
  // 16-byte uint128 each
  const verifGasHex = "0x" + raw.slice(40, 72);
  const postOpGasHex = "0x" + raw.slice(72, 104);
  // paymasterData carries (validUntil || validAfter) abi.encoded + signature.
  // On-chain RuggedPaymaster.parsePaymasterAndData reads from offset
  // PAYMASTER_DATA_OFFSET = 52, so paymasterData is everything from byte 52
  // onward — i.e. the abi.encoded timestamps + signature, exactly what we got
  // from the backend minus the first 52 bytes.
  const paymasterData = ("0x" + raw.slice(104)) as `0x${string}`;
  return {
    paymaster,
    paymasterVerificationGasLimit: BigInt(verifGasHex),
    paymasterPostOpGasLimit: BigInt(postOpGasHex),
    paymasterData,
  };
}

type ViemPaymasterFields = ReturnType<typeof unpackPaymasterAndData>;

/// Construct a SmartAccountClient for the given Privy wallet.
///
/// The client:
///   - has account.address as the deterministic counterfactual SimpleAccount
///   - is configured with paymaster.getPaymasterData that fetches sponsorship
///     from /api/paymaster/sponsor and returns the viem-shaped fields
///   - is NOT used for submission — sendUserOp.ts handles that via our
///     /api/bundler/submit relay.
export async function makeSmartAccountClient(
  wallet: ConnectedWallet,
): Promise<SmartAccountClient> {
  const provider = await wallet.getEthereumProvider();

  // Best-effort: switch the wallet's active chain to Arc. Embedded wallets
  // (Privy's MPC) don't actually need this, but injected wallets do.
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${arcTestnet.id.toString(16)}` }],
    });
  } catch {
    /* not all providers support chain-switching; ignore */
  }

  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
  });

  const account = await toSimpleSmartAccount({
    client: publicClient,
    owner: provider as { request(...args: unknown[]): Promise<unknown> },
    entryPoint: { address: CONTRACTS.entryPoint, version: "0.7" },
  });

  return createSmartAccountClient({
    account,
    chain: arcTestnet,
    bundlerTransport: http(BUNDLER_URL),
    paymaster: {
      // Fired by viem's prepareUserOperation BEFORE signing. We post the
      // (still unsigned) packed UserOp to /api/paymaster/sponsor; the backend
      // signs the sponsorship and returns the paymasterAndData blob. We then
      // unpack it into viem's expected fields. Viem includes those in the
      // userOpHash the account signs over, so the on-chain paymaster's
      // signature check passes.
      async getPaymasterData(userOp): Promise<ViemPaymasterFields> {
        // Pack the in-flight unpacked op (without paymaster fields yet) so
        // the backend can verify scope on the same bytes the contract will see.
        // The `userOp` param is a partial-but-mostly-filled UserOp at this
        // point in viem's pipeline — cast away the union narrowing.
        const opForPack = { ...userOp, signature: "0x" as Hex } as unknown as UserOperation;
        const packed = toPackedUserOperation(opForPack);

        const body = {
          userOp: {
            sender: packed.sender,
            nonce: `0x${packed.nonce.toString(16)}`,
            initCode: packed.initCode,
            callData: packed.callData,
            accountGasLimits: packed.accountGasLimits,
            preVerificationGas: `0x${packed.preVerificationGas.toString(16)}`,
            gasFees: packed.gasFees,
            paymasterAndData: "0x",
            signature: "0x",
          },
          wallet: packed.sender,
          chainId: arcTestnet.id,
        };
        const res = await fetch(`${API_BASE}/paymaster/sponsor`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as Record<string, string>;
          throw new Error(err.error ?? err.detail ?? `Paymaster refused (HTTP ${res.status})`);
        }
        const payload = (await res.json()) as SponsorResponse;
        return unpackPaymasterAndData(payload.paymasterAndData);
      },
      // We don't need a stub because we estimate via the same hook above;
      // viem skips this when getPaymasterData is provided.
    },
  });
}
