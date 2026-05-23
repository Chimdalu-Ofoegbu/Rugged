"""Rugged · MarketFactory client.

Wraps web3.py calls to MarketFactory on Arc testnet:
    - create_market(coin_address, blacklist_ts, blacklist_price, seed_bps)
      → returns (market_id, market_address, tx_hash)

Solana-to-EVM mint translation
------------------------------
MarketFactory.createMarket() takes a 20-byte EVM address for `coinAddress`.
Solana mints are 32-byte ed25519 pubkeys. We derive a deterministic 20-byte
identity from the mint via keccak256, and persist the (derived_addr → mint)
mapping locally so the frontend / Telegram bot can recover the Solana
identity for display.
"""

from __future__ import annotations

import base58
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from eth_account import Account
from eth_account.signers.local import LocalAccount
from eth_utils import to_checksum_address
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

log = logging.getLogger("chain.factory")

ROOT = Path(__file__).resolve().parent.parent
ABI_PATH = ROOT / "chain" / "abis" / "MarketFactory.json"
MINT_REGISTRY_PATH = ROOT / "data" / "mint_address_map.json"

DEFAULT_GAS_LIMIT = 3_500_000  # market deployment is heavy


# ----------------------------------------------------------------------
#  Web3 client — singleton
# ----------------------------------------------------------------------
_w3: Web3 | None = None
_acct: LocalAccount | None = None
_factory: Any = None  # web3 contract instance


def _w3_client() -> Web3:
    global _w3
    if _w3 is None:
        rpc = os.environ.get("ARC_RPC_URL")
        if not rpc:
            raise RuntimeError("ARC_RPC_URL not set")
        w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 20}))
        # Arc is PoA-style — inject POA middleware for extra-data field tolerance.
        try:
            w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        except Exception:  # idempotent guard if already injected
            pass
        if not w3.is_connected():
            raise RuntimeError(f"web3 cannot connect to {rpc}")
        _w3 = w3
    return _w3


def _account() -> LocalAccount:
    global _acct
    if _acct is None:
        pk = os.environ.get("DEPLOYER_PRIVATE_KEY")
        if not pk:
            raise RuntimeError("DEPLOYER_PRIVATE_KEY not set")
        _acct = Account.from_key(pk)
    return _acct


def _factory_contract():
    global _factory
    if _factory is None:
        addr = os.environ.get("MARKET_FACTORY_ADDRESS")
        if not addr:
            raise RuntimeError("MARKET_FACTORY_ADDRESS not set")
        abi = json.loads(ABI_PATH.read_text())
        _factory = _w3_client().eth.contract(address=to_checksum_address(addr), abi=abi)
    return _factory


# ----------------------------------------------------------------------
#  Solana mint → 20-byte EVM address derivation
# ----------------------------------------------------------------------
def mint_to_evm_address(mint_b58: str) -> str:
    """Deterministically derive a 20-byte EVM address from a Solana mint.

    keccak256(base58_decode(mint))[-20:] — same construction Ethereum uses
    to go from a 32-byte pubkey hash to an address.
    """
    raw = base58.b58decode(mint_b58)
    digest = Web3.keccak(raw)
    return to_checksum_address("0x" + digest[-20:].hex())


def _persist_mint_mapping(derived: str, mint: str, symbol: str, chain: str) -> None:
    """Append the derived→mint mapping to a local JSON registry."""
    MINT_REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing = json.loads(MINT_REGISTRY_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        existing = {}
    existing[derived.lower()] = {
        "mint": mint,
        "symbol": symbol,
        "chain": chain,
        "added_at": int(time.time()),
    }
    MINT_REGISTRY_PATH.write_text(json.dumps(existing, indent=2))


# ----------------------------------------------------------------------
#  Public API
# ----------------------------------------------------------------------
def create_market(
    *,
    mint: str,
    symbol: str,
    chain: str,
    blacklist_timestamp: int,
    blacklist_price_micro_usd: int,
    seed_probability_bps: int,
    duration_seconds: int = 0,
) -> dict[str, Any]:
    """Open a prediction market on Arc.

    `duration_seconds` controls the betting window. 0 = factory default
    (24h). Smaller values are for demo markets that should resolve quickly.

    Returns dict with: market_id, market_address, derived_addr, tx_hash,
    block_number. Persists the mint → derived_addr mapping locally.

    `blacklist_price_micro_usd` is the token's USD price at signal time,
    expressed in 1e6 fixed-point (so $0.000123 → 123). This matches the
    Resolution.sol convention.
    """
    derived = mint_to_evm_address(mint)
    _persist_mint_mapping(derived, mint, symbol, chain)

    w3 = _w3_client()
    acct = _account()
    factory = _factory_contract()

    log.info(
        "createMarket: mint=%s derived=%s ts=%d price=%d seed_bps=%d duration=%d",
        mint[:12], derived, blacklist_timestamp, blacklist_price_micro_usd,
        seed_probability_bps, duration_seconds,
    )

    nonce = w3.eth.get_transaction_count(acct.address)
    fn = factory.functions.createMarket(
        derived,
        blacklist_timestamp,
        blacklist_price_micro_usd,
        seed_probability_bps,
        duration_seconds,
    )

    # Estimate gas, fall back to constant on revert-on-estimate.
    try:
        gas = int(fn.estimate_gas({"from": acct.address}) * 1.2)
    except Exception as exc:  # noqa: BLE001
        log.warning("estimate_gas failed, using default %d: %s", DEFAULT_GAS_LIMIT, exc)
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
    log.info("createMarket sent: tx=%s", tx_hash)

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
    if receipt.status != 1:
        raise RuntimeError(f"createMarket reverted: tx={tx_hash}")

    # Decode the MarketOpened event from receipt logs
    market_id = None
    market_address = None
    for log_entry in receipt.logs:
        try:
            evt = factory.events.MarketOpened().process_log(log_entry)
            market_id = int(evt["args"]["marketId"])
            market_address = evt["args"]["market"]
            break
        except Exception:
            continue

    if market_id is None:
        # Fallback: query marketCount post-tx (off by one — latest is count-1)
        count = factory.functions.marketCount().call()
        market_id = count - 1
        market_address = factory.functions.getMarket(market_id).call()

    log.info("MarketOpened: id=%d addr=%s tx=%s", market_id, market_address, tx_hash)
    return {
        "market_id": market_id,
        "market_address": market_address,
        "derived_addr": derived,
        "tx_hash": tx_hash,
        "block_number": receipt.blockNumber,
    }
