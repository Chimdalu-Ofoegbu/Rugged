// Wire-format types for PackedUserOperation v0.7 — kept separate from the
// runtime smart-account code so the backend Phase-4 work can import these
// types directly without pulling permissionless or viem.

/// JSON-serializable form (all bytes/uints as hex strings). Used over the
/// wire between the frontend and the backend's /api/paymaster/sponsor.
export type PackedUserOpJson = {
  sender: `0x${string}`;
  nonce: `0x${string}`;          // uint256 → hex
  initCode: `0x${string}`;       // bytes
  callData: `0x${string}`;       // bytes
  accountGasLimits: `0x${string}`; // bytes32 — verificationGas || callGas
  preVerificationGas: `0x${string}`; // uint256 → hex
  gasFees: `0x${string}`;        // bytes32 — maxPriorityFee || maxFee
  paymasterAndData: `0x${string}`; // bytes — may be empty for unsponsored
  signature: `0x${string}`;      // bytes — account-side signature (may be empty pre-sign)
};
