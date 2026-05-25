// Compile-time + runtime config for the Rugged frontend.
//
// Strategy:
//   - VITE_* env vars are the SEED (used as fallbacks before bootstrap).
//   - `bootstrapContracts()` (called from main.tsx before the React tree
//     renders) fetches /api/paymaster/info and overwrites the seed values
//     with whatever the backend's .env actually says.
//   - After bootstrap, every other module reads `CONTRACTS.*` synchronously
//     and gets the right addresses — no more silent .env drift between the
//     backend and frontend.
//
// If the bootstrap fetch fails (backend down, CORS, network), we fall back
// to the seed values + log a warning, so the page still loads in degraded
// mode.

export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;

// REST endpoint for the FastAPI backend.
//   - In dev, Vite proxies /api to :8001 (see vite.config.ts), so the default
//     same-origin "/api" works.
//   - In prod-mode-1 (legacy), FastAPI serves the built SPA, so "/api" is
//     also same-origin and the default works.
//   - In prod-mode-2 (split deploy: Vercel frontend + Railway backend), set
//     VITE_API_BASE to the absolute API URL, e.g.
//     "https://rugged-api-production-xxxx.up.railway.app/api".
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

// Arc Testnet chain config. The RPC URL must be reachable from the user's
// browser; for testnet that's fine.
export const ARC_CHAIN_ID = Number(import.meta.env.VITE_ARC_CHAIN_ID ?? 5042002);
export const ARC_RPC_URL = (import.meta.env.VITE_ARC_RPC_URL as string | undefined) ??
  "https://testnet-rpc.arc.network";

// Mutable contract registry — overwritten in place by bootstrapContracts().
// Initial values come from VITE_* env vars (set in web/.env.local for local
// dev) so the page still works if the backend is unreachable.
export const CONTRACTS: {
  paymaster: `0x${string}`;
  marketFactory: `0x${string}`;
  entryPoint: `0x${string}`;
  usdc: `0x${string}`;
} = {
  paymaster: (import.meta.env.VITE_PAYMASTER_ADDRESS as `0x${string}` | undefined) ??
    "0xBCF0bc5f29da7440D64Df1D569f7Db0B6fdE75D0",
  marketFactory: (import.meta.env.VITE_MARKET_FACTORY_ADDRESS as `0x${string}` | undefined) ??
    "0x554137E2ABdAD6bEcc7638DD454a9abC8418515F",
  entryPoint: (import.meta.env.VITE_ENTRYPOINT_ADDRESS as `0x${string}` | undefined) ??
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  usdc: (import.meta.env.VITE_USDC_ADDRESS as `0x${string}` | undefined) ??
    "0x3600000000000000000000000000000000000000",
};

/// Fetch the live contract addresses from the backend and mutate CONTRACTS
/// in place. Resolves regardless of success — failures log and leave the
/// VITE_* fallbacks in place.
export async function bootstrapContracts(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/paymaster/info`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as {
      paymaster?: string;
      entryPoint?: string;
      factory?: string;
      usdc?: string;
    };
    if (info.paymaster) CONTRACTS.paymaster = info.paymaster as `0x${string}`;
    if (info.entryPoint) CONTRACTS.entryPoint = info.entryPoint as `0x${string}`;
    if (info.factory) CONTRACTS.marketFactory = info.factory as `0x${string}`;
    if (info.usdc) CONTRACTS.usdc = info.usdc as `0x${string}`;
  } catch (e) {
    console.warn(
      "[rugged] bootstrapContracts failed — falling back to compile-time addresses.",
      e instanceof Error ? e.message : e,
    );
  }
}

if (!PRIVY_APP_ID) {
  console.warn(
    "[rugged] VITE_PRIVY_APP_ID is unset. Privy login will fail until you set it in web/.env.local",
  );
}
