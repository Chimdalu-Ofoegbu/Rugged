// usePrivyWallet — drop-in replacement for the prototype's Circle-driven
// useWallet(). Same return shape, same callable surface (.connect, .refresh,
// .disconnect), so MarketDetail / BetSlip / WalletPill / WalletModal don't
// need to know the wallet is now a Privy-owned smart account.
//
// Wallet identity stack:
//   Privy login (email / Google)
//     → Privy embedded EOA (signer)
//     → permissionless SimpleAccount client (counterfactual)
//     → SmartAccount address = `wallet.address`
//
// On `connect()`:
//   1. Trigger Privy's login modal if not authenticated yet.
//   2. Wait for the SmartAccountClient to be ready via useSmartAccount().
//   3. POST /api/wallet/register with the smart-account address so the
//      backend's per-user faucet + position endpoints work.
//   4. Read on-chain USDC balance.
//
// On `refresh()`: re-read on-chain balance.
// On `disconnect()`: Privy logout. Browser-local — on-chain state stays.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLogin, useLogout, usePrivy } from "@privy-io/react-auth";
import type { SmartAccountClient } from "permissionless";

import { CONTRACTS } from "../config";
import { ERC20_ABI } from "../abis";
import { publicClient } from "../lib/viemClient";
import { useSmartAccount } from "./useSmartAccount";

export type WalletBalance = {
  address: string;
  usdc_raw: number;
  usdc: number;
  usyc_raw: number;
  usyc: number;
};

export type WalletSnapshot = {
  loading: boolean;
  exists: boolean;
  address: `0x${string}` | null;
  // Kept for shape-compatibility with the legacy Circle hook — always null here.
  id: string | null;
  wallet_set_id: string | null;
  balance: WalletBalance | null;
  error: string | null;
  client: SmartAccountClient | null;
};

const DISCONNECTED: WalletSnapshot = {
  loading: false,
  exists: false,
  address: null,
  id: null,
  wallet_set_id: null,
  balance: null,
  error: null,
  client: null,
};

/// What we publish to the rest of the (JSX-only) prototype via window.useWallet.
export type WalletWithActions = WalletSnapshot & {
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  disconnect: () => Promise<void>;
};

async function readUsdcBalance(address: `0x${string}`): Promise<WalletBalance> {
  let usdcRaw = 0n;
  try {
    usdcRaw = (await publicClient.readContract({
      address: CONTRACTS.usdc,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  } catch (_) {
    // best-effort — if RPC is flaky, render $0 rather than blank.
  }
  return {
    address,
    usdc_raw: Number(usdcRaw),
    usdc: Number(usdcRaw) / 1_000_000,
    usyc_raw: 0,
    usyc: 0,
  };
}

/// Returns the same shape `useWallet` did, sourced from Privy + smart-account.
export function usePrivyWallet(): WalletWithActions {
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const sa = useSmartAccount();

  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(false);

  // Re-read balance when the smart-account address first becomes available
  // or when the caller explicitly refreshes.
  const refresh = useCallback(async () => {
    if (sa.status !== "ready") return;
    setBusy(true);
    try {
      const bal = await readUsdcBalance(sa.address);
      setBalance(bal);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [sa.status, sa.status === "ready" ? sa.address : null]);

  // Register the smart-account address with the backend once. Idempotent
  // server-side, but we still gate to avoid hammering on every render.
  useEffect(() => {
    if (sa.status !== "ready" || registered) return;
    const userId = (typeof window !== "undefined" && window.localStorage?.getItem("rugged_user_id")) || "";
    if (!userId) return;
    fetch("/api/wallet/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rugged-User-Id": userId,
      },
      body: JSON.stringify({ address: sa.address }),
    })
      .then((r) => { if (r.ok) setRegistered(true); })
      .catch(() => { /* non-fatal — backend faucet endpoint just won't work until next try */ });
  }, [sa.status, sa.status === "ready" ? sa.address : null, registered]);

  // Auto-refresh balance once when the wallet first becomes ready.
  useEffect(() => {
    if (sa.status === "ready" && balance == null) {
      refresh();
    }
  }, [sa.status, balance, refresh]);

  const connect = useCallback(async () => {
    setError(null);
    if (!ready) return;
    if (!authenticated) {
      try {
        await login();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    // After login, useSmartAccount will pick up the embedded wallet on the next
    // render. balance + register flow above handles the rest.
  }, [ready, authenticated, login]);

  const disconnect = useCallback(async () => {
    try {
      await logout();
    } finally {
      setBalance(null);
      setRegistered(false);
    }
  }, [logout]);

  const snapshot: WalletWithActions = useMemo(() => {
    const loading = !ready || busy || sa.status === "loading" || (authenticated && sa.status === "idle");
    if (sa.status === "ready") {
      return {
        ...DISCONNECTED,
        loading,
        exists: true,
        address: sa.address,
        balance,
        error,
        client: sa.client,
        connect,
        refresh,
        disconnect,
      };
    }
    return {
      ...DISCONNECTED,
      loading,
      error: error ?? (sa.status === "error" ? sa.error : null),
      connect,
      refresh,
      disconnect,
    };
  }, [ready, busy, sa, authenticated, balance, error, connect, refresh, disconnect]);

  return snapshot;
}
