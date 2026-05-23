// REST client for the FastAPI backend at /api.
//
// In dev, Vite proxies /api to :8001. In prod, FastAPI serves the built
// SPA from the same origin. Either way, fetches are same-origin and need
// no special headers.
//
// Everything in this module is a *public* read (markets list, market
// detail, position-by-address). The wallet-scoped routes that used to
// require X-Rugged-User-Id are gone in the Privy era: identity is the
// connected wallet address, which we pass as a query parameter where
// needed.

import { API_BASE } from "../config";

export type LiveMarket = {
  market_id: number;
  address: `0x${string}`;
  coin_address: `0x${string}`;
  blacklist_timestamp: number;
  blacklist_price_micro_usd: number;
  seed_probability_bps: number;
  expiry: number;
  yes_pool: number;
  no_pool: number;
  yes_odds_bps: number;
  no_odds_bps: number;
  resolved: boolean;
  yes_won: boolean;
  winning_pool: number;
  distributable: number;
  mint?: string | null;
  symbol?: string | null;
  chain?: string | null;
  trace?: { hash: string; uri: string; registered_at: number } | null;
  historical?: boolean;
};

export type MarketsResponse = {
  markets: LiveMarket[];
  count: number;
  live_count?: number;
  historical_count?: number;
  cached?: boolean;
};

export type PositionResponse = {
  has_wallet: boolean;
  wallet_address?: `0x${string}`;
  market_address?: `0x${string}`;
  yes_stake_micro_usdc?: number;
  no_stake_micro_usdc?: number;
  has_position?: boolean;
  is_winner?: boolean;
  claimed?: boolean;
  claimable_micro_usdc?: number;
  can_claim?: boolean;
  historical?: boolean;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? body.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  listMarkets: () => getJson<MarketsResponse>("/markets"),
  marketDetail: (id: number) => getJson<LiveMarket & { full_trace?: unknown; outcome?: unknown }>(
    `/markets/${id}`,
  ),
  marketPosition: (id: number, wallet?: string) => {
    const qs = wallet ? `?wallet=${wallet}` : "";
    return getJson<PositionResponse>(`/markets/${id}/position${qs}`);
  },
  stats: () => getJson<{ hit_rate: number; hit_rate_pct: number; market_count: number; open_markets: number }>(
    "/stats",
  ),
};
