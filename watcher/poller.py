"""Rugged · watcher orchestrator (Phase 2).

Polls every registered source on a fixed interval, dedupes signals by
(chain, address), and yields a stream of `RuggedSignal`s for downstream
consumers (Phase 3 swarm + Phase 4 market creation).

Run standalone:
    uv run python -m watcher.poller

Each poll prints emitted signals; deduped repeats are dropped.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Callable, Iterable
from typing import TextIO

from watcher.models import RuggedSignal
from watcher.sources import rugcheck

log = logging.getLogger("watcher.poller")

DEFAULT_INTERVAL_SECONDS = 30

# Registered discovery sources. Each is a no-arg callable returning a list.
SOURCES: dict[str, Callable[[], list[RuggedSignal]]] = {
    "rugcheck": rugcheck.fetch_signals,
}


def poll_once(seen: set[str]) -> list[RuggedSignal]:
    """Fetch all sources, return only signals whose key hasn't been seen."""
    fresh: list[RuggedSignal] = []
    for name, fetch in SOURCES.items():
        try:
            batch = fetch()
        except Exception as exc:  # noqa: BLE001 — a misbehaving source must not kill the poller
            log.warning("source %s failed: %s", name, exc)
            continue
        for sig in batch:
            if sig.key in seen:
                continue
            seen.add(sig.key)
            fresh.append(sig)
    return fresh


def run(
    *,
    interval: int = DEFAULT_INTERVAL_SECONDS,
    once: bool = False,
    sink: Callable[[RuggedSignal], None] | None = None,
    out: TextIO = sys.stdout,
) -> None:
    """Run the poll loop. Calls `sink` for each fresh signal, plus prints."""
    seen: set[str] = set()
    while True:
        ts = time.strftime("%H:%M:%S")
        fresh = poll_once(seen)
        if fresh:
            for sig in fresh:
                out.write(
                    f"[{ts}] {sig.source} · {sig.symbol:<12} {sig.address[:10]}… "
                    f"score={sig.risk_score:.0f} chain={sig.chain}\n"
                )
                out.flush()
                if sink:
                    sink(sig)
        else:
            out.write(f"[{ts}] (no new signals — {len(seen)} seen so far)\n")
            out.flush()
        if once:
            return
        time.sleep(interval)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rugged rug-signal watcher")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL_SECONDS,
                        help=f"poll interval seconds (default {DEFAULT_INTERVAL_SECONDS})")
    parser.add_argument("--once", action="store_true",
                        help="poll one cycle and exit (useful for testing)")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    log.info("starting watcher · sources=%s · interval=%ds", list(SOURCES), args.interval)
    try:
        run(interval=args.interval, once=args.once)
    except KeyboardInterrupt:
        log.info("stopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
