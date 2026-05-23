"""Rugged · swarm — Agent B: The Social Listener.

Pulls recent X (Twitter) posts mentioning the token symbol, then asks
Claude to assess coordinated-shilling / dev-silence / scam-warning
sentiment patterns.

X pay-per-use credits are precious — we cap each call at 30 tweets and
do a single search per signal.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import httpx

from agents._shared import AgentVerdict, reason_with_claude
from watcher.models import RuggedSignal

log = logging.getLogger("agents.social")

AGENT_NAME = "social_signal_analyzer"
X_BASE = "https://api.x.com/2"
MAX_TWEETS = 30

SYSTEM_PROMPT = """\
You are Agent B in a three-agent rug-detection swarm. Your role is the \
**social listener**. You read recent X (Twitter) posts about a Solana \
token and assess whether the social signature matches a rugpull setup.

Focus on these patterns (in rough order of importance):
1. **Coordinated shilling** — many similarly-worded posts from low-age \
   accounts within a short window.
2. **Dev silence** — no recent posts from the project's own account, \
   especially when users are asking questions.
3. **Scam warnings** — explicit "rugged", "rug pull", "honeypot", \
   "scam", "ape out" mentions.
4. **Velocity vs. substance** — high tweet count but no real product \
   discussion (only price, moon emojis, contract addresses).
5. **Bot-like accounts** — generic handles, no profile photo, posting \
   only crypto shills.

You are given a list of recent tweets. Each entry has the text, author \
display name, and creation timestamp. Treat low tweet counts as low \
confidence — don't fabricate signals from sparse data.\
"""


async def _fetch_tweets(query: str, max_results: int = MAX_TWEETS) -> list[dict[str, Any]]:
    """Search recent tweets via X v2. Returns parsed JSON `data` array."""
    token = os.environ.get("X_BEARER_TOKEN")
    if not token:
        raise RuntimeError("X_BEARER_TOKEN not set")
    params = {
        "query": query,
        "max_results": str(max(10, min(max_results, 100))),  # X enforces 10..100
        "tweet.fields": "created_at,author_id,public_metrics",
        "expansions": "author_id",
        "user.fields": "created_at,public_metrics,verified",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            f"{X_BASE}/tweets/search/recent",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )
        r.raise_for_status()
        body = r.json()
    tweets = body.get("data", []) or []
    users = {u["id"]: u for u in (body.get("includes", {}) or {}).get("users", [])}
    enriched = []
    for t in tweets:
        u = users.get(t.get("author_id"), {})
        enriched.append({
            "text": t.get("text", "")[:280],
            "created_at": t.get("created_at"),
            "metrics": t.get("public_metrics", {}),
            "author_name": u.get("name"),
            "author_username": u.get("username"),
            "author_created_at": u.get("created_at"),
            "author_followers": (u.get("public_metrics") or {}).get("followers_count"),
            "author_verified": u.get("verified"),
        })
    return enriched


def _build_query(signal: RuggedSignal) -> str:
    """X search query. Includes the symbol with $ prefix and the mint address."""
    parts = []
    if signal.symbol:
        parts.append(f"${signal.symbol}")
    if signal.address:
        # Truncate mint — X search has a query length cap
        parts.append(signal.address[:20])
    base = " OR ".join(parts) if parts else signal.symbol or signal.address
    # Exclude retweets to maximize signal/credit ratio.
    return f"({base}) -is:retweet lang:en"


async def analyze(signal: RuggedSignal) -> AgentVerdict:
    """Score `signal` on social sentiment. Returns AgentVerdict."""
    query = _build_query(signal)
    try:
        tweets = await _fetch_tweets(query)
    except Exception as exc:  # noqa: BLE001 — gracefully degrade
        log.warning("x search failed for %s: %s", signal.symbol, exc)
        return AgentVerdict(
            agent=AGENT_NAME,
            score=0.0,
            confidence=0.0,
            key_signals=[],
            reasoning=f"X search failed: {exc}",
            evidence={"query": query},
            error=str(exc),
        )

    evidence = {"query": query, "tweet_count": len(tweets), "tweets": tweets}

    if not tweets:
        return AgentVerdict(
            agent=AGENT_NAME,
            score=0.0,
            confidence=0.1,  # low conf — no data is itself mildly suspicious for a "flagged" token
            key_signals=["no X posts found in last 7 days"],
            reasoning="No tweets matched the query. Either too obscure to assess or social activity is suppressed.",
            evidence=evidence,
        )

    # Compact the tweet list — keep the most engagement-heavy first.
    sorted_tweets = sorted(
        tweets,
        key=lambda t: (t.get("metrics") or {}).get("like_count", 0),
        reverse=True,
    )[:20]
    compact = [
        {
            "text": t["text"],
            "by": t.get("author_username"),
            "at": t.get("created_at"),
            "likes": (t.get("metrics") or {}).get("like_count"),
            "followers": t.get("author_followers"),
        }
        for t in sorted_tweets
    ]

    user_msg = (
        f"Token: {signal.symbol} ({signal.chain})\n"
        f"Mint: {signal.address}\n"
        f"Source-native risk score: {signal.risk_score}\n"
        f"X query used: {query}\n"
        f"Total tweets fetched: {len(tweets)}\n\n"
        f"Top 20 by engagement:\n```json\n{json.dumps(compact, indent=2)}\n```\n\n"
        f"Score this token's rugpull likelihood based purely on the social signature."
    )
    return await reason_with_claude(
        agent_name=AGENT_NAME,
        system_prompt=SYSTEM_PROMPT,
        user_message=user_msg,
        evidence=evidence,
    )


# ----------------------------------------------------------------------
#  CLI smoke test:  uv run python -m agents.social_signal_analyzer <symbol> [mint]
# ----------------------------------------------------------------------
if __name__ == "__main__":
    import sys
    from datetime import datetime, timezone

    from dotenv import load_dotenv

    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    symbol = sys.argv[1] if len(sys.argv) > 1 else "BONK"
    mint = sys.argv[2] if len(sys.argv) > 2 else "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
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
