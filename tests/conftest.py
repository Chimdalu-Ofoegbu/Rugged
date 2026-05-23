"""Shared pytest fixtures.

These tests stand up the FastAPI app via TestClient and stub the chain
modules with in-memory fakes — no Arc RPC, no Circle API, no Privy. Each
test gets a fresh per-user wallet dir + faucet ledger so rate limits and
position state don't leak across tests.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import pytest
from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def _env(monkeypatch, tmp_path):
    """Load .env, then redirect mutable per-user paths into a tmp dir
    so tests can't trample real wallet records or the faucet ledger."""
    load_dotenv(ROOT / ".env", override=True)
    # Sane defaults if anything's missing
    os.environ.setdefault("ARC_CHAIN_ID", "5042002")
    os.environ.setdefault("USDC_ADDRESS", "0x3600000000000000000000000000000000000000")
    os.environ.setdefault("PAYMASTER_ADDRESS", "0x4c4267fd5ad8373ee04ef64c1f51f32bf68c113c")
    os.environ.setdefault("PAYMASTER_SIGNER_PRIVATE_KEY", "0x" + "11" * 32)

    # Redirect mutable file paths into the test's tmp dir.
    from api import main as api_main
    monkeypatch.setattr(api_main, "WALLETS_DIR", tmp_path / "wallets")
    monkeypatch.setattr(api_main, "FAUCET_LEDGER_PATH", tmp_path / "faucet_ledger.json")
    monkeypatch.setattr(api_main, "FAUCET_IP_LEDGER_PATH", tmp_path / "faucet_ip_ledger.json")
    monkeypatch.setattr(api_main, "MINT_REGISTRY_PATH", tmp_path / "mint_address_map.json")
    yield


# ----------------------------------------------------------------------
#  Fake chain layer — replaces chain.factory / chain.market / chain.resolution
# ----------------------------------------------------------------------
class _FakeFn:
    def __init__(self, value):
        self._value = value

    def call(self):
        return self._value() if callable(self._value) else self._value


class _FakeFactoryFunctions:
    def __init__(self, state):
        self._s = state

    def marketCount(self):
        return _FakeFn(len(self._s["markets"]))

    def getMarket(self, i):
        addrs = self._s["markets"]
        return _FakeFn(addrs[i] if 0 <= i < len(addrs) else "0x" + "00" * 20)

    def isMarket(self, addr):
        return _FakeFn(addr.lower() in {a.lower() for a in self._s["markets"]})


class _FakeFactoryContract:
    def __init__(self, state):
        self.functions = _FakeFactoryFunctions(state)
        self.address = "0x" + "fa" * 20


class _FakeWeb3:
    def __init__(self):
        self.eth = self  # quack
        self.chain_id = 5042002
        self.block_number = 99999

    def get_balance(self, _addr):
        return 10**18


@pytest.fixture
def chain_state():
    """Mutable shared state used by the fake chain layer in this test."""
    return {
        "markets": [],            # market_id → on-chain address
        "positions": {},          # (market_addr, wallet_addr) → {yes_stake, no_stake, has_position, ...}
        "market_state": {},       # market_addr → state dict
        "balances": {},           # address → micro_usdc
        "outcomes": {},           # market_id → outcome dict (or None)
        "transfers": [],          # list of (to, amount_micro)
    }


@pytest.fixture
def fake_chain(monkeypatch, chain_state):
    """Wire fakes into api.main's chain imports."""
    from chain import factory as factory_mod
    from chain import market as market_mod
    from chain import resolution as resolution_mod

    # Factory contract. api.main does `from chain.factory import _factory_contract`
    # at module load, so it holds a SEPARATE reference — patch that too.
    from api import main as api_main
    fake_factory = lambda: _FakeFactoryContract(chain_state)
    fake_w3 = lambda: _FakeWeb3()
    monkeypatch.setattr(factory_mod, "_factory_contract", fake_factory)
    monkeypatch.setattr(factory_mod, "_w3_client", fake_w3)
    monkeypatch.setattr(api_main, "_factory_contract", fake_factory)
    monkeypatch.setattr(api_main, "_w3_client", fake_w3)

    # read_market / read_wallet_position
    def _read_market(addr):
        return chain_state["market_state"].get(addr, {
            "address": addr, "market_id": 0, "yes_pool": 0, "no_pool": 0,
            "resolved": False, "yes_won": False,
            "blacklist_price_micro_usd": 1_000_000, "expiry": int(time.time()) + 3600,
            "coin_address": "0x" + "00" * 20,
        })

    def _read_position(market_addr, wallet_addr):
        return chain_state["positions"].get(
            (market_addr.lower(), wallet_addr.lower()),
            {"yes_stake": 0, "no_stake": 0, "has_position": False,
             "is_winner": False, "claimed": False,
             "claimable_micro_usdc": 0, "can_claim": False},
        )

    monkeypatch.setattr(market_mod, "read_market", _read_market)
    monkeypatch.setattr(market_mod, "read_wallet_position", _read_position)

    # usyc balance_of — used by /api/wallet GET and faucet rate limit checks
    from chain import usyc as usyc_mod

    def _balance(addr: str):
        micro = chain_state["balances"].get(addr.lower(), 0)
        return {
            "address": addr,
            "usdc_raw": micro,
            "usdc": micro / 1_000_000,
            "usyc_raw": 0,
            "usyc": 0.0,
        }

    monkeypatch.setattr(usyc_mod, "balance_of", _balance)

    # Resolution.resolve + get_outcome
    def _resolve(*, market_address, observed_low_micro_usd):
        if observed_low_micro_usd < 0:
            raise ValueError("observed_low_micro_usd must be >= 0")
        # Find the market id by address
        addrs = chain_state["markets"]
        mid = next((i for i, a in enumerate(addrs) if a.lower() == market_address.lower()), None)
        if mid is None:
            raise RuntimeError(f"market not in registry: {market_address}")
        st = chain_state["market_state"].setdefault(market_address, {})
        blacklist_price = int(st.get("blacklist_price_micro_usd", 1_000_000))
        yes_won = (observed_low_micro_usd * 2) < blacklist_price
        st["resolved"] = True
        st["yes_won"] = yes_won
        chain_state["outcomes"][mid] = {
            "observed_low_price_micro_usd": observed_low_micro_usd,
            "blacklist_price_micro_usd": blacklist_price,
            "yes_won": yes_won,
            "resolved_at": int(time.time()),
        }
        return {"tx_hash": "0x" + "ab" * 32, "block_number": 12345}

    monkeypatch.setattr(resolution_mod, "resolve", _resolve)
    monkeypatch.setattr(
        resolution_mod, "get_outcome",
        lambda mid: chain_state["outcomes"].get(mid),
    )


@pytest.fixture
def client():
    """FastAPI TestClient over api.main:app."""
    from fastapi.testclient import TestClient
    from api.main import app
    return TestClient(app)


@pytest.fixture
def user_id() -> str:
    """A fresh UUIDv4 per test — keeps faucet rate-limits + wallet records isolated."""
    import uuid
    return str(uuid.uuid4())


def add_fake_market(chain_state, *, addr: str, blacklist_price_micro_usd: int = 1_000_000,
                    expiry_in: int = 3600) -> int:
    """Helper: register a fake market and return its market_id."""
    mid = len(chain_state["markets"])
    chain_state["markets"].append(addr)
    chain_state["market_state"][addr] = {
        "address": addr,
        "market_id": mid,
        "yes_pool": 0,
        "no_pool": 0,
        "resolved": False,
        "yes_won": False,
        "blacklist_price_micro_usd": blacklist_price_micro_usd,
        "expiry": int(time.time()) + expiry_in,
        "coin_address": "0x" + (str(mid).zfill(2) * 20)[:40],
    }
    return mid


@pytest.fixture
def make_market(chain_state):
    """Closure form for tests."""
    return lambda **kw: add_fake_market(chain_state, **kw)
