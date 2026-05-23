"""Rugged · per-Market client.

Read-only view of a deployed Market contract. Used by the API to surface
pool sizes, expiry, odds, and settlement state.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from eth_utils import to_checksum_address

from chain.factory import _w3_client

ROOT = Path(__file__).resolve().parent.parent
ABI_PATH = ROOT / "chain" / "abis" / "Market.json"


_abi_cache: list[dict[str, Any]] | None = None


def _abi() -> list[dict[str, Any]]:
    global _abi_cache
    if _abi_cache is None:
        _abi_cache = json.loads(ABI_PATH.read_text())
    return _abi_cache


def read_market(market_address: str) -> dict[str, Any]:
    """Read the immutable + mutable state of a Market contract."""
    w3 = _w3_client()
    c = w3.eth.contract(address=to_checksum_address(market_address), abi=_abi())
    fns = c.functions
    yes_bps, no_bps = fns.getOdds().call()
    return {
        "address": market_address,
        "market_id": int(fns.marketId().call()),
        "coin_address": fns.coinAddress().call(),
        "blacklist_timestamp": int(fns.blacklistTimestamp().call()),
        "blacklist_price_micro_usd": int(fns.blacklistPrice().call()),
        "seed_probability_bps": int(fns.seedProbabilityBps().call()),
        "expiry": int(fns.expiry().call()),
        "yes_pool": int(fns.yesPool().call()),
        "no_pool": int(fns.noPool().call()),
        "yes_odds_bps": int(yes_bps),
        "no_odds_bps": int(no_bps),
        "resolved": bool(fns.resolved().call()),
        "yes_won": bool(fns.yesWon().call()),
        "winning_pool": int(fns.winningPool().call()),
        "distributable": int(fns.distributable().call()),
    }


def read_wallet_position(market_address: str, wallet_address: str) -> dict[str, Any]:
    """Per-wallet view of a market: stakes, claim status, claimable payout."""
    w3 = _w3_client()
    c = w3.eth.contract(address=to_checksum_address(market_address), abi=_abi())
    fns = c.functions
    wa = to_checksum_address(wallet_address)
    yes_stake = int(fns.yesStake(wa).call())
    no_stake = int(fns.noStake(wa).call())
    resolved = bool(fns.resolved().call())
    yes_won = bool(fns.yesWon().call())
    claimed = bool(fns.claimed(wa).call())

    winning_stake = yes_stake if yes_won else no_stake
    payout = 0
    if resolved and winning_stake > 0 and not claimed:
        win_pool = int(fns.winningPool().call())
        dist = int(fns.distributable().call())
        if win_pool > 0:
            winnings = (winning_stake * dist) // win_pool
            payout = winning_stake + winnings

    return {
        "yes_stake": yes_stake,
        "no_stake": no_stake,
        "has_position": yes_stake > 0 or no_stake > 0,
        "is_winner": resolved and winning_stake > 0,
        "claimed": claimed,
        "claimable_micro_usdc": payout,
        "can_claim": resolved and winning_stake > 0 and not claimed,
    }
