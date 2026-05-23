"""Rugged · TraceRegistry client.

Calls TraceRegistry.registerTrace(marketId, traceHash, ipfsCid) on Arc.
Only the configured operator address can write — must match OPERATOR_ADDRESS
on the deployed contract (`.env`).
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

log = logging.getLogger("chain.trace_registry")

ROOT = Path(__file__).resolve().parent.parent
ABI_PATH = ROOT / "chain" / "abis" / "TraceRegistry.json"

DEFAULT_GAS_LIMIT = 200_000

_registry: Any = None


def _registry_contract():
    global _registry
    if _registry is None:
        addr = os.environ.get("TRACE_REGISTRY_ADDRESS")
        if not addr:
            raise RuntimeError("TRACE_REGISTRY_ADDRESS not set")
        abi = json.loads(ABI_PATH.read_text())
        _registry = _w3_client().eth.contract(address=to_checksum_address(addr), abi=abi)
    return _registry


def register_trace(*, market_id: int, trace_hash_hex: str, uri: str) -> dict[str, Any]:
    """Register a trace on-chain. Returns {tx_hash, block_number}."""
    if not trace_hash_hex.startswith("0x"):
        trace_hash_hex = "0x" + trace_hash_hex
    hash_bytes = Web3.to_bytes(hexstr=trace_hash_hex)
    if len(hash_bytes) != 32:
        raise ValueError(f"trace hash must be 32 bytes, got {len(hash_bytes)}")

    w3 = _w3_client()
    acct = _account()
    reg = _registry_contract()

    nonce = w3.eth.get_transaction_count(acct.address)
    fn = reg.functions.registerTrace(market_id, hash_bytes, uri)
    try:
        gas = int(fn.estimate_gas({"from": acct.address}) * 1.2)
    except Exception as exc:  # noqa: BLE001
        log.warning("estimate_gas failed: %s — using %d", exc, DEFAULT_GAS_LIMIT)
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
    log.info("registerTrace sent: market=%d hash=%s tx=%s",
             market_id, trace_hash_hex[:12], tx_hash)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    if receipt.status != 1:
        raise RuntimeError(f"registerTrace reverted: tx={tx_hash}")
    log.info("TraceRegistered: market=%d block=%d", market_id, receipt.blockNumber)
    return {"tx_hash": tx_hash, "block_number": receipt.blockNumber}


def get_trace(market_id: int) -> dict[str, Any]:
    """Read a market's registered trace. Returns {hash, uri, registered_at}."""
    reg = _registry_contract()
    h, uri, ts = reg.functions.getTrace(market_id).call()
    return {
        "trace_hash": "0x" + h.hex() if isinstance(h, bytes) else h,
        "uri": uri,
        "registered_at": int(ts),
    }
