"""Rugged · swarm — Agent C: The Money Tracker.

Pulls liquidity-pool and holder-concentration data from RugCheck's
detailed report endpoint, then asks Claude to assess capital-flow
patterns consistent with a rugpull.

Differs from Agent A (which reads contract-level *structure*) by
focusing on *behavior over time*: LP reserve changes, top-holder shifts,
recent transfer volume.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from agents._shared import AgentVerdict, reason_with_claude
from watcher.models import RuggedSignal

log = logging.getLogger("agents.onchain")

AGENT_NAME = "onchain_flow_analyzer"
RUGCHECK_BASE = "https://api.rugcheck.xyz/v1"

SYSTEM_PROMPT = """\
You are Agent C in a three-agent rug-detection swarm. Your role is the \
**onchain flow analyzer**. You read liquidity-pool and holder data to \
assess whether capital movements suggest an imminent or in-progress rug.

Focus on these flow signals (in rough order of importance):
1. **LP locked %** — if liquidity isn't locked, the dev can pull at any time.
2. **LP USD value** — thin liquidity (<$5K) means a tiny sell pressure \
   rugs the price.
3. **Top-10 holder concentration** — >50% combined held by non-LP \
   wallets is high pull risk.
4. **Insider/sniper holdings** — RugCheck tags wallets that bought in \
   the first block; concentration here is a precursor to dumps.
5. **Active market count** — only one DEX market means no redundancy if \
   that pool is rugged.

You are given a compact summary of RugCheck's `/tokens/{mint}/report` \
output. Score conservatively — Agent A already covers contract risk; \
your job is the *capital-flow* lens specifically.\
"""


async def _fetch_rugcheck_report(mint: str) -> dict[str, Any]:
    """Detailed RugCheck per-token report. Public, no auth."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{RUGCHECK_BASE}/tokens/{mint}/report")
        r.raise_for_status()
        return r.json()


def _extract_flow_signals(report: dict[str, Any]) -> dict[str, Any]:
    """Pull only the flow-relevant fields from a RugCheck report."""
    markets = report.get("markets") or []
    top_holders = report.get("topHolders") or []
    insider_networks = report.get("insiderNetworks") or []
    return {
        "totalMarketLiquidity_USD": report.get("totalMarketLiquidity"),
        "totalLPProviders": report.get("totalLPProviders"),
        "market_count": len(markets),
        "markets": [
            {
                "type": m.get("marketType"),
                "liquidity_usd": (m.get("lp") or {}).get("lpLockedUSD"),
                "locked_pct": (m.get("lp") or {}).get("lpLockedPct"),
                "total_tokens_provided": (m.get("lp") or {}).get("lpTotalSupply"),
            }
            for m in markets[:3]
        ],
        "top_holders": [
            {
                "address": h.get("address"),
                "pct": h.get("pct"),
                "is_insider": h.get("insider"),
                "owner": h.get("owner"),
            }
            for h in top_holders[:10]
        ],
        "insider_networks_count": len(insider_networks),
        "insider_networks": [
            {"size": n.get("size"), "type": n.get("type"), "active_pct": n.get("activeAccounts")}
            for n in insider_networks[:5]
        ],
        "risks_flagged": [r.get("name") for r in (report.get("risks") or [])][:10],
        "rugcheck_score": report.get("score"),
    }


async def analyze(signal: RuggedSignal) -> AgentVerdict:
    """Score `signal` on capital-flow patterns. Returns AgentVerdict."""
    try:
        report = await _fetch_rugcheck_report(signal.address)
    except Exception as exc:  # noqa: BLE001 — graceful
        log.warning("rugcheck report failed for %s: %s", signal.address, exc)
        return AgentVerdict(
            agent=AGENT_NAME,
            score=0.0,
            confidence=0.0,
            key_signals=[],
            reasoning=f"RugCheck report fetch failed: {exc}",
            evidence={},
            error=str(exc),
        )

    flow = _extract_flow_signals(report)
    evidence = {"flow_signals": flow}

    user_msg = (
        f"Token: {signal.symbol} ({signal.chain})\n"
        f"Mint: {signal.address}\n"
        f"Source-native risk score: {signal.risk_score}\n\n"
        f"## RugCheck flow signals\n```json\n{json.dumps(flow, indent=2)}\n```\n\n"
        f"Score this token's rugpull likelihood based on capital-flow signals."
    )
    return await reason_with_claude(
        agent_name=AGENT_NAME,
        system_prompt=SYSTEM_PROMPT,
        user_message=user_msg,
        evidence=evidence,
    )


# ----------------------------------------------------------------------
#  CLI smoke test:  uv run python -m agents.onchain_flow_analyzer <mint>
# ----------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    from datetime import datetime, timezone

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
    verdict = asyncio.run(analyze(sig))
    print(json.dumps(verdict.model_dump(), indent=2, default=str))
