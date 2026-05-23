"""Rugged · resolver daemon.

Tracks the 24-hour low price for every open market on Arc and auto-calls
Resolution.resolve(market, observedLow) once the market expires.

Two pieces:
    - tracker.py — pure functions for price-low bookkeeping (file-backed)
    - daemon.py  — the async tick that runs alongside the orchestrator
"""
