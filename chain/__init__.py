"""Rugged · on-chain client layer.

Wraps web3.py calls to the deployed Arc-testnet contracts:
- MarketFactory.createMarket()  (chain.factory)
- TraceRegistry.registerTrace() (chain.trace_registry, added in task #3)

Loads .env at import so callers don't have to.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env", override=True)
