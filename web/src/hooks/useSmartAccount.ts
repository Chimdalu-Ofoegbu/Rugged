// React hook that returns a memoized SmartAccountClient for the current
// signer wallet. The signer is either:
//   - the Privy embedded wallet (email login → MPC EOA), or
//   - the first connected external wallet (MetaMask, Rabby, Coinbase Wallet
//     extension, WalletConnect, etc.).
// Embedded wins when both are present — the email-first user shouldn't have
// their smart-account address shift if they later link an external wallet.
// Returns null while Privy is still initializing or before any wallet is
// available.

import { useEffect, useState } from "react";
import { useWallets } from "@privy-io/react-auth";
import type { SmartAccountClient } from "permissionless";

import { makeSmartAccountClient } from "../lib/smartAccount";

export type SmartAccountState =
  | { status: "idle"; client: null; address: null; error: null }
  | { status: "loading"; client: null; address: null; error: null }
  | { status: "ready"; client: SmartAccountClient; address: `0x${string}`; error: null }
  | { status: "error"; client: null; address: null; error: string };

const IDLE: SmartAccountState = { status: "idle", client: null, address: null, error: null };

export function useSmartAccount(): SmartAccountState {
  const { wallets } = useWallets();
  const [state, setState] = useState<SmartAccountState>(IDLE);

  const signerWallet =
    wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];

  useEffect(() => {
    let cancelled = false;
    if (!signerWallet) {
      setState(IDLE);
      return;
    }
    setState({ status: "loading", client: null, address: null, error: null });
    makeSmartAccountClient(signerWallet)
      .then(async (client) => {
        if (cancelled) return;
        // permissionless.SmartAccountClient exposes account.getAddress()
        const address = client.account?.address as `0x${string}` | undefined;
        if (!address) {
          setState({ status: "error", client: null, address: null, error: "no smart-account address" });
          return;
        }
        setState({ status: "ready", client, address, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: "error",
          client: null,
          address: null,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => { cancelled = true; };
  }, [signerWallet?.address]);

  return state;
}
