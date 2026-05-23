"""Rugged · swarm — three-agent rug verification pipeline.

Loads `.env` at package import (with override=True) so agents see the
project's secrets even if the calling shell has stale empty vars set.

Public surface:
    from agents.consensus import verify_signal, ConsensusResult
    from agents._shared import AgentVerdict
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

# Project root is the parent of this `agents/` package.
_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_ROOT / ".env", override=True)
