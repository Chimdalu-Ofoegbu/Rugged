// Paymaster sponsorship — talks to POST /api/paymaster/sponsor.
//
// Contract (frontend → backend):
//   POST /api/paymaster/sponsor
//   {
//     "userOp": <PackedUserOperation, JSON-encoded hex fields>,
//     "wallet": "0x...",     // the Privy address — backend can rate-limit
//     "chainId": 5042002
//   }
//
//   200 → { paymasterAndData: "0x..." }      // ready to attach to UserOp
//   403 → { error: "not in scope: ..." }     // selector / target rejected
//   429 → { error: "rate limited" }
//
// The backend route lives in Phase 4. Until that lands, the function
// throws a clear error so the calling code surfaces a "backend not
// implemented yet" message rather than mysteriously hanging.

import { API_BASE, ARC_CHAIN_ID } from "../config";
import type { PackedUserOpJson } from "./userOpTypes";

export type SponsorshipResponse = {
  paymasterAndData: `0x${string}`;
  validUntil?: number;
  validAfter?: number;
};

export async function fetchSponsorship(
  userOp: PackedUserOpJson,
  wallet: `0x${string}`,
): Promise<SponsorshipResponse> {
  const res = await fetch(`${API_BASE}/paymaster/sponsor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userOp, wallet, chainId: ARC_CHAIN_ID }),
  });
  if (res.status === 404) {
    // Phase 4 not yet shipped. Make the error explicit so debugging is
    // pleasant if someone tries betting before the backend is ready.
    throw new Error(
      "Paymaster sponsor route not deployed yet (Phase 4 pending). " +
      "The on-chain paymaster + factory work — once /api/paymaster/sponsor " +
      "lands, this flow will be live end-to-end.",
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    throw new Error(body.error ?? body.detail ?? `Paymaster refused (HTTP ${res.status})`);
  }
  return res.json() as Promise<SponsorshipResponse>;
}
