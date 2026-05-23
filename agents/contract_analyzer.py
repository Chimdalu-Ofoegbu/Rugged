"""Rugged · swarm — Agent A: The Code Inspector.

Pulls structured contract-risk data from GoPlus's Solana endpoint, then
asks Claude to weigh those signals into a single rug-likelihood score.

Falls back gracefully to RugCheck's per-token report if GoPlus has no
data for the mint (common for very new launches).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from agents._goplus import GoPlusError, solana_token_security
from agents._shared import AgentVerdict, reason_with_claude
from watcher.models import RuggedSignal

log = logging.getLogger("agents.contract")

AGENT_NAME = "contract_analyzer"

SYSTEM_PROMPT = """\
You are Agent A in a three-agent rug-detection swarm. Your role is the \
**contract code inspector**. You analyze on-chain token contract metadata \
to assess whether a Solana token shows the structural fingerprints of a \
rugpull.

Focus on these contract-level signals (in rough order of importance):
1. **Mint authority** — if not renounced, the dev can mint unlimited \
   supply (HIGH risk).
2. **Freeze authority** — if not renounced, the dev can freeze user \
   wallets (HIGH risk).
3. **LP locked / burned** — unlocked LP means the dev can pull \
   liquidity (HIGH risk).
4. **Ownership renounced** — concentrated ownership = pull risk.
5. **Honeypot heuristics** — transfer tax, blacklist functions, \
   pausable transfers.
6. **Top-holder concentration** — >50% in one wallet is a red flag.

You are given the raw GoPlus security report (and optionally a RugCheck \
fallback report). The keys are unhealthy/missing/null when GoPlus didn't \
fetch that signal — do not over-weight missing data.\
"""


async def _rugcheck_fallback(mint: str) -> dict[str, Any]:
    """RugCheck's detailed per-token report. Public, no auth."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"https://api.rugcheck.xyz/v1/tokens/{mint}/report")
            r.raise_for_status()
            return r.json()
    except Exception as exc:  # noqa: BLE001 — best-effort fallback
        log.warning("rugcheck fallback failed for %s: %s", mint, exc)
        return {}


def _summarize_evidence(goplus: dict[str, Any], rugcheck: dict[str, Any]) -> str:
    """Compact the raw API blobs into a Claude-readable summary."""
    parts = []
    if goplus:
        parts.append("## GoPlus Solana security report\n```json\n" + json.dumps(goplus, indent=2)[:3000] + "\n```")
    else:
        parts.append("## GoPlus\n(no data returned)")
    if rugcheck:
        # RugCheck reports are big — extract the high-signal fields.
        compact = {
            "score": rugcheck.get("score"),
            "risks": rugcheck.get("risks", [])[:8],
            "token": (rugcheck.get("token") or {}).get("mintAuthority"),
            "freezeAuthority": (rugcheck.get("token") or {}).get("freezeAuthority"),
            "topHolders": [
                {"pct": h.get("pct"), "owner": h.get("owner")}
                for h in (rugcheck.get("topHolders") or [])[:5]
            ],
            "markets": [
                {"liquidity": (m.get("lp") or {}).get("lpLockedUSD"),
                 "locked_pct": (m.get("lp") or {}).get("lpLockedPct")}
                for m in (rugcheck.get("markets") or [])[:3]
            ],
        }
        parts.append("## RugCheck supplementary report\n```json\n" + json.dumps(compact, indent=2) + "\n```")
    return "\n\n".join(parts)


async def analyze(signal: RuggedSignal) -> AgentVerdict:
    """Score `signal` on contract-level rug risk. Returns AgentVerdict."""
    mint = signal.address

    # Fetch both data sources concurrently; GoPlus is primary.
    goplus_data: dict[str, Any] = {}
    rugcheck_data: dict[str, Any] = {}
    try:
        goplus_task = solana_token_security(mint)
        rugcheck_task = _rugcheck_fallback(mint)
        goplus_data, rugcheck_data = await asyncio.gather(
            goplus_task, rugcheck_task, return_exceptions=False
        )
    except GoPlusError as exc:
        log.warning("goplus failed for %s, relying on rugcheck: %s", mint, exc)
        rugcheck_data = await _rugcheck_fallback(mint)

    evidence = {"goplus": goplus_data, "rugcheck": rugcheck_data}

    if not goplus_data and not rugcheck_data:
        return AgentVerdict(
            agent=AGENT_NAME,
            score=0.0,
            confidence=0.0,
            key_signals=[],
            reasoning="no contract data available from either source",
            evidence=evidence,
            error="no_data",
        )

    user_msg = (
        f"Token: {signal.symbol} ({signal.chain})\n"
        f"Mint: {mint}\n"
        f"Source-native risk score: {signal.risk_score}\n\n"
        f"{_summarize_evidence(goplus_data, rugcheck_data)}\n\n"
        f"Score this token's rugpull likelihood based purely on the contract-level evidence above."
    )
    return await reason_with_claude(
        agent_name=AGENT_NAME,
        system_prompt=SYSTEM_PROMPT,
        user_message=user_msg,
        evidence=evidence,
    )


# ----------------------------------------------------------------------
#  CLI smoke test:  uv run python -m agents.contract_analyzer <mint>
# ----------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    from datetime import datetime, timezone

    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    mint = sys.argv[1] if len(sys.argv) > 1 else "So11111111111111111111111111111111111111112"
    symbol = sys.argv[2] if len(sys.argv) > 2 else "WSOL"
    sig = RuggedSignal(
        source="cli",
        symbol=symbol,
        address=mint,
        chain="solana",
        flag_timestamp=datetime.now(timezone.utc),
        risk_score=None,
    )
    verdict = asyncio.run(analyze(sig))
    print(json.dumps(verdict.model_dump(), indent=2, default=str))
