"""Rugged · price snapshot helper.

Fetches the current USD price of a Solana mint at signal time. This is
the `blacklist_price` baseline used by Resolution.sol to evaluate the
"drops >50%" outcome 24 hours later.

Tries sources in order:
    1. RugCheck per-token report (`/v1/tokens/{mint}/report` has a `price`)
    2. CoinGecko on-chain endpoint (no key, public)
    3. DexScreener (free, no key)

Returns price in micro-USD (1e6 fixed-point) to match the
Resolution.sol convention. Returns None if no source has data.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger("watcher.price")


async def _try_rugcheck(mint: str) -> float | None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"https://api.rugcheck.xyz/v1/tokens/{mint}/report")
            r.raise_for_status()
            body = r.json()
        price = body.get("price") or (body.get("fileMeta") or {}).get("price")
        # Some markets have lpPrice or per-market price
        if not price:
            for m in body.get("markets") or []:
                lp = m.get("lp") or {}
                if lp.get("currentPrice"):
                    price = lp["currentPrice"]
                    break
        return float(price) if price else None
    except Exception as exc:  # noqa: BLE001
        log.debug("rugcheck price miss: %s", exc)
        return None


async def _try_dexscreener(mint: str) -> float | None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(f"https://api.dexscreener.com/latest/dex/tokens/{mint}")
            r.raise_for_status()
            body = r.json()
        pairs = body.get("pairs") or []
        if not pairs:
            return None
        # Take the most-liquid pair
        pair = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd", 0))
        return float(pair["priceUsd"]) if pair.get("priceUsd") else None
    except Exception as exc:  # noqa: BLE001
        log.debug("dexscreener miss: %s", exc)
        return None


async def fetch_price_usd(mint: str) -> float | None:
    """Try each source, first hit wins. Returns USD price as float."""
    for src_name, fn in (("rugcheck", _try_rugcheck), ("dexscreener", _try_dexscreener)):
        price = await fn(mint)
        if price and price > 0:
            log.info("price %s = $%.10f (via %s)", mint[:10], price, src_name)
            return price
    log.warning("no price source returned data for %s", mint)
    return None


def to_micro_usd(price_usd: float) -> int:
    """Convert float USD to 1e6 fixed-point micro-USD.

    For very small prices (memecoins often $1e-7), we still round to nearest
    micro — anything below $1e-6 rounds to 1 micro-USD to avoid zero-price
    revert in MarketFactory.
    """
    micro = round(price_usd * 1_000_000)
    return max(1, micro)
