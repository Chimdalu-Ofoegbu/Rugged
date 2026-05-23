"""Rugged · resolver — per-market 24h price-low tracker.

State is stored in `data/price_tracking/<market_id>.json` so a restart
doesn't lose the running minimum. The tracker is content-addressable
by market_id; the orchestrator's resolve daemon owns the I/O timing.

Schema:
    {
      "market_id": 0,
      "mint": "CuAg...",
      "blacklist_price_micro_usd": 4,
      "blacklist_timestamp": 1779331586,
      "expiry": 1779417986,
      "observations": [
        {"ts": 1779331610, "price_micro_usd": 4, "source": "rugcheck"},
        ...
      ],
      "low_price_micro_usd": 2,
      "low_observed_at": 1779348012,
      "last_polled_at": 1779417000
    }
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("resolver.tracker")

ROOT = Path(__file__).resolve().parent.parent
TRACK_DIR = ROOT / "data" / "price_tracking"

# Cap the observation list so a long-running daemon doesn't bloat the file.
MAX_OBSERVATIONS = 600  # ~24h at one observation every ~2.5 min


def _path_for(market_id: int) -> Path:
    return TRACK_DIR / f"{market_id}.json"


def load(market_id: int) -> dict[str, Any] | None:
    p = _path_for(market_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        log.warning("price tracking file %s is corrupt; resetting", p)
        return None


def init(*, market_id: int, mint: str, blacklist_price_micro_usd: int,
         blacklist_timestamp: int, expiry: int) -> dict[str, Any]:
    """Create the initial record for a newly-opened market.

    Idempotent: if a record already exists, return it untouched. The
    blacklist baseline is immutable from the contract, so re-init never
    overrides it.
    """
    existing = load(market_id)
    if existing:
        return existing
    record = {
        "market_id": market_id,
        "mint": mint,
        "blacklist_price_micro_usd": int(blacklist_price_micro_usd),
        "blacklist_timestamp": int(blacklist_timestamp),
        "expiry": int(expiry),
        "observations": [],
        "low_price_micro_usd": int(blacklist_price_micro_usd),
        "low_observed_at": int(blacklist_timestamp),
        "last_polled_at": 0,
    }
    _save(market_id, record)
    return record


def record_observation(market_id: int, *, price_micro_usd: int, source: str = "unknown",
                       ts: int | None = None) -> dict[str, Any] | None:
    """Append a price observation and tighten the running minimum.

    Returns the updated record, or None if no record exists for that
    market (caller forgot to init).
    """
    rec = load(market_id)
    if not rec:
        log.warning("record_observation called for unknown market %d", market_id)
        return None
    if price_micro_usd <= 0:
        return rec  # ignore garbage prices, keep the running low
    now = int(ts if ts is not None else time.time())
    rec["observations"].append({
        "ts": now, "price_micro_usd": int(price_micro_usd), "source": source,
    })
    # Cap the obs list — keep the oldest (for audit) and the most recent N-1.
    if len(rec["observations"]) > MAX_OBSERVATIONS:
        rec["observations"] = [rec["observations"][0]] + rec["observations"][-(MAX_OBSERVATIONS - 1):]
    if price_micro_usd < rec["low_price_micro_usd"]:
        rec["low_price_micro_usd"] = int(price_micro_usd)
        rec["low_observed_at"] = now
    rec["last_polled_at"] = now
    _save(market_id, rec)
    return rec


def mark_polled(market_id: int) -> None:
    """Record a poll attempt even when no price was retrieved."""
    rec = load(market_id)
    if not rec:
        return
    rec["last_polled_at"] = int(time.time())
    _save(market_id, rec)


def _save(market_id: int, record: dict[str, Any]) -> None:
    TRACK_DIR.mkdir(parents=True, exist_ok=True)
    _path_for(market_id).write_text(json.dumps(record, indent=2))
