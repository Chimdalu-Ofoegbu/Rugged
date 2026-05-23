"""Rugged · scripts — fresh LIVE demo markets.

Opens N polished prediction markets on Arc for hackathon recording. Each
market is created with:
  - a realistic Solana-style mint (random 32-byte base58)
  - a recognizable symbol pulled from a curated list
  - a real blacklist price (not the placeholder 1,000 µUSD that
    `/api/admin/demo-market` writes)
  - a 24h duration so the betting window survives a multi-take recording
  - a hand-built 3-agent reasoning trace, pinned via traces.pin_trace and
    registered on-chain via TraceRegistry — so the market detail page
    renders with full reasoning instead of an empty trace hash

After all markets are created the script POSTs
/api/admin/clear-markets-cache so the next /api/markets call hits chain
instead of the 5-min stale cache.

Run:
    uv run python -m scripts.seed_demo_markets             # 4 markets
    uv run python -m scripts.seed_demo_markets --count 6   # custom count

This is a hackathon affordance — production live markets are opened by
the watcher → orchestrator → swarm pipeline, not this script.
"""

from __future__ import annotations

import argparse
import base58
import logging
import random
import secrets
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=True)

from chain.factory import create_market  # noqa: E402
from chain.trace_registry import register_trace  # noqa: E402
from traces.pin_trace import pin as pin_trace  # noqa: E402

log = logging.getLogger("scripts.seed_demo_markets")

# Curated pool of demo tokens. Each row: (symbol, blacklist_price_usd,
# seed_probability_bps, contract_score, social_score, flow_score).
# Prices are realistic for low-cap rug-candidate tokens; seeds are the
# confidence-weighted mean used by consensus.py.
DEMO_POOL: list[tuple[str, float, int, float, float, float]] = [
    ("PEPELON",   0.000412, 8200, 0.86, 0.79, 0.84),
    ("MOONFROG",  0.000091, 7500, 0.79, 0.71, 0.77),
    ("RUGGYBEAR", 0.000033, 8700, 0.91, 0.78, 0.86),
    ("WAGMI42",   0.001240, 8400, 0.92, 0.81, 0.88),
    ("DEGENPUP",  0.000770, 5800, 0.61, 0.52, 0.58),
    ("AIDOGE99",  0.002150, 6600, 0.71, 0.58, 0.68),
    ("FLOKICAT",  0.000088, 7700, 0.83, 0.69, 0.79),
    ("MOONLAMBO", 0.000022, 8300, 0.88, 0.79, 0.84),
]


def _contract_verdict(score: float) -> tuple[list[str], str]:
    if score >= 0.75:
        return (
            [
                "Mint authority NOT renounced — dev can mint at will",
                "Ownership retained on the LP pair contract",
                "Top-10 holders concentrate 78% of supply",
                "Honeypot heuristic: sell tax 18%, buy tax 4%",
            ],
            "Contract retains every escape hatch a maliciously-aligned dev needs: "
            "unrenounced mint, retained LP ownership, asymmetric transfer taxes. "
            "The holder concentration alone would suffice; combined with mint "
            "authority this is a textbook setup for a coordinated dump.",
        )
    if score >= 0.55:
        return (
            [
                "Mint authority renounced (verified on-chain)",
                "LP locked for <30 days — short runway",
                "Honeypot scan clean",
            ],
            "Contract is partially defanged — mint is renounced, no honeypot "
            "patterns — but the short LP lock leaves the dev with a near-term exit.",
        )
    return (
        ["Mint renounced", "Ownership burned", "LP locked >90 days"],
        "Contract is structurally clean: mint and ownership are both "
        "irrevocable, LP locked well past any plausible exit window.",
    )


def _social_verdict(score: float) -> tuple[list[str], str]:
    if score >= 0.7:
        return (
            [
                "Coordinated shilling: 6 accounts posted within a 4h window",
                "Dev wallet went silent within hours of peak price",
                "Telegram member count dropped 22% post-peak",
            ],
            "Classic pump-distribute fingerprint: synchronized promotional "
            "accounts, dev going dark at peak, fast community attrition.",
        )
    if score >= 0.5:
        return (
            ["Dev reply rate dropped ~70% over last 48h",
             "Engagement decay outpacing price action"],
            "Engagement is decaying faster than the price suggests it should, "
            "and the dev has noticeably pulled back from community channels.",
        )
    return (
        ["Organic sentiment", "Dev active in 3 channels in last 24h"],
        "Social profile consistent with an organic community.",
    )


def _flow_verdict(score: float) -> tuple[list[str], str]:
    if score >= 0.75:
        return (
            [
                "LP removed 42% in last 6h",
                "Dev wallet drained 1.2 SOL to a fresh address",
                "Top holder offloaded 18% of position",
            ],
            "Flow is the loudest signal: LP is being unwound at a rate that "
            "drains the pool inside 24h. Combined with a top-holder dump this "
            "is the exact sequence we'd expect immediately before a finishing-leg sell.",
        )
    if score >= 0.55:
        return (
            ["LP shrinking ~3% per hour", "Top-5 holders concentrate 61% of float"],
            "Flow leans bearish but not panicked: LP bleeding slowly, holder "
            "concentration high enough that one whale move would move price hard.",
        )
    return (
        ["LP depth stable for >72h", "Dev wallets dormant"],
        "On-chain flow is benign: LP depth stable, dev wallets dormant.",
    )


def _build_trace(
    *,
    symbol: str,
    mint: str,
    blacklist_ts: int,
    contract_score: float,
    social_score: float,
    flow_score: float,
    seed_bps: int,
) -> dict[str, Any]:
    """Canonical reasoning trace matching agents.consensus.ConsensusResult.trace."""
    c_signals, c_reason = _contract_verdict(contract_score)
    s_signals, s_reason = _social_verdict(social_score)
    f_signals, f_reason = _flow_verdict(flow_score)
    return {
        "schema_version": "1.0",
        "signal": {
            "source": "scripts.seed_demo_markets",
            "symbol": symbol,
            "address": mint,
            "chain": "solana",
            "flag_timestamp": blacklist_ts,
        },
        "fire": True,
        "seed_probability_bps": seed_bps,
        "verdicts": [
            {
                "agent": "contract_analyzer",
                "score": round(contract_score, 3),
                "confidence": 0.90,
                "key_signals": c_signals,
                "reasoning": c_reason,
                "evidence": {},
            },
            {
                "agent": "social_signal_analyzer",
                "score": round(social_score, 3),
                "confidence": 0.85,
                "key_signals": s_signals,
                "reasoning": s_reason,
                "evidence": {},
            },
            {
                "agent": "onchain_flow_analyzer",
                "score": round(flow_score, 3),
                "confidence": 0.92,
                "key_signals": f_signals,
                "reasoning": f_reason,
                "evidence": {},
            },
        ],
    }


def _random_mint() -> str:
    """A real-shape Solana mint pubkey — random 32 bytes encoded as base58."""
    return base58.b58encode(secrets.token_bytes(32)).decode("ascii")


def _to_micro_usd(price_usd: float) -> int:
    return max(1, int(round(price_usd * 1_000_000)))


def seed(*, count: int, duration_seconds: int, api_base: str | None) -> list[dict[str, Any]]:
    rows = random.sample(DEMO_POOL, k=min(count, len(DEMO_POOL)))
    results: list[dict[str, Any]] = []
    now = int(time.time())

    for symbol, price_usd, seed_bps, c_score, s_score, f_score in rows:
        mint = _random_mint()
        log.info("creating market: %s mint=%s seed=%dbps price=$%g",
                 symbol, mint[:10], seed_bps, price_usd)

        market = create_market(
            mint=mint,
            symbol=symbol,
            chain="solana",
            blacklist_timestamp=now,
            blacklist_price_micro_usd=_to_micro_usd(price_usd),
            seed_probability_bps=seed_bps,
            duration_seconds=duration_seconds,
        )
        market_id = int(market["market_id"])
        log.info("  → market_id=%d addr=%s tx=%s",
                 market_id, market["market_address"], market["tx_hash"][:18])

        trace = _build_trace(
            symbol=symbol,
            mint=mint,
            blacklist_ts=now,
            contract_score=c_score,
            social_score=s_score,
            flow_score=f_score,
            seed_bps=seed_bps,
        )
        pin_info = pin_trace(trace)
        log.info("  → trace pinned: hash=%s", pin_info["hash"][:12])

        try:
            reg = register_trace(
                market_id=market_id,
                trace_hash_hex=pin_info["hash"],
                uri=pin_info["uri"],
            )
            log.info("  → trace registered on-chain: tx=%s", reg["tx_hash"][:18])
        except Exception as exc:  # noqa: BLE001 — non-fatal; market is open either way
            log.warning("  → trace registration failed (market is live anyway): %s", exc)
            reg = {"error": str(exc)}

        results.append({
            "symbol": symbol,
            "mint": mint,
            "market_id": market_id,
            "market_address": market["market_address"],
            "blacklist_price_usd": price_usd,
            "seed_probability_bps": seed_bps,
            "expiry": now + duration_seconds,
            "trace_hash": pin_info["hash"],
            "trace_tx": reg.get("tx_hash"),
        })

    # Last step: kick the API cache so the freshly-created markets show up
    # immediately on the next /api/markets call.
    if api_base:
        try:
            r = httpx.post(f"{api_base.rstrip('/')}/api/admin/clear-markets-cache", timeout=5.0)
            log.info("api cache invalidate: HTTP %d", r.status_code)
        except Exception as exc:  # noqa: BLE001
            log.warning("cache invalidate failed (it will refresh on its own): %s", exc)

    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed fresh live demo markets on Arc")
    parser.add_argument("--count", type=int, default=4,
                        help=f"how many markets to open (default 4, max {len(DEMO_POOL)})")
    parser.add_argument("--duration-seconds", type=int, default=24 * 3600,
                        help="betting window per market (default 86400 = 24h)")
    parser.add_argument("--api-base", default="http://127.0.0.1:8001",
                        help="backend base URL for cache invalidation (use '' to skip)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(message)s",
                        datefmt="%H:%M:%S")

    api_base = args.api_base or None
    markets = seed(
        count=args.count,
        duration_seconds=args.duration_seconds,
        api_base=api_base,
    )

    print()
    print(f"opened {len(markets)} markets:")
    for m in markets:
        print(f"  · {m['symbol']:10s} id={m['market_id']:<3d} "
              f"price=${m['blacklist_price_usd']:<10g} "
              f"seed={m['seed_probability_bps']/100:.1f}%  "
              f"trace={m['trace_hash'][:10]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
