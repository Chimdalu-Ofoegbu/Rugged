"""Rugged · Resolution client.

Wraps the on-chain `Resolution` contract. Two callers:

    - The orchestrator's resolver daemon: at expiry, calls
      Resolution.resolve(market, observedLowMicroUsd) from the
      deployer key (which holds the `resolver` role by default).
    - The API: reads `outcomes[marketId]` to surface the observed
      low + resolution timestamp on the market detail page.

The deployer/resolver pays gas in ARC (not USDC paymaster). This is
intentional — resolution is an operator action, not a user action.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from eth_utils import to_checksum_address
from web3 import Web3

from chain.factory import _account, _w3_client

log = logging.getLogger("chain.resolution")

ROOT = Path(__file__).resolve().parent.parent
ABI_PATH = ROOT / "chain" / "abis" / "Resolution.json"

DEFAULT_GAS_LIMIT = 350_000

_resolution: Any = None


def _resolution_contract():
    global _resolution
    if _resolution is None:
        addr = os.environ.get("MARKET_RESOLUTION_ADDRESS")
        if not addr:
            raise RuntimeError("MARKET_RESOLUTION_ADDRESS not set")
        abi = json.loads(ABI_PATH.read_text())
        _resolution = _w3_client().eth.contract(address=to_checksum_address(addr), abi=abi)
    return _resolution


def resolver_address() -> str:
    """Read the current trusted resolver address."""
    return _resolution_contract().functions.resolver().call()


def get_outcome(market_id: int) -> dict[str, Any] | None:
    """Read the on-chain outcome record. Returns None if not yet resolved."""
    c = _resolution_contract()
    low, baseline, yes_won, resolved_at = c.functions.outcomes(market_id).call()
    if int(resolved_at) == 0:
        return None
    return {
        "observed_low_price_micro_usd": int(low),
        "blacklist_price_micro_usd": int(baseline),
        "yes_won": bool(yes_won),
        "resolved_at": int(resolved_at),
    }


def resolve(*, market_address: str, observed_low_micro_usd: int) -> dict[str, Any]:
    """Submit `Resolution.resolve(market, observedLow)` from the resolver key.

    Returns {tx_hash, block_number}. Caller is responsible for verifying
    expiry first — the contract will revert with NotYetExpired otherwise.
    """
    if observed_low_micro_usd < 0:
        # Resolution.sol does `observedLowPrice * 2 < blacklistPrice` — a 0
        # observation reliably resolves YES, which is the right behavior
        # for an unfindable price (token effectively dead) AND for demo
        # markets explicitly forced to YES via /api/admin/force-resolve.
        # Only negatives are rejected at the API boundary.
        raise ValueError("observed_low_micro_usd must be >= 0")

    w3 = _w3_client()
    acct = _account()
    c = _resolution_contract()
    fn = c.functions.resolve(to_checksum_address(market_address), int(observed_low_micro_usd))

    nonce = w3.eth.get_transaction_count(acct.address)
    try:
        gas = int(fn.estimate_gas({"from": acct.address}) * 1.2)
    except Exception as exc:  # noqa: BLE001
        log.warning("resolve estimate_gas failed: %s — using %d", exc, DEFAULT_GAS_LIMIT)
        gas = DEFAULT_GAS_LIMIT

    tx = fn.build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "gas": gas,
        "gasPrice": w3.eth.gas_price,
        "chainId": int(os.environ.get("ARC_CHAIN_ID", "5042002")),
    })
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    if receipt.status != 1:
        raise RuntimeError(f"Resolution.resolve reverted: tx={tx_hash}")
    log.info(
        "Resolution.resolve OK · market=%s low=%d tx=%s block=%d",
        market_address, observed_low_micro_usd, tx_hash, receipt.blockNumber,
    )
    return {"tx_hash": tx_hash, "block_number": receipt.blockNumber}
