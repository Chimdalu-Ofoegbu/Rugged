// React hook that returns a memoized SmartAccountClient for the current
// Privy embedded wallet. Returns null while Privy is still initializing
// or when no embedded wallet exists yet (e.g. user signed in via Google
// but Privy hasn't finished provisioning the wallet).

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

  const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");

  useEffect(() => {
    let cancelled = false;
    if (!embeddedWallet) {
      setState(IDLE);
      return;
    }
    setState({ status: "loading", client: null, address: null, error: null });
    makeSmartAccountClient(embeddedWallet)
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
  }, [embeddedWallet?.address]);

  return state;
}
