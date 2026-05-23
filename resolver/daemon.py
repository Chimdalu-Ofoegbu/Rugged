"""Rugged · resolver daemon.

One async tick per orchestrator cycle:

    1. List every market on-chain.
    2. For each unresolved market:
       - If we don't have a tracker file yet, init one.
       - If the market is still inside its 24h window, snapshot the
         current price (rugcheck → dexscreener fallback) and tighten
         the running minimum.
       - If the market is past expiry, call Resolution.resolve(market,
         observedLow) from the resolver key. Resolution.sol then drives
         Market.settle (which performs the 2% fee split + writes
         winningPool / distributable) and writes the outcome into the
         ReputationBond.

The tick is best-effort: a single market failing (price source down,
estimate_gas revert, etc.) logs a warning but doesn't block the rest.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from chain.factory import _factory_contract
from chain.market import read_market
from chain.resolution import get_outcome, resolve as on_chain_resolve
from resolver import tracker
from watcher.price import fetch_price_usd, to_micro_usd

log = logging.getLogger("resolver.daemon")

# How often the orchestrator should snapshot prices during the open window.
# 60s on the wall clock; we just no-op if less time has passed since the
# previous observation — keeps the daemon cheap to call.
MIN_OBSERVATION_INTERVAL_S = 60


async def _snapshot_price(mint: str) -> tuple[int, str] | None:
    """Best-effort price snapshot in micro-USD. Returns (price, source)."""
    try:
        price_usd = await fetch_price_usd(mint)
    except Exception as exc:  # noqa: BLE001
        log.debug("price fetch raised for %s: %s", mint[:10], exc)
        return None
    if not price_usd or price_usd <= 0:
        return None
    return to_micro_usd(price_usd), "watcher.price"


def _mint_for_market(state: dict[str, Any]) -> str | None:
    """Look up the original Solana mint for a market's derived EVM address."""
    from api.main import _mint_registry  # lazy — avoid circular at import
    derived = state["coin_address"].lower()
    return _mint_registry().get(derived, {}).get("mint")


async def tick() -> dict[str, Any]:
    """One pass over all on-chain markets. Safe to call repeatedly."""
    summary: dict[str, Any] = {
        "polled": 0, "observed": 0, "resolved": 0, "errors": 0, "skipped": 0,
    }
    factory = _factory_contract()
    try:
        count = factory.functions.marketCount().call()
    except Exception as exc:  # noqa: BLE001
        log.warning("resolver: marketCount() failed: %s", exc)
        return {**summary, "errors": summary["errors"] + 1}

    now = int(time.time())
    for market_id in range(count):
        try:
            addr = factory.functions.getMarket(market_id).call()
            if int(addr, 16) == 0:
                summary["skipped"] += 1
                continue
            state = read_market(addr)

            # 1. Done already? Cheap exit.
            if state["resolved"]:
                summary["skipped"] += 1
                continue

            mint = _mint_for_market(state)
            if not mint:
                # No mint mapping → can't price. Mark and move on.
                log.debug("resolver: no mint mapping for market %d (%s)", market_id, addr)
                summary["skipped"] += 1
                continue

            # 2. Make sure we have a tracker file for this market.
            tracker.init(
                market_id=market_id,
                mint=mint,
                blacklist_price_micro_usd=state["blacklist_price_micro_usd"],
                blacklist_timestamp=state["blacklist_timestamp"],
                expiry=state["expiry"],
            )
            summary["polled"] += 1

            # 3. Past expiry → resolve and continue. (Don't bother taking
            #    another price observation; the contract is about to lock.)
            if now >= state["expiry"]:
                rec = tracker.load(market_id)
                low = rec["low_price_micro_usd"] if rec else state["blacklist_price_micro_usd"]
                if get_outcome(market_id):
                    # Defensive — local read said unresolved but Resolution
                    # already has an outcome. Treat as resolved.
                    log.info("market %d already has outcome on Resolution; skipping", market_id)
                    summary["skipped"] += 1
                    continue
                try:
                    res = on_chain_resolve(market_address=addr, observed_low_micro_usd=int(low))
                    log.info(
                        "market %d resolved · low=%d baseline=%d tx=%s",
                        market_id, low, state["blacklist_price_micro_usd"], res["tx_hash"][:18],
                    )
                    summary["resolved"] += 1
                except Exception as exc:  # noqa: BLE001
                    log.exception("resolve failed for market %d: %s", market_id, exc)
                    summary["errors"] += 1
                continue

            # 4. Inside the window → poll price if it's been a while.
            rec = tracker.load(market_id)
            if rec and (now - rec.get("last_polled_at", 0)) < MIN_OBSERVATION_INTERVAL_S:
                continue
            snap = await _snapshot_price(mint)
            if snap is None:
                tracker.mark_polled(market_id)
                continue
            price_micro, src = snap
            tracker.record_observation(market_id, price_micro_usd=price_micro, source=src)
            summary["observed"] += 1
        except Exception as exc:  # noqa: BLE001
            log.exception("resolver tick failed on market %d: %s", market_id, exc)
            summary["errors"] += 1

    if any(v for k, v in summary.items() if k != "skipped"):
        log.info("resolver tick: %s", summary)
    return summary


def run_in_thread() -> asyncio.Task:
    """Schedule the tick on the running loop. Called by the orchestrator."""
    return asyncio.create_task(tick())
