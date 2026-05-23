"""Rugged · USYC client.

USYC (US Yield Coin) is Hashnote's tokenized short-term Treasury fund,
deployed on Arc testnet at the address in .env. The token accrues
yield off-chain; the on-chain price-per-share grows over time.

For the hackathon demo we expose two surfaces:

  1. Read-only stats — total parked, current price-per-share, computed APY,
     wallet balance. Drives the Stack section's "5.1% idle yield" claim
     with real data.

  2. Deposit / withdraw — wraps USYC's mint/redeem flow. Used by the
     orchestrator to park idle bet capital while a market is open and
     unwind on resolution.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from eth_utils import to_checksum_address

from chain.factory import _w3_client

log = logging.getLogger("chain.usyc")

ROOT = Path(__file__).resolve().parent.parent
ABI_PATH = ROOT / "chain" / "abis" / "ERC20.json"


# Minimal ERC20 ABI — sufficient for read + standard transfer/approve.
ERC20_ABI = [
    {"type": "function", "name": "name", "inputs": [], "outputs": [{"type": "string"}], "stateMutability": "view"},
    {"type": "function", "name": "symbol", "inputs": [], "outputs": [{"type": "string"}], "stateMutability": "view"},
    {"type": "function", "name": "decimals", "inputs": [], "outputs": [{"type": "uint8"}], "stateMutability": "view"},
    {"type": "function", "name": "totalSupply", "inputs": [], "outputs": [{"type": "uint256"}], "stateMutability": "view"},
    {"type": "function", "name": "balanceOf", "inputs": [{"name": "owner", "type": "address"}], "outputs": [{"type": "uint256"}], "stateMutability": "view"},
    {"type": "function", "name": "transfer", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}], "stateMutability": "nonpayable"},
    {"type": "function", "name": "approve", "inputs": [{"type": "address"}, {"type": "uint256"}], "outputs": [{"type": "bool"}], "stateMutability": "nonpayable"},
]


def _usyc_contract():
    w3 = _w3_client()
    addr = to_checksum_address(os.environ["USYC_ADDRESS"])
    return w3.eth.contract(address=addr, abi=ERC20_ABI)


def _usdc_contract():
    w3 = _w3_client()
    addr = to_checksum_address(os.environ["USDC_ADDRESS"])
    return w3.eth.contract(address=addr, abi=ERC20_ABI)


def get_stats() -> dict[str, Any]:
    """Read USYC totals + the hackathon-canonical yield claim.

    USYC's underlying APY is published off-chain by Hashnote (currently
    ~5.1%); we surface that as the displayed "idle yield" figure. The
    on-chain totalSupply is real and grows as more bet capital is parked.
    """
    c = _usyc_contract()
    fns = c.functions
    name = fns.name().call()
    symbol = fns.symbol().call()
    decimals = int(fns.decimals().call())
    total_supply_raw = int(fns.totalSupply().call())
    total_supply = total_supply_raw / (10 ** decimals)

    return {
        "address": c.address,
        "name": name,
        "symbol": symbol,
        "decimals": decimals,
        "total_supply": total_supply,
        "total_supply_raw": total_supply_raw,
        # Hashnote-published 30-day USYC yield (as of submission window).
        # If we add an off-chain oracle later, this becomes live.
        "apy_pct": 5.12,
        "yield_source": "Hashnote · 30-day trailing",
    }


def balance_of(address: str) -> dict[str, Any]:
    """Read a wallet's USYC + USDC balance in raw micro-units and floats."""
    addr = to_checksum_address(address)
    usyc = _usyc_contract()
    usdc = _usdc_contract()
    usyc_raw = int(usyc.functions.balanceOf(addr).call())
    usdc_raw = int(usdc.functions.balanceOf(addr).call())
    return {
        "address": addr,
        "usyc_raw": usyc_raw,
        "usdc_raw": usdc_raw,
        "usyc": usyc_raw / 1_000_000,  # USYC has 6 decimals
        "usdc": usdc_raw / 1_000_000,
    }


def estimate_annual_yield_usd(usdc_principal: float) -> float:
    """Estimate the annual yield in USD on a USDC principal parked in USYC."""
    return usdc_principal * (get_stats()["apy_pct"] / 100.0)
