"""Integration tests for /api/markets/* and /api/admin/* endpoints.

Mutating bet/claim/cancel/withdraw endpoints were removed when the UI swapped
to client-side signing via Privy + SimpleAccount. The only mutation routes
left here are the admin demo helpers (demo-market, force-resolve).
"""

from __future__ import annotations

import time


def headers(user_id):
    return {"X-Rugged-User-Id": user_id, "Content-Type": "application/json"}


# ---------- removed Circle routes — verify they're gone ----------

def test_dead_circle_routes_404(client, user_id, fake_chain, make_market):
    """These routes are intentionally removed. If they come back accidentally
    (a copy-paste reintroduction etc.) this test will catch it."""
    make_market(addr="0x" + "11" * 20)
    for path, body in [
        ("/api/markets/0/bet", {"is_yes": True, "amount_usdc": 1}),
        ("/api/markets/0/claim", None),
        ("/api/markets/0/cancel", {"is_yes": True}),
        ("/api/wallet/withdraw", {"to": "0x" + "ee" * 20, "amount_usdc": 1}),
    ]:
        r = client.post(path, json=body, headers=headers(user_id))
        assert r.status_code == 404, f"expected 404 for removed {path}, got {r.status_code}"


# ---------- /api/admin/demo-market ----------

def test_admin_demo_market_validates_input(client, fake_chain):
    for bad in [{"duration_seconds": 0}, {"duration_seconds": 10**9}, {"seed_probability_bps": -1}, {"seed_probability_bps": 99_999}]:
        r = client.post("/api/admin/demo-market", json=bad)
        assert r.status_code == 400, f"expected 400 for {bad}, got {r.status_code}"


def test_admin_demo_market_creates(client, fake_chain, chain_state, monkeypatch):
    # Stub the chain.factory.create_market to avoid signing a real tx but
    # still mutate the fake state so subsequent reads work.
    from chain import factory as factory_mod

    def _create(*, mint, symbol, chain, blacklist_timestamp, blacklist_price_micro_usd,
                seed_probability_bps, duration_seconds=0):
        mid = len(chain_state["markets"])
        addr = "0x" + str(mid + 80).rjust(2, "0") * 20
        chain_state["markets"].append(addr)
        chain_state["market_state"][addr] = {
            "address": addr, "market_id": mid, "yes_pool": 0, "no_pool": 0,
            "resolved": False, "yes_won": False,
            "blacklist_price_micro_usd": blacklist_price_micro_usd,
            "expiry": int(time.time()) + duration_seconds,
            "coin_address": "0x" + "ee" * 20,
        }
        return {
            "market_id": mid, "market_address": addr,
            "derived_addr": "0x" + "ee" * 20,
            "tx_hash": "0x" + "ff" * 32, "block_number": 99,
        }

    monkeypatch.setattr(factory_mod, "create_market", _create)

    r = client.post("/api/admin/demo-market", json={"duration_seconds": 120})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duration_seconds"] == 120
    assert body["symbol"].startswith("DEMO")
    assert "market_address" in body
    assert body["expiry"] > int(time.time())


# ---------- /api/admin/force-resolve ----------

def test_admin_force_resolve_404(client, fake_chain):
    r = client.post("/api/admin/force-resolve/9999", json={"outcome": "yes"})
    assert r.status_code == 404


def test_admin_force_resolve_409_before_expiry(client, fake_chain, chain_state, make_market):
    make_market(addr="0x" + "11" * 20, expiry_in=3600)
    r = client.post("/api/admin/force-resolve/0", json={"outcome": "yes"})
    assert r.status_code == 409
    assert "not yet expired" in r.json()["error"].lower()


def test_admin_force_resolve_yes(client, fake_chain, chain_state, make_market):
    make_market(addr="0x" + "11" * 20, expiry_in=-60)  # already past expiry
    r = client.post("/api/admin/force-resolve/0", json={"outcome": "yes"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "yes"
    assert body["observed_low_micro_usd"] == 0
    # Outcome recorded
    assert chain_state["outcomes"][0]["yes_won"] is True


def test_admin_force_resolve_no(client, fake_chain, chain_state, make_market):
    make_market(addr="0x" + "11" * 20, expiry_in=-60)
    r = client.post("/api/admin/force-resolve/0", json={"outcome": "no"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["outcome"] == "no"
    # observed_low == blacklist_price → yes_won should be false
    assert chain_state["outcomes"][0]["yes_won"] is False


def test_admin_force_resolve_validates_outcome(client, fake_chain, make_market):
    make_market(addr="0x" + "11" * 20, expiry_in=-60)
    r = client.post("/api/admin/force-resolve/0", json={"outcome": "maybe"})
    assert r.status_code == 400


def test_admin_force_resolve_409_already_resolved(client, fake_chain, chain_state, make_market):
    addr = "0x" + "11" * 20
    make_market(addr=addr, expiry_in=-60)
    chain_state["market_state"][addr]["resolved"] = True
    r = client.post("/api/admin/force-resolve/0", json={"outcome": "yes"})
    assert r.status_code == 409
    assert "already" in r.json()["error"].lower()
