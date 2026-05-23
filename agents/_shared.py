"""Rugged · swarm — shared types and Claude helper.

Every analyzer (Agent A/B/C) returns the same `AgentVerdict` shape. The
shared `reason_with_claude()` helper handles the LLM call with prompt
caching, JSON extraction, and one retry.

Design notes:
- All three agents reuse the same model + same JSON schema instructions,
  so the system prompt is `cache_control: ephemeral` — first call warms
  the cache, the next two land cheap.
- Model is `claude-sonnet-4-5` by default; override via `CLAUDE_MODEL`
  env var if you want to switch to Opus for the demo.
- Agents call this concurrently from `consensus.verify_signal()`.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from anthropic import APIError, AsyncAnthropic
from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger("agents.shared")

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
MAX_OUTPUT_TOKENS = 1024


# ----------------------------------------------------------------------
#  Verdict schema — every agent returns this shape.
# ----------------------------------------------------------------------
class AgentVerdict(BaseModel):
    """One agent's rug-likelihood verdict on a signal."""

    agent: str  # "contract_analyzer" | "social_signal_analyzer" | "onchain_flow_analyzer"
    score: float = Field(ge=0.0, le=1.0)  # rug likelihood
    confidence: float = Field(ge=0.0, le=1.0)  # how confident the agent is in its own score
    key_signals: list[str] = Field(default_factory=list)  # short bullet-point reasons
    reasoning: str = ""  # 1-3 sentence prose summary
    evidence: dict[str, Any] = Field(default_factory=dict)  # raw upstream API data (for trace)
    error: str | None = None  # populated if the agent failed gracefully


# ----------------------------------------------------------------------
#  Claude client — singleton, async.
# ----------------------------------------------------------------------
_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            raise RuntimeError("ANTHROPIC_API_KEY not set in env")
        _client = AsyncAnthropic(api_key=key)
    return _client


# ----------------------------------------------------------------------
#  Universal JSON-extraction prompt scaffold.
# ----------------------------------------------------------------------
OUTPUT_SCHEMA_INSTRUCTIONS = """\
Respond ONLY with a single JSON object — no prose, no markdown fence — \
matching this schema exactly:

{
  "score": <float between 0 and 1, where 1 = certain rugpull>,
  "confidence": <float between 0 and 1, how sure you are in your score>,
  "key_signals": [<3-6 short bullet strings, each a specific observation>],
  "reasoning": "<2-3 sentence prose summary tying the signals to the score>"
}

Be calibrated: 0.5 means genuinely uncertain, not a default. If the \
evidence is thin, return a low confidence regardless of score.\
"""


# ----------------------------------------------------------------------
#  Core call — used by all three agents.
# ----------------------------------------------------------------------
async def reason_with_claude(
    *,
    agent_name: str,
    system_prompt: str,
    user_message: str,
    evidence: dict[str, Any],
    model: str = DEFAULT_MODEL,
) -> AgentVerdict:
    """Ask Claude to score a signal. Returns AgentVerdict.

    On any failure (API error, malformed JSON, schema mismatch) returns a
    degraded verdict with `error` populated and score=0.0, confidence=0.0
    so consensus naturally ignores it.
    """
    client = _get_client()
    full_system = system_prompt + "\n\n" + OUTPUT_SCHEMA_INSTRUCTIONS

    for attempt in range(2):  # one retry on transient errors / bad JSON
        try:
            resp = await client.messages.create(
                model=model,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=[
                    {
                        "type": "text",
                        "text": full_system,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": user_message}],
            )
            text = "".join(b.text for b in resp.content if b.type == "text").strip()
            data = _extract_json(text)
            return AgentVerdict(
                agent=agent_name,
                score=float(data["score"]),
                confidence=float(data["confidence"]),
                key_signals=list(data.get("key_signals", []))[:6],
                reasoning=str(data.get("reasoning", ""))[:600],
                evidence=evidence,
            )
        except (APIError, KeyError, ValueError, ValidationError) as exc:
            log.warning("%s attempt %d failed: %s", agent_name, attempt + 1, exc)
            if attempt == 1:
                return AgentVerdict(
                    agent=agent_name,
                    score=0.0,
                    confidence=0.0,
                    key_signals=[],
                    reasoning=f"agent failed: {exc}",
                    evidence=evidence,
                    error=str(exc),
                )
    # unreachable
    raise RuntimeError("unreachable")


# ----------------------------------------------------------------------
#  Tolerant JSON extraction — Claude sometimes wraps in ```json fences.
# ----------------------------------------------------------------------
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_json(text: str) -> dict[str, Any]:
    """Extract the first JSON object from a Claude response."""
    # Try fenced first
    m = _JSON_FENCE_RE.search(text)
    if m:
        return json.loads(m.group(1))
    # Try raw — first { to last }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start : end + 1])
    raise ValueError(f"no JSON object found in response: {text[:200]!r}")
