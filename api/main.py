"""Rugged · backend API (FastAPI).

Phase 5. Serves the dashboard + bet/bond flows against the Arc testnet
contracts. Routes: /markets, /markets/{id}, /markets/{id}/bet,
/positions/{wallet}, /bond, /bond/stake, /bond/unstake, /leaderboard.

STUB — implemented in Phase 5 (project.md §"Phase 5: Backend API").
"""

from fastapi import FastAPI

app = FastAPI(title="Rugged API", version="0.1.0")


@app.get("/health")
def health() -> dict:
    """Liveness probe — replaced by the real routes in Phase 5."""
    return {"status": "ok", "phase": "0 — scaffold"}
