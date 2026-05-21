"""Rugged · watcher source — RugCheck.xyz (PRIMARY).

Drives both market creation and the slash bond's hit-rate window.

Polls RugCheck's public `/v1/stats/recent` endpoint. Each entry includes a
`score` field — verified empirically as **higher = riskier** (range observed:
1 ≈ no risks, ≥ 100 = flagged, 501 = the maximum-risk band in RugCheck's UI).

We emit a `RuggedSignal` for every recent token with score ≥ threshold.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx

from watcher.models import RuggedSignal

log = logging.getLogger(__name__)

RUGCHECK_BASE = "https://api.rugcheck.xyz/v1"
SOURCE_NAME = "rugcheck"

# RugCheck convention: higher = riskier. Their UI flags tokens ≥ 100 as risky.
DEFAULT_RISK_THRESHOLD = 100.0
DEFAULT_TIMEOUT = 10.0


def fetch_signals(
    *,
    risk_threshold: float = DEFAULT_RISK_THRESHOLD,
    timeout: float = DEFAULT_TIMEOUT,
    client: httpx.Client | None = None,
) -> list[RuggedSignal]:
    """Fetch the current high-risk Solana tokens from RugCheck.

    Returns one `RuggedSignal` per token with score ≥ `risk_threshold`.
    """
    url = f"{RUGCHECK_BASE}/stats/recent"
    owns_client = client is None
    if owns_client:
        client = httpx.Client(timeout=timeout, headers={"Accept": "application/json"})
    try:
        resp = client.get(url)
        resp.raise_for_status()
        items = resp.json()
    finally:
        if owns_client:
            client.close()

    now = datetime.now(timezone.utc)
    signals: list[RuggedSignal] = []
    for item in items:
        score = item.get("score")
        if score is None or score < risk_threshold:
            continue
        meta = item.get("metadata") or {}
        symbol = (meta.get("symbol") or "").strip()
        mint = item.get("mint") or ""
        if not symbol or not mint:
            continue
        signals.append(
            RuggedSignal(
                source=SOURCE_NAME,
                symbol=symbol,
                address=mint,
                chain="solana",
                flag_timestamp=now,
                risk_score=float(score),
                reasons=[],  # see /tokens/{mint}/report for per-risk breakdown
                raw=item,
            )
        )
    log.info("rugcheck: %d signals at threshold %.0f", len(signals), risk_threshold)
    return signals
