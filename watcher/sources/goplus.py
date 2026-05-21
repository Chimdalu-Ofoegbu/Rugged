"""Rugged · watcher source — GoPlus Security (OPTIONAL EVM aux).

Markets opened from this source do NOT impact the slash bond — only
RugCheck-sourced markets feed the bond's hit-rate window.

Status: stub — Phase 2 checkpoint is satisfied by RugCheck alone. GoPlus's
public API is query-by-address (you ask about a *specific* token), so it
works best as enrichment inside agents/metadata_fetcher rather than as a
discovery source. A future iteration can hook a "new ERC-20 contracts"
indexer here and call GoPlus per address to score them.
"""

from __future__ import annotations

from watcher.models import RuggedSignal


def fetch_signals() -> list[RuggedSignal]:
    """No-op for now — GoPlus is query-by-address, not a discovery feed."""
    return []
