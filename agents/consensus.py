"""Rugged · swarm — consensus orchestrator.

Runs the three agents in parallel against a single RuggedSignal and
returns a `ConsensusResult` containing:
- fire: bool — True iff ≥ 2 of 3 agents scored > THRESHOLD
- seed_probability_bps: int — confidence-weighted mean score in basis points
- trace: dict — full reasoning trace (pinned to Irys + hashed on Arc)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

from agents import contract_analyzer, onchain_flow_analyzer, social_signal_analyzer
from agents._shared import AgentVerdict
from watcher.models import RuggedSignal

log = logging.getLogger("agents.consensus")

CONSENSUS_THRESHOLD = 0.5  # an agent "fires" if score > this
MIN_FIRING_AGENTS = 2  # need this many firing agents to open a market

TRACE_SCHEMA_VERSION = "1.0"


class ConsensusResult(BaseModel):
    """Output of the full swarm pass on one signal."""

    fire: bool
    seed_probability_bps: int = Field(ge=0, le=10_000)
    verdicts: list[AgentVerdict]
    trace: dict[str, Any]  # canonical JSON for pinning + hashing
    trace_hash: str  # sha256 hex digest of canonical trace


def _confidence_weighted_mean(verdicts: list[AgentVerdict]) -> float:
    """Mean score weighted by each agent's self-reported confidence.

    Agents that errored (confidence=0) drop out of the mean. If every
    agent errored, returns 0.
    """
    weighted_sum = 0.0
    weight_sum = 0.0
    for v in verdicts:
        if v.confidence <= 0:
            continue
        weighted_sum += v.score * v.confidence
        weight_sum += v.confidence
    if weight_sum == 0:
        return 0.0
    return weighted_sum / weight_sum


def _count_firing(verdicts: list[AgentVerdict]) -> int:
    """How many agents scored above the firing threshold."""
    return sum(1 for v in verdicts if v.score > CONSENSUS_THRESHOLD and v.confidence > 0)


def _canonical_trace(signal: RuggedSignal, verdicts: list[AgentVerdict], probability_bps: int, fire: bool) -> dict[str, Any]:
    """Build the reasoning-trace dict that gets pinned to Irys & hashed on Arc.

    Canonical = stable key order, no timestamps that change between identical inputs.
    """
    return {
        "schema_version": TRACE_SCHEMA_VERSION,
        "signal": {
            "source": signal.source,
            "symbol": signal.symbol,
            "address": signal.address,
            "chain": signal.chain,
            "flag_timestamp": signal.flag_timestamp.isoformat(),
            "risk_score": signal.risk_score,
            "reasons": signal.reasons,
        },
        "swarm": {
            "threshold": CONSENSUS_THRESHOLD,
            "min_firing_agents": MIN_FIRING_AGENTS,
            "firing_count": _count_firing(verdicts),
            "fire": fire,
            "seed_probability_bps": probability_bps,
        },
        "verdicts": [v.model_dump() for v in verdicts],
        "trace_built_at": datetime.now(timezone.utc).isoformat(),
    }


def _hash_trace(trace: dict[str, Any]) -> str:
    """SHA-256 of the canonical JSON serialization."""
    blob = json.dumps(trace, sort_keys=True, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(blob).hexdigest()


async def verify_signal(signal: RuggedSignal) -> ConsensusResult:
    """Run the full 3-agent swarm against a signal. Returns a ConsensusResult.

    All three agents run concurrently. Individual agent failures degrade
    gracefully — their verdicts come back with confidence=0 and don't
    pollute the weighted mean.
    """
    t0 = time.monotonic()
    log.info("swarm starting on %s (%s)", signal.symbol, signal.address[:10])

    verdicts: list[AgentVerdict] = await asyncio.gather(
        contract_analyzer.analyze(signal),
        social_signal_analyzer.analyze(signal),
        onchain_flow_analyzer.analyze(signal),
        return_exceptions=False,
    )

    elapsed = time.monotonic() - t0
    log.info(
        "swarm done on %s in %.1fs · scores=[%s]",
        signal.symbol,
        elapsed,
        ", ".join(f"{v.agent[:8]}={v.score:.2f}@{v.confidence:.2f}" for v in verdicts),
    )

    firing = _count_firing(verdicts)
    fire = firing >= MIN_FIRING_AGENTS
    probability = _confidence_weighted_mean(verdicts)
    probability_bps = int(round(probability * 10_000))

    trace = _canonical_trace(signal, verdicts, probability_bps, fire)
    trace_hash = _hash_trace(trace)

    return ConsensusResult(
        fire=fire,
        seed_probability_bps=probability_bps,
        verdicts=verdicts,
        trace=trace,
        trace_hash=trace_hash,
    )


# ----------------------------------------------------------------------
#  CLI smoke test:  uv run python -m agents.consensus <mint> [symbol]
# ----------------------------------------------------------------------
if __name__ == "__main__":
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    mint = sys.argv[1] if len(sys.argv) > 1 else "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    symbol = sys.argv[2] if len(sys.argv) > 2 else "BONK"
    sig = RuggedSignal(
        source="cli",
        symbol=symbol,
        address=mint,
        chain="solana",
        flag_timestamp=datetime.now(timezone.utc),
        risk_score=None,
    )
    result = asyncio.run(verify_signal(sig))
    print(json.dumps(result.model_dump(), indent=2, default=str))
