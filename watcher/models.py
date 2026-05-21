"""Rugged · normalized data model for rug-detection events.

Every source adapter (rugcheck, goplus, …) emits the same `RuggedSignal`
shape, so the rest of the pipeline (swarm → market factory → resolution)
is source-agnostic.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class RuggedSignal(BaseModel):
    """A normalized rug-detection event."""

    source: str  # e.g. "rugcheck", "goplus"
    symbol: str
    address: str
    chain: str  # e.g. "solana", "ethereum", "base"
    flag_timestamp: datetime
    risk_score: float | None = None  # source-native raw score
    reasons: list[str] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)

    @property
    def key(self) -> str:
        """Dedup key — (chain, address)."""
        return f"{self.chain}:{self.address}"
