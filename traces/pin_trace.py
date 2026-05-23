"""Rugged · reasoning-trace pinning.

For every market the swarm opens, we persist the canonical JSON trace
locally (content-addressable by SHA-256) and return a retrieval URI. The
SHA-256 hash is registered on-chain via TraceRegistry, giving anyone
the ability to:

  1. Read the on-chain (market_id → hash, uri) record.
  2. Fetch the JSON from the URI.
  3. Re-compute SHA-256 and verify it matches the on-chain hash.

The current implementation stores locally under ``data/traces/<hash>.json``
and exposes it via ``/traces/<hash>`` on the FastAPI service. A production
deployment would swap ``pin()`` to use Irys (ANS-104 bundle) or IPFS;
the on-chain interface and verification semantics stay the same.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("traces.pin")

ROOT = Path(__file__).resolve().parent.parent
TRACE_DIR = ROOT / "data" / "traces"

# Public base URL the frontend / chain can use to retrieve a trace.
# Override via TRACE_BASE_URL when deploying behind a public domain.
DEFAULT_BASE_URL = "http://localhost:8000/traces"


def _canonical_bytes(trace: dict[str, Any]) -> bytes:
    """Canonical JSON serialization (sorted keys, no whitespace) for hashing."""
    return json.dumps(trace, sort_keys=True, separators=(",", ":"), default=str).encode()


def sha256_hex(trace: dict[str, Any]) -> str:
    """SHA-256 hex digest of the canonical JSON. Matches consensus._hash_trace."""
    return hashlib.sha256(_canonical_bytes(trace)).hexdigest()


def pin(trace: dict[str, Any]) -> dict[str, Any]:
    """Pin a trace to content-addressable storage.

    Returns a dict with::

        {"hash": "<hex>", "uri": "<retrievable url>", "bytes": <int>}

    Idempotent — if the same trace was pinned before, returns the existing
    record (same hash, same URI).
    """
    payload = _canonical_bytes(trace)
    digest = hashlib.sha256(payload).hexdigest()

    TRACE_DIR.mkdir(parents=True, exist_ok=True)
    target = TRACE_DIR / f"{digest}.json"
    if not target.exists():
        target.write_bytes(payload)
        log.info("pinned trace %s (%d bytes)", digest[:10], len(payload))
    else:
        log.info("trace %s already pinned, reusing", digest[:10])

    base = os.environ.get("TRACE_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
    return {
        "hash": digest,
        "uri": f"{base}/{digest}",
        "bytes": len(payload),
    }


def load(digest: str) -> dict[str, Any] | None:
    """Load a previously-pinned trace by hash. None if not found."""
    target = TRACE_DIR / f"{digest}.json"
    if not target.exists():
        return None
    return json.loads(target.read_text())


def verify(trace: dict[str, Any], expected_hash: str) -> bool:
    """Confirm a trace dict hashes to the expected on-chain value."""
    return sha256_hex(trace) == expected_hash


# ----------------------------------------------------------------------
#  CLI: uv run python -m traces.pin_trace verify <hash>
# ----------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    if len(sys.argv) >= 3 and sys.argv[1] == "verify":
        digest = sys.argv[2]
        loaded = load(digest)
        if not loaded:
            print(f"trace {digest} not found locally")
            sys.exit(1)
        ok = verify(loaded, digest)
        print(f"verify {digest}: {'OK' if ok else 'MISMATCH'}")
        sys.exit(0 if ok else 1)
    print("usage: python -m traces.pin_trace verify <hash>")
