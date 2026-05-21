"""Rugged · watcher — token metadata + price fetcher.

Given a `RuggedSignal`, fetches:
- current spot price (Pyth if a feed exists for the symbol, else CoinGecko),
- token decimals, LP info, primary pair address,
- the FLAG-time price — the baseline `Resolution.sol` compares against.

STUB — implemented in Phase 2/3 (see project.md §"Phase 2: Rug-Signal Watcher").
"""

from __future__ import annotations

from watcher.models import RuggedSignal


def enrich(signal: RuggedSignal) -> dict:
    """Return a metadata dict for a signal. STUB."""
    raise NotImplementedError("metadata_fetcher.enrich — implemented after the Phase 2 checkpoint")
