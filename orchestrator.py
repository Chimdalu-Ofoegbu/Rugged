"""Rugged · pipeline orchestrator.

Wires the four pieces together:

    watcher  →  swarm consensus  →  Arc MarketFactory  →  trace registry

For each fresh signal:
    1. Run the 3-agent swarm  (agents.consensus.verify_signal)
    2. If consensus fires:
        a. Snapshot the token's current USD price (watcher.price)
        b. Call MarketFactory.createMarket on Arc (chain.factory)
        c. Pin the reasoning trace to Irys + register hash on-chain
           (chain.trace_registry — wired in task #3)

Run:
    uv run python -m orchestrator                # live poll loop
    uv run python -m orchestrator --once         # one poll cycle
    uv run python -m orchestrator --signal <mint> <symbol>   # single forced signal
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=True)

from agents.consensus import ConsensusResult, verify_signal  # noqa: E402
from chain.factory import create_market  # noqa: E402
from chain.trace_registry import register_trace  # noqa: E402
from resolver import daemon as resolver_daemon  # noqa: E402
from traces.pin_trace import pin as pin_trace  # noqa: E402
from watcher import poller  # noqa: E402
from watcher.models import RuggedSignal  # noqa: E402
from watcher.price import fetch_price_usd, to_micro_usd  # noqa: E402

log = logging.getLogger("orchestrator")

DRY_RUN = False  # if True, skip the on-chain call (for local testing)


# ----------------------------------------------------------------------
#  Per-signal pipeline
# ----------------------------------------------------------------------
async def process_signal(signal: RuggedSignal) -> dict[str, Any]:
    """Run swarm + (if fire) open market. Returns a summary dict."""
    log.info("processing signal: %s (%s)", signal.symbol, signal.address[:12])

    # Step 1 — multi-agent swarm
    consensus: ConsensusResult = await verify_signal(signal)
    log.info(
        "swarm verdict: fire=%s prob=%dbps (%.1f%%) hash=%s",
        consensus.fire, consensus.seed_probability_bps,
        consensus.seed_probability_bps / 100, consensus.trace_hash[:10],
    )

    summary: dict[str, Any] = {
        "signal": signal.model_dump(mode="json"),
        "consensus": {
            "fire": consensus.fire,
            "seed_probability_bps": consensus.seed_probability_bps,
            "trace_hash": consensus.trace_hash,
            "verdicts": [v.model_dump() for v in consensus.verdicts],
        },
        "market": None,
        "trace_registry": None,  # populated in task #3
    }

    if not consensus.fire:
        log.info("consensus did not fire — skipping market creation")
        return summary

    # Step 2 — snapshot price for the blacklist baseline
    price_usd = await fetch_price_usd(signal.address)
    if not price_usd:
        log.warning("no price for %s — using fallback 1 micro-USD", signal.symbol)
        price_usd = 0.000001  # absolute floor so MarketFactory.ZeroPrice doesn't revert

    # Step 3 — open the market on Arc
    if DRY_RUN:
        log.info("DRY_RUN — would call MarketFactory.createMarket()")
        return summary

    try:
        # web3 calls are sync; run in a thread so we don't block the event loop
        loop = asyncio.get_running_loop()
        market = await loop.run_in_executor(
            None,
            lambda: create_market(
                mint=signal.address,
                symbol=signal.symbol,
                chain=signal.chain,
                blacklist_timestamp=int(signal.flag_timestamp.timestamp()),
                blacklist_price_micro_usd=to_micro_usd(price_usd),
                seed_probability_bps=consensus.seed_probability_bps,
            ),
        )
        summary["market"] = {**market, "blacklist_price_usd": price_usd}
        log.info(
            "MARKET OPENED · id=%d addr=%s prob=%dbps price=$%.8f",
            market["market_id"], market["market_address"],
            consensus.seed_probability_bps, price_usd,
        )
    except Exception as exc:  # noqa: BLE001 — log and continue, don't kill the loop
        log.exception("createMarket failed for %s: %s", signal.symbol, exc)
        summary["market"] = {"error": str(exc)}

    # Step 4 — pin trace + register on-chain (TraceRegistry).
    try:
        pin_info = pin_trace(consensus.trace)
        # Sanity: the trace we pin must hash to the consensus hash.
        if pin_info["hash"] != consensus.trace_hash:
            log.warning(
                "trace hash mismatch (pin=%s consensus=%s) — using pin hash on-chain",
                pin_info["hash"][:10], consensus.trace_hash[:10],
            )
        market_id = summary["market"]["market_id"]
        loop = asyncio.get_running_loop()
        reg = await loop.run_in_executor(
            None,
            lambda: register_trace(
                market_id=market_id,
                trace_hash_hex=pin_info["hash"],
                uri=pin_info["uri"],
            ),
        )
        summary["trace_registry"] = {**pin_info, **reg}
        log.info(
            "TRACE REGISTERED · market=%d hash=%s uri=%s",
            market_id, pin_info["hash"][:10], pin_info["uri"],
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("trace pin/register failed: %s", exc)
        summary["trace_registry"] = {"error": str(exc)}

    return summary


# ----------------------------------------------------------------------
#  Sink — wired into watcher.poller
# ----------------------------------------------------------------------
def _sink(signal: RuggedSignal) -> None:
    """Synchronous adapter for poller.run() — kicks off the async pipeline."""
    try:
        asyncio.run(process_signal(signal))
    except Exception:  # noqa: BLE001 — survive single-signal failures
        log.exception("pipeline failed for %s", signal.symbol)


def _between_polls() -> None:
    """Resolver tick — runs between watcher polls.

    Snapshots prices for open markets and resolves any that have expired.
    Best-effort; a failure here doesn't take down the watcher loop.
    """
    try:
        asyncio.run(resolver_daemon.tick())
    except Exception:  # noqa: BLE001
        log.exception("resolver tick failed")


# ----------------------------------------------------------------------
#  CLI
# ----------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rugged pipeline orchestrator")
    parser.add_argument("--interval", type=int, default=30, help="poll seconds")
    parser.add_argument("--once", action="store_true", help="one poll cycle then exit")
    parser.add_argument("--dry-run", action="store_true",
                        help="skip on-chain calls (swarm only)")
    parser.add_argument("--signal", nargs=2, metavar=("MINT", "SYMBOL"),
                        help="bypass the watcher and process one forced signal")
    args = parser.parse_args(argv)

    global DRY_RUN
    DRY_RUN = args.dry_run

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.signal:
        mint, symbol = args.signal
        sig = RuggedSignal(
            source="cli-forced",
            symbol=symbol,
            address=mint,
            chain="solana",
            flag_timestamp=datetime.now(timezone.utc),
        )
        result = asyncio.run(process_signal(sig))
        print(json.dumps(result, indent=2, default=str))
        return 0

    log.info("starting pipeline · interval=%ds dry_run=%s", args.interval, DRY_RUN)
    poller.run(
        interval=args.interval,
        once=args.once,
        sink=_sink,
        on_tick_complete=_between_polls,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
