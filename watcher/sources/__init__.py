"""Rugged · watcher source adapters.

Each source module exposes `fetch_signals()` -> list[RuggedSignal].
The poller orchestrates and dedupes across them.
"""
