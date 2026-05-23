"""Integration tests for /api/wallet/* endpoints."""

from __future__ import annotations


def headers(user_id):
    return {"X-Rugged-User-Id": user_id, "Content-Type": "application/json"}


# ---------- /api/wallet/register ----------

def test_register_writes_record(client, user_id, fake_chain, tmp_path):
    r = client.post(
        "/api/wallet/register",
        json={"address": "0x" + "ab" * 20},
        headers=headers(user_id),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] is True
    assert body["provider"] == "privy-smart-account"
    assert body["address"] == "0x" + "ab" * 20

    # GET /api/wallet should now report exists=True
    r = client.get("/api/wallet", headers=headers(user_id))
    assert r.status_code == 200
    assert r.json()["exists"] is True


def test_register_validates_address(client, user_id, fake_chain):
    bad_payloads = [
        {"address": ""},
        {"address": "notHex"},
        {"address": "0x123"},        # too short
        {"address": "0xZZ" + "00" * 19},  # invalid hex
    ]
    for p in bad_payloads:
        r = client.post("/api/wallet/register", json=p, headers=headers(user_id))
        assert r.status_code == 400, f"expected 400 for {p}, got {r.status_code}"


def test_register_requires_user_id(client, fake_chain):
    r = client.post(
        "/api/wallet/register",
        json={"address": "0x" + "ab" * 20},
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert "X-Rugged-User-Id" in r.json().get("error", "") or "X-Rugged-User-Id" in r.json().get("detail", "")


def test_register_is_idempotent(client, user_id, fake_chain):
    addr = "0x" + "ab" * 20
    r1 = client.post("/api/wallet/register", json={"address": addr}, headers=headers(user_id))
    r2 = client.post("/api/wallet/register", json={"address": addr}, headers=headers(user_id))
    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r1.json()["address"] == r2.json()["address"] == addr


# ---------- /api/wallet/positions ----------

def test_positions_no_wallet(client, user_id, fake_chain):
    r = client.get("/api/wallet/positions", headers=headers(user_id))
    assert r.status_code == 200
    body = r.json()
    assert body["has_wallet"] is False
    assert body["positions"] == []


def test_positions_returns_held_markets(client, user_id, fake_chain, chain_state, make_market):
    wallet = "0x" + "cc" * 20
    client.post("/api/wallet/register", json={"address": wallet}, headers=headers(user_id))

    # Two markets — only the second has a position.
    m0 = make_market(addr="0x" + "11" * 20)
    m1 = make_market(addr="0x" + "22" * 20)
    chain_state["positions"][("0x" + "22" * 20, wallet.lower())] = {
        "yes_stake": 3_000_000, "no_stake": 0,
        "has_position": True, "is_winner": False,
        "claimed": False, "claimable_micro_usdc": 0, "can_claim": False,
    }

    r = client.get("/api/wallet/positions", headers=headers(user_id))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_wallet"] is True
    assert body["count"] == 1
    assert body["positions"][0]["market_id"] == m1
    assert body["positions"][0]["yes_stake_usdc"] == 3.0
    assert body["positions"][0]["resolved"] is False


def test_positions_orders_newest_first(client, user_id, fake_chain, chain_state, make_market):
    wallet = "0x" + "cc" * 20
    client.post("/api/wallet/register", json={"address": wallet}, headers=headers(user_id))

    # Add three markets, give the wallet a position on all three.
    for i in range(3):
        addr = "0x" + str(i + 1).rjust(2, "0") * 20
        make_market(addr=addr)
        chain_state["positions"][(addr.lower(), wallet.lower())] = {
            "yes_stake": 1_000_000, "no_stake": 0,
            "has_position": True, "is_winner": False,
            "claimed": False, "claimable_micro_usdc": 0, "can_claim": False,
        }

    r = client.get("/api/wallet/positions", headers=headers(user_id))
    body = r.json()
    ids = [p["market_id"] for p in body["positions"]]
    assert ids == [2, 1, 0]  # newest first


# ---------- /api/wallet/faucet ----------

def test_faucet_requires_wallet(client, user_id, fake_chain, monkeypatch):
    r = client.post("/api/wallet/faucet", headers=headers(user_id))
    assert r.status_code == 409
    assert "no wallet" in r.json()["error"].lower()


def test_faucet_sends_and_records_cooldown(client, user_id, fake_chain, chain_state, monkeypatch):
    wallet = "0x" + "cc" * 20
    client.post("/api/wallet/register", json={"address": wallet}, headers=headers(user_id))

    # Stub the on-chain transfer path so we don't need real Arc.
    from api import main as api_main
    sent: dict = {}

    class _FakeAcct:
        address = "0x" + "de" * 20
        def sign_transaction(self, tx):
            sent["tx"] = tx
            class _S:
                raw_transaction = b"\x00" * 4
            return _S()

    class _Eth:
        chain_id = 5042002
        gas_price = 10**9
        def get_balance(self, _a): return 10**18
        def get_transaction_count(self, _a): return 0
        def estimate_gas(self, _tx): return 50_000
        def send_raw_transaction(self, _raw):
            class _H:
                def hex(self_): return "0x" + "ab" * 32
            return _H()
        def wait_for_transaction_receipt(self, _hash, timeout=60):
            class _R:
                status = 1
                blockNumber = 4242
            return _R()

    class _W3:
        eth = _Eth()
        def to_checksum_address(self, a): return a

    from chain import factory as factory_mod
    monkeypatch.setattr(factory_mod, "_w3_client", lambda: _W3())
    monkeypatch.setattr(factory_mod, "_account", lambda: _FakeAcct())

    r = client.post("/api/wallet/faucet", headers=headers(user_id))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["amount_usdc"] == 10.0
    assert body["block_number"] == 4242
    assert body["to"] == wallet

    # Second claim within cooldown (same user_id) → 429
    r2 = client.post("/api/wallet/faucet", headers=headers(user_id))
    assert r2.status_code == 429
    assert "cooldown" in r2.json()["error"].lower()


def test_faucet_ip_cooldown_blocks_other_user(client, user_id, fake_chain, monkeypatch):
    """Fresh user_id from the same IP should still be rate-limited by the IP gate."""
    import uuid
    wallet_a = "0x" + "aa" * 20
    wallet_b = "0x" + "bb" * 20
    client.post("/api/wallet/register", json={"address": wallet_a}, headers=headers(user_id))

    # Same on-chain stubs as the prior test.
    class _FakeAcct:
        address = "0x" + "de" * 20
        def sign_transaction(self, tx):
            class _S: raw_transaction = b"\x00" * 4
            return _S()
    class _Eth:
        gas_price = 10**9
        def get_balance(self, _a): return 10**18
        def get_transaction_count(self, _a): return 0
        def estimate_gas(self, _tx): return 50_000
        def send_raw_transaction(self, _raw):
            class _H:
                def hex(self_): return "0x" + "ab" * 32
            return _H()
        def wait_for_transaction_receipt(self, _h, timeout=60):
            class _R: status, blockNumber = 1, 4242
            return _R()
    class _W3:
        eth = _Eth()
        def to_checksum_address(self, a): return a

    from chain import factory as factory_mod
    monkeypatch.setattr(factory_mod, "_w3_client", lambda: _W3())
    monkeypatch.setattr(factory_mod, "_account", lambda: _FakeAcct())

    # First claim from user A succeeds.
    r = client.post("/api/wallet/faucet", headers=headers(user_id))
    assert r.status_code == 200

    # Second user, fresh user_id, claims from the same IP (TestClient defaults
    # to 127.0.0.1 / testclient). Should be blocked by the IP gate.
    user_b = str(uuid.uuid4())
    client.post("/api/wallet/register", json={"address": wallet_b}, headers=headers(user_b))
    r2 = client.post("/api/wallet/faucet", headers=headers(user_b))
    assert r2.status_code == 429
    assert "ip" in r2.json()["error"].lower()
