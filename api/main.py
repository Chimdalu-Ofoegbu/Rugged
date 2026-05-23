"""Rugged · backend API.

Read-only HTTP surface for the frontend:

    GET  /api/markets               — list all on-chain markets, enriched
    GET  /api/markets/{id}          — single market + full reasoning trace
    GET  /api/signals/recent        — live RugCheck risk feed (proxy)
    GET  /api/stats                 — top-of-page summary stats
    GET  /traces/{hash}             — raw pinned trace JSON (used by on-chain URI)
    GET  /                          — serves the SPA frontend (project/)

The mutable bet/bond endpoints live behind separate routes wired in
task #5 (Paymaster integration). This file focuses on the read surface
that the prototype frontend needs to come alive.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import re

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=True)

from chain.factory import _factory_contract, _w3_client  # noqa: E402
from chain.market import read_market  # noqa: E402
from chain.trace_registry import get_trace  # noqa: E402
from chain.usyc import balance_of as usyc_balance_of, get_stats as usyc_stats  # noqa: E402
from scripts.seed_historical import load as load_historical  # noqa: E402
from traces.pin_trace import TRACE_DIR, load as load_trace  # noqa: E402

log = logging.getLogger("api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

app = FastAPI(title="Rugged API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # demo — tighten before any production use
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Mounted route modules — keep new endpoints in api/routes/*.py and register here.
from api.routes.paymaster import router as paymaster_router  # noqa: E402
from api.routes.bundler import router as bundler_router  # noqa: E402
app.include_router(paymaster_router)
app.include_router(bundler_router)


# ----------------------------------------------------------------------
#  Local mint registry — derived EVM addr → original Solana mint
# ----------------------------------------------------------------------
MINT_REGISTRY_PATH = ROOT / "data" / "mint_address_map.json"


def _mint_registry() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(MINT_REGISTRY_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# ----------------------------------------------------------------------
#  Cached chain reads — markets list refreshes every 10s
# ----------------------------------------------------------------------
_markets_cache: dict[str, Any] = {"at": 0.0, "data": []}
# Cache TTL — Arc testnet RPC is rate-limited at the swarm endpoint and
# starts returning 503s under load, so we hold the cache much longer than
# the original 30s. Bet placements / new markets show up on the next
# manual refresh or when an admin endpoint invalidates the cache.
_CACHE_TTL = 300.0  # 5 minutes


def _invalidate_markets_cache() -> None:
    """Force the next `/api/markets` call to re-read from chain."""
    _markets_cache["at"] = 0.0
    _markets_cache["data"] = []
# Concurrency cap for chain reads — too high triggers Arc's swarm rate
# limit (HTTP 503). Two parallel reads is the sweet spot: still 3-4× faster
# than serial, well below the 503 threshold.
_CHAIN_FANOUT = 2


def _with_retry(fn, *args, retries: int = 3, backoff: float = 0.6, **kwargs):
    """Retry helper for chain reads. Arc testnet's swarm RPC occasionally
    503s under load; a few short backoffs almost always recover."""
    last_exc: Exception | None = None
    for attempt in range(retries):
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            msg = str(exc).lower()
            transient = "503" in msg or "service" in msg or "timeout" in msg or "temporarily" in msg
            if not transient:
                raise
            time.sleep(backoff * (2 ** attempt))
    raise last_exc if last_exc else RuntimeError("retry exhausted")


def _enrich(market_id: int) -> dict[str, Any] | None:
    """Pull a single market's full picture: on-chain state + trace."""
    factory = _factory_contract()
    addr = _with_retry(lambda: factory.functions.getMarket(market_id).call())
    if int(addr, 16) == 0:
        return None
    state = _with_retry(read_market, addr)
    derived = state["coin_address"].lower()
    mint_meta = _mint_registry().get(derived, {})

    # Trace
    trace_info: dict[str, Any] = {}
    try:
        tr = get_trace(market_id)
        trace_info = {
            "hash": tr["trace_hash"][2:] if tr["trace_hash"].startswith("0x") else tr["trace_hash"],
            "uri": tr["uri"],
            "registered_at": tr["registered_at"],
        }
    except Exception as exc:  # noqa: BLE001
        log.warning("trace lookup failed for market %d: %s", market_id, exc)

    return {
        **state,
        "mint": mint_meta.get("mint"),
        "symbol": mint_meta.get("symbol"),
        "chain": mint_meta.get("chain", "solana"),
        "trace": trace_info or None,
    }


# ----------------------------------------------------------------------
#  Routes
# ----------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, Any]:
    w3 = _w3_client()
    return {
        "status": "ok",
        "chain_id": w3.eth.chain_id,
        "block_number": w3.eth.block_number,
        "factory": _factory_contract().address,
    }


def _historical_markets() -> list[dict[str, Any]]:
    """Return the seeded historical markets, or an empty list if not seeded."""
    return load_historical().get("markets", []) or []


@app.get("/api/markets")
def list_markets() -> dict[str, Any]:
    """Returns all markets — live on-chain first, then the historical seed.

    Live enrichment is parallelized via a thread pool: Arc's RPC is ~9s per
    `read_market` call, so a serial loop over N markets blows past the
    client's HTTP timeout. ThreadPoolExecutor turns that into a single 9s
    cold fill regardless of N (up to the pool size).
    """
    now = time.time()
    historical = _historical_markets()
    if now - _markets_cache["at"] < _CACHE_TTL and _markets_cache["data"]:
        return {
            "markets": _markets_cache["data"] + historical,
            "count": len(_markets_cache["data"]) + len(historical),
            "live_count": len(_markets_cache["data"]),
            "historical_count": len(historical),
            "cached": True,
        }

    factory = _factory_contract()
    count = factory.functions.marketCount().call()

    from concurrent.futures import ThreadPoolExecutor
    # Pool size > expected market count so every market reads concurrently.
    with ThreadPoolExecutor(max_workers=_CHAIN_FANOUT) as pool:
        results = list(pool.map(_enrich, range(count)))
    markets = [m for m in results if m is not None]
    # Preserve newest-first ordering for the UI (matches market_id).
    markets.sort(key=lambda m: m.get("market_id", 0), reverse=True)

    _markets_cache["at"] = now
    _markets_cache["data"] = markets
    return {
        "markets": markets + historical,
        "count": len(markets) + len(historical),
        "live_count": len(markets),
        "historical_count": len(historical),
        "cached": False,
    }


@app.get("/api/markets/history")
def list_historical() -> dict[str, Any]:
    """The 30 seeded resolved markets that drive the hit-rate KPI."""
    doc = load_historical()
    return {
        "markets": doc.get("markets", []),
        "total": doc.get("total", 0),
        "rug_count": doc.get("rug_count", 0),
        "safe_count": doc.get("safe_count", 0),
        "hit_rate": doc.get("hit_rate", 0.0),
        "generated_at": doc.get("generated_at"),
        "source": doc.get("source"),
    }


@app.get("/api/markets/{market_id}")
def market_detail(market_id: int) -> dict[str, Any]:
    # Historical markets live above id 100_000 — short-circuit before hitting chain.
    if market_id >= 100_000:
        for m in _historical_markets():
            if m.get("market_id") == market_id:
                return {
                    **m,
                    "full_trace": {
                        "schema_version": "1.0-historical",
                        "verdicts": m.get("verdicts", []),
                        "fire": True,
                        "seed_probability_bps": m.get("seed_probability_bps"),
                        "trace_hash": m.get("trace", {}).get("hash"),
                    },
                }
        raise HTTPException(status_code=404, detail=f"historical market {market_id} not found")

    enriched = _enrich(market_id)
    if not enriched:
        raise HTTPException(status_code=404, detail=f"market {market_id} not found")

    # Inline the full trace JSON so the detail page renders it without an extra fetch.
    full_trace = None
    if enriched.get("trace"):
        full_trace = load_trace(enriched["trace"]["hash"])

    # If resolved, attach the on-chain Resolution outcome (observed low,
    # resolved-at timestamp). The Market contract itself only stores `yesWon`;
    # the audit-grade record lives on Resolution.
    outcome = None
    if enriched.get("resolved"):
        try:
            from chain.resolution import get_outcome
            outcome = get_outcome(market_id)
        except Exception as exc:  # noqa: BLE001 — don't fail detail render on a missing outcome
            log.debug("outcome read failed for market %d: %s", market_id, exc)
    return {**enriched, "full_trace": full_trace, "outcome": outcome}


@app.get("/api/signals/recent")
async def signals_recent() -> dict[str, Any]:
    """Proxy RugCheck's recent risk feed — used by the dashboard ticker."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get("https://api.rugcheck.xyz/v1/stats/recent")
            r.raise_for_status()
            items = r.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"rugcheck upstream: {exc}")
    feed = []
    for it in items[:25]:
        meta = it.get("metadata") or {}
        feed.append({
            "mint": it.get("mint"),
            "symbol": meta.get("symbol"),
            "name": meta.get("name"),
            "score": it.get("score"),
        })
    return {"feed": feed}


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    """Top-of-page hero stats — live on-chain + historical seed merged."""
    factory = _factory_contract()
    w3 = _w3_client()
    count = factory.functions.marketCount().call()

    total_yes = 0
    total_no = 0
    open_markets = 0
    live_rugs = 0
    live_resolved = 0

    def _read_one(i: int) -> dict[str, Any] | None:
        addr = factory.functions.getMarket(i).call()
        if int(addr, 16) == 0:
            return None
        return read_market(addr)

    # Parallel: Arc RPC is ~9s per call; serial would blow past the client
    # timeout once we have more than a handful of markets.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=_CHAIN_FANOUT) as pool:
        results = list(pool.map(_read_one, range(count)))
    for s in results:
        if s is None:
            continue
        total_yes += s["yes_pool"]
        total_no += s["no_pool"]
        if s["resolved"]:
            live_resolved += 1
            if s["yes_won"]:
                live_rugs += 1
        else:
            open_markets += 1

    hist = load_historical()
    hist_total = hist.get("total", 0)
    hist_rugs = hist.get("rug_count", 0)
    hist_volume = sum(
        m.get("yes_pool", 0) + m.get("no_pool", 0) for m in hist.get("markets", [])
    )

    combined_resolved = live_resolved + hist_total
    combined_rugs = live_rugs + hist_rugs
    hit_rate = combined_rugs / combined_resolved if combined_resolved else 0.0

    return {
        "market_count": count + hist_total,
        "live_market_count": count,
        "historical_market_count": hist_total,
        "open_markets": open_markets,
        "resolved_markets": combined_resolved,
        "total_volume_usdc_micro": total_yes + total_no + hist_volume,
        "hit_rate": round(hit_rate, 4),
        "hit_rate_pct": round(hit_rate * 100, 1),
        "block_number": w3.eth.block_number,
        "chain_id": w3.eth.chain_id,
    }


@app.get("/traces/{trace_hash}")
def get_pinned_trace(trace_hash: str) -> JSONResponse:
    """Serve a pinned reasoning trace by SHA-256 hash."""
    data = load_trace(trace_hash)
    if data is None:
        raise HTTPException(status_code=404, detail=f"trace {trace_hash} not found")
    return JSONResponse(data)


# ----------------------------------------------------------------------
#  USYC + Paymaster / Circle Wallets surface
# ----------------------------------------------------------------------
@app.get("/api/usyc/stats")
def usyc_stats_route() -> dict[str, Any]:
    """USYC token stats + APY claim. Drives the 'idle yield' UI."""
    return usyc_stats()


@app.get("/api/usyc/balance/{address}")
def usyc_balance_route(address: str) -> dict[str, Any]:
    """USYC + USDC balance of a wallet."""
    try:
        return usyc_balance_of(address)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


# ----------------------------------------------------------------------
#  Per-user wallet storage
#
#  Each visitor's browser generates a stable UUIDv4 (stored in localStorage
#  as `rugged_user_id`) and sends it on every wallet-scoped request via
#  the `X-Rugged-User-Id` header. The backend keys wallet records by this
#  UUID — never a single shared file. This means:
#
#    - Two browsers on the same machine get two different wallets.
#    - A browser that clears localStorage gets a fresh wallet on next visit.
#    - The Circle wallet set is shared across users (Circle bills per
#      wallet *creation*, not per set), so we reuse the same set_id and
#      only provision a new on-chain wallet inside it per user.
#
#  This is intentionally NOT real authentication — anyone who exfiltrates
#  the user_id from a browser can act on that wallet. Layering Privy /
#  OAuth on top is the production fix (mapping a verified identity → user_id).
# ----------------------------------------------------------------------
WALLETS_DIR = ROOT / "data" / "wallets"
USER_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _require_user_id(x_rugged_user_id: str | None = Header(default=None)) -> str:
    """Pull and validate the X-Rugged-User-Id header. Used as a FastAPI dependency."""
    if not x_rugged_user_id:
        raise HTTPException(
            status_code=400,
            detail="missing X-Rugged-User-Id header (the frontend should set this)",
        )
    if not USER_ID_RE.match(x_rugged_user_id):
        raise HTTPException(status_code=400, detail="invalid X-Rugged-User-Id format")
    return x_rugged_user_id.lower()


def _user_wallet_path(user_id: str) -> Path:
    return WALLETS_DIR / f"{user_id}.json"


def _load_user_wallet(user_id: str) -> dict[str, Any] | None:
    try:
        return json.loads(_user_wallet_path(user_id).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _save_user_wallet(user_id: str, record: dict[str, Any]) -> None:
    WALLETS_DIR.mkdir(parents=True, exist_ok=True)
    _user_wallet_path(user_id).write_text(json.dumps(record, indent=2))


@app.get("/api/wallet")
def wallet_get(x_rugged_user_id: str | None = Header(default=None)) -> dict[str, Any]:
    """Return this user's wallet info + balance. Use POST to provision."""
    user_id = _require_user_id(x_rugged_user_id)
    record = _load_user_wallet(user_id)
    if not record:
        return {"exists": False}
    try:
        bal = usyc_balance_of(record["address"])
    except Exception as exc:  # noqa: BLE001
        log.warning("balance read failed: %s", exc)
        bal = {}
    return {"exists": True, **record, "balance": bal}


@app.post("/api/wallet/register")
def wallet_register_route(
    payload: dict[str, Any],
    x_rugged_user_id: str | None = Header(default=None),
) -> dict[str, Any]:
    """Bind an externally-managed smart-account address to this user_id.

    payload = {"address": "0x..."}

    Used by the Privy + SimpleAccount flow: the smart account is deployed
    counterfactually from the user's Privy EOA; we record the address here
    so per-user-keyed endpoints (`/api/wallet`, `/api/wallet/positions`,
    `/api/wallet/faucet`) can locate it. Idempotent — repeated calls with
    the same address just refresh the timestamp. Different address from
    the same user_id overwrites (rare; happens if the user clears Privy
    and signs in with a new email).

    Distinct from `POST /api/wallet` which provisions a Circle-managed
    wallet server-side. The two write to the same ledger but with
    different `provider` fields so the GET routes can render either.
    """
    user_id = _require_user_id(x_rugged_user_id)
    addr = (payload.get("address") or "").strip()
    if not addr or not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail="address must be a 0x-prefixed 20-byte hex string")
    try:
        int(addr, 16)
    except ValueError:
        raise HTTPException(status_code=400, detail="address: invalid hex")

    record = {
        "address": addr,
        "user_id": user_id,
        "provider": "privy-smart-account",
        "blockchain": "arc-testnet",
        "registered_at": int(time.time()),
    }
    _save_user_wallet(user_id, record)
    return {"created": True, **record}


@app.get("/api/wallet/exists")
def wallet_exists_route(x_rugged_user_id: str | None = Header(default=None)) -> dict[str, Any]:
    """Lightweight check — does this user already have a wallet record?

    Used by the wallet modal to branch the connect-button copy:
        first-time visitor   → "Provision Circle wallet"
        returning visitor    → "Reconnect Circle wallet"

    Does NOT touch Circle's API or read on-chain balance — pure file check.
    """
    user_id = _require_user_id(x_rugged_user_id)
    record = _load_user_wallet(user_id)
    if not record:
        return {"exists": False}
    return {
        "exists": True,
        # Echo only the public identifiers — never the wallet id.
        "address": record.get("address"),
        "blockchain": record.get("blockchain"),
    }


# ----------------------------------------------------------------------
#  Demo faucet — transfer $10 testnet USDC from the deployer to the caller's
#  wallet. Rate-limited on TWO independent keys:
#
#    - X-Rugged-User-Id   (per browser identity)
#    - client IP          (per network egress point)
#
#  Either one tripping its cooldown returns 429. The IP gate stops the
#  trivial "clear localStorage, claim again" loop; the user_id gate is
#  what surfaces the friendly "wait N minutes" message in the UI when
#  the user themselves just claimed.
# ----------------------------------------------------------------------
FAUCET_AMOUNT_MICRO_USDC = 10_000_000  # $10
FAUCET_COOLDOWN_SECONDS = 60 * 60       # 1 hour per user_id
FAUCET_IP_COOLDOWN_SECONDS = 60 * 60    # 1 hour per IP
FAUCET_LEDGER_PATH = ROOT / "data" / "faucet_ledger.json"
FAUCET_IP_LEDGER_PATH = ROOT / "data" / "faucet_ip_ledger.json"


def _faucet_ledger() -> dict[str, float]:
    try:
        return json.loads(FAUCET_LEDGER_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _faucet_ip_ledger() -> dict[str, float]:
    try:
        return json.loads(FAUCET_IP_LEDGER_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _faucet_record(user_id: str, ip: str | None) -> None:
    now = time.time()
    ledger = _faucet_ledger()
    ledger[user_id] = now
    FAUCET_LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    FAUCET_LEDGER_PATH.write_text(json.dumps(ledger, indent=2))
    if ip:
        ip_ledger = _faucet_ip_ledger()
        ip_ledger[ip] = now
        FAUCET_IP_LEDGER_PATH.write_text(json.dumps(ip_ledger, indent=2))


def _client_ip(request) -> str | None:
    """Pull the source IP from the request, respecting X-Forwarded-For if a
    proxy/load-balancer set it. Best-effort: returns None if unavailable."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        # First entry is the original client; the rest are proxy chain.
        return fwd.split(",")[0].strip()
    client = getattr(request, "client", None)
    return client.host if client else None


@app.post("/api/wallet/faucet")
def wallet_faucet_route(
    request: Request,
    x_rugged_user_id: str | None = Header(default=None),
) -> dict[str, Any]:
    """Send $10 testnet USDC from the deployer EOA to the caller's wallet.

    Rate-limited on BOTH X-Rugged-User-Id and source IP (1/hr each). Either
    cooldown tripping returns 429. Not authenticated — anyone reaching the
    server with a registered wallet can claim once per hour per IP. Fine
    for testnet.
    """
    user_id = _require_user_id(x_rugged_user_id)
    wallet = _load_user_wallet(user_id)
    if not wallet:
        raise HTTPException(status_code=409, detail="no wallet yet — POST /api/wallet first")

    now = time.time()
    ip = _client_ip(request)

    last_user = _faucet_ledger().get(user_id, 0)
    elapsed = now - last_user
    if elapsed < FAUCET_COOLDOWN_SECONDS:
        wait = int(FAUCET_COOLDOWN_SECONDS - elapsed)
        raise HTTPException(
            status_code=429,
            detail=f"faucet cooldown: try again in {wait // 60}m {wait % 60}s",
        )

    if ip:
        last_ip = _faucet_ip_ledger().get(ip, 0)
        elapsed_ip = now - last_ip
        if elapsed_ip < FAUCET_IP_COOLDOWN_SECONDS:
            wait = int(FAUCET_IP_COOLDOWN_SECONDS - elapsed_ip)
            raise HTTPException(
                status_code=429,
                detail=f"faucet cooldown (ip): try again in {wait // 60}m {wait % 60}s",
            )

    # Send via the deployer EOA — fast and gas is paid in native ARC, not USDC.
    # (Going through Circle paymaster would also work but adds latency.)
    try:
        from chain.factory import _account, _w3_client
        from eth_abi import encode as abi_encode
        from eth_utils import keccak

        w3 = _w3_client()
        acct = _account()
        usdc = w3.to_checksum_address(os.environ["USDC_ADDRESS"])
        recipient = w3.to_checksum_address(wallet["address"])
        selector = keccak(text="transfer(address,uint256)")[:4]
        data = selector + abi_encode(
            ["address", "uint256"], [recipient, FAUCET_AMOUNT_MICRO_USDC],
        )
        tx = {
            "from": acct.address,
            "to": usdc,
            "value": 0,
            "data": "0x" + data.hex(),
            "nonce": w3.eth.get_transaction_count(acct.address),
            "gasPrice": w3.eth.gas_price,
            "chainId": int(os.environ.get("ARC_CHAIN_ID", "5042002")),
        }
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.2)
        signed = acct.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
        if receipt.status != 1:
            raise RuntimeError(f"transfer tx reverted: {tx_hash}")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("faucet transfer failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"faucet failed: {exc}")

    _faucet_record(user_id, ip)
    return {
        "to": wallet["address"],
        "amount_usdc": FAUCET_AMOUNT_MICRO_USDC / 1_000_000,
        "amount_micro_usdc": FAUCET_AMOUNT_MICRO_USDC,
        "tx_hash": "0x" + tx_hash if not tx_hash.startswith("0x") else tx_hash,
        "block_number": int(receipt.blockNumber),
        "cooldown_seconds": FAUCET_COOLDOWN_SECONDS,
    }


@app.get("/api/markets/{market_id}/position")
def market_position_route(
    market_id: int,
    x_rugged_user_id: str | None = Header(default=None),
) -> dict[str, Any]:
    """Per-wallet view of a market: yes/no stake + claim status."""
    user_id = _require_user_id(x_rugged_user_id)
    wallet = _load_user_wallet(user_id)
    if not wallet:
        return {"has_wallet": False}

    # Historical markets are synthetic — this user's wallet has no position.
    if market_id >= 100_000:
        return {
            "has_wallet": True,
            "wallet_address": wallet["address"],
            "yes_stake_micro_usdc": 0,
            "no_stake_micro_usdc": 0,
            "has_position": False,
            "is_winner": False,
            "claimed": False,
            "claimable_micro_usdc": 0,
            "can_claim": False,
            "historical": True,
        }

    factory = _factory_contract()
    market_addr = factory.functions.getMarket(market_id).call()
    if int(market_addr, 16) == 0:
        raise HTTPException(status_code=404, detail=f"market {market_id} not found")
    from chain.market import read_wallet_position
    pos = read_wallet_position(market_addr, wallet["address"])
    return {
        "has_wallet": True,
        "wallet_address": wallet["address"],
        "market_address": market_addr,
        "yes_stake_micro_usdc": pos["yes_stake"],
        "no_stake_micro_usdc": pos["no_stake"],
        "has_position": pos["has_position"],
        "is_winner": pos["is_winner"],
        "claimed": pos["claimed"],
        "claimable_micro_usdc": pos["claimable_micro_usdc"],
        "can_claim": pos["can_claim"],
        "historical": False,
    }


@app.get("/api/wallet/positions")
def wallet_positions_route(
    x_rugged_user_id: str | None = Header(default=None),
) -> dict[str, Any]:
    """Aggregate view: every market where the caller has a non-zero stake.

    Walks the factory's market list once, queries `yesStake(wallet)` +
    `noStake(wallet)` on each, and returns the ones with a position. Used
    by the wallet modal's "My Bets" tab.

    Historical markets (id ≥ 100_000) are synthetic and never include
    real positions, so they're skipped — this is a live-only query.
    """
    user_id = _require_user_id(x_rugged_user_id)
    wallet = _load_user_wallet(user_id)
    if not wallet:
        return {"has_wallet": False, "positions": []}

    from chain.market import read_market, read_wallet_position
    factory = _factory_contract()
    count = factory.functions.marketCount().call()
    mints = _mint_registry()
    wallet_addr = wallet["address"]

    def _read_position(market_id: int):
        """Read addr + position + market state for a single market in one shot.

        Returns (market_id, market_addr, pos, mstate) or None to skip.
        Runs in a worker thread — Arc RPC is per-call slow."""
        market_addr = factory.functions.getMarket(market_id).call()
        if int(market_addr, 16) == 0:
            return None
        try:
            pos = read_wallet_position(market_addr, wallet_addr)
        except Exception as exc:  # noqa: BLE001
            log.warning("position read failed for market %d: %s", market_id, exc)
            return None
        if not pos["has_position"]:
            return None
        try:
            mstate = read_market(market_addr)
        except Exception as exc:  # noqa: BLE001
            log.warning("market read failed for %d: %s", market_id, exc)
            mstate = {}
        return (market_id, market_addr, pos, mstate)

    # Parallelize across all markets — Arc RPC is ~9s/call serially.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=_CHAIN_FANOUT) as pool:
        results = list(pool.map(_read_position, range(count)))

    positions: list[dict[str, Any]] = []
    for entry in results:
        if entry is None:
            continue
        market_id, market_addr, pos, mstate = entry
        derived = (mstate.get("coin_address") or "").lower()
        mint_meta = mints.get(derived, {})

        positions.append({
            "market_id": market_id,
            "market_address": market_addr,
            "symbol": mint_meta.get("symbol"),
            "mint": mint_meta.get("mint"),
            "chain": mint_meta.get("chain", "solana"),
            "yes_stake_micro_usdc": pos["yes_stake"],
            "no_stake_micro_usdc": pos["no_stake"],
            "yes_stake_usdc": pos["yes_stake"] / 1_000_000,
            "no_stake_usdc": pos["no_stake"] / 1_000_000,
            "resolved": bool(mstate.get("resolved")),
            "yes_won": bool(mstate.get("yes_won")) if mstate.get("resolved") else None,
            "is_winner": pos["is_winner"],
            "claimed": pos["claimed"],
            "claimable_micro_usdc": pos["claimable_micro_usdc"],
            "claimable_usdc": pos["claimable_micro_usdc"] / 1_000_000,
            "can_claim": pos["can_claim"],
            "expiry": mstate.get("expiry"),
        })

    # Newest market first — matches the markets-list ordering.
    positions.sort(key=lambda p: p["market_id"], reverse=True)
    return {
        "has_wallet": True,
        "wallet_address": wallet["address"],
        "positions": positions,
        "count": len(positions),
    }


@app.post("/api/admin/demo-market")
def admin_demo_market(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Spin up a synthetic short-duration market for demos.

    Defaults to a 5-minute window with a fake "DEMO####" symbol so the full
    bet → resolve → claim cycle is observable on a coffee timer instead of
    24h. Real markets keep opening through the watcher pipeline; this is
    purely a demo affordance.

    payload (optional):
      duration_seconds   — default 300 (5min)
      seed_probability_bps — default 7500
    """
    from chain.factory import create_market as _create_market
    payload = payload or {}
    duration = int(payload.get("duration_seconds", 300))
    seed_bps = int(payload.get("seed_probability_bps", 7500))
    if duration <= 0 or duration > 24 * 3600:
        raise HTTPException(status_code=400, detail="duration_seconds must be 1..86400")
    if seed_bps < 0 or seed_bps > 10_000:
        raise HTTPException(status_code=400, detail="seed_probability_bps must be 0..10000")

    now = int(time.time())
    suffix = str(now)[-4:]
    # The factory keys markets by a base58 mint string. base58 excludes 0,
    # O, I, l — use a random valid-alphabet payload tagged with the suffix
    # so demos still get a readable symbol.
    import base58 as _b58
    import secrets as _secrets
    # 32 random bytes → ~44 chars of valid base58 — same shape as a real
    # Solana mint pubkey. We do NOT splice the timestamp suffix in here
    # because 0 / O / I / l aren't valid base58 characters.
    raw = _secrets.token_bytes(32)
    mint = _b58.b58encode(raw).decode("ascii")
    symbol = f"DEMO{suffix}"
    try:
        result = _create_market(
            mint=mint,
            symbol=symbol,
            chain="solana",
            blacklist_timestamp=now,
            blacklist_price_micro_usd=1_000,  # arbitrary baseline
            seed_probability_bps=seed_bps,
            duration_seconds=duration,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("demo-market create failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))

    _invalidate_markets_cache()
    return {
        "symbol": symbol,
        "mint": mint,
        "duration_seconds": duration,
        "seed_probability_bps": seed_bps,
        "expiry": now + duration,
        **result,
    }


@app.post("/api/admin/force-resolve/{market_id}")
def admin_force_resolve(
    market_id: int,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Force a market's outcome via Resolution.resolve(market, observedLow).

    payload (optional):
      outcome  — "yes" (default) or "no". yes uses observedLow=0 (rug);
                 no uses observedLow=blacklist_price (no drop).

    The market must be past its expiry — Resolution.sol enforces that.
    Useful for demos where the synthetic mint has no real price source.
    """
    payload = payload or {}
    outcome = (payload.get("outcome") or "yes").lower()
    if outcome not in ("yes", "no"):
        raise HTTPException(status_code=400, detail="outcome must be 'yes' or 'no'")

    factory = _factory_contract()
    market_addr = factory.functions.getMarket(market_id).call()
    if int(market_addr, 16) == 0:
        raise HTTPException(status_code=404, detail=f"market {market_id} not found")

    from chain.market import read_market
    from chain.resolution import get_outcome as _existing_outcome, resolve as _resolve_market
    state = read_market(market_addr)
    if state["resolved"]:
        raise HTTPException(status_code=409, detail="market already resolved")
    if int(state["expiry"]) > int(time.time()):
        wait = int(state["expiry"]) - int(time.time())
        raise HTTPException(
            status_code=409,
            detail=f"market not yet expired — wait {wait}s (try again at unix {state['expiry']})",
        )
    if _existing_outcome(market_id):
        raise HTTPException(status_code=409, detail="resolution already recorded")

    # yes → observed_low = 0 (extreme drop). no → observed_low = blacklist_price
    # (no drop). Both satisfy the contract's `low * 2 vs blacklist_price` test.
    observed_low = 0 if outcome == "yes" else int(state["blacklist_price_micro_usd"])
    try:
        result = _resolve_market(
            market_address=market_addr,
            observed_low_micro_usd=observed_low,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("force-resolve failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))

    _invalidate_markets_cache()
    return {
        "market_id": market_id,
        "market_address": market_addr,
        "outcome": outcome,
        "observed_low_micro_usd": observed_low,
        "blacklist_price_micro_usd": int(state["blacklist_price_micro_usd"]),
        **result,
    }


@app.post("/api/admin/clear-markets-cache")
def admin_clear_markets_cache() -> dict[str, Any]:
    """Drop the in-memory /api/markets cache. Next call re-reads from chain."""
    _invalidate_markets_cache()
    return {"cleared": True}


@app.post("/api/admin/resolver-tick")
async def admin_resolver_tick() -> dict[str, Any]:
    """Force one resolver-daemon tick on demand.

    Snapshots prices for open markets and resolves any that have already
    passed their expiry. Useful during demos when waiting for the 30s
    orchestrator poll feels too long.

    Note: this does NOT bypass `Market.expiry()` — markets that haven't
    crossed the 24h window still won't resolve. To shorten the demo cycle
    you'd need to redeploy `Market` with a smaller `MARKET_DURATION`.
    """
    from resolver import daemon as resolver_daemon
    try:
        summary = await resolver_daemon.tick()
    except Exception as exc:  # noqa: BLE001
        log.exception("resolver tick failed via admin: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc))
    return summary


# NOTE: bet / claim / cancel / withdraw used to be backend-mediated routes
# that signed transactions via Circle Developer-Controlled Wallets. They
# were removed when the UI swapped to Privy + SimpleAccount + RuggedPaymaster
# — every mutation now signs client-side and goes through
# /api/paymaster/sponsor + /api/bundler/submit. If you need the legacy code,
# check git history (chain/circle_wallet.py was removed in the same change).


# ----------------------------------------------------------------------
#  Static frontend mount
# ----------------------------------------------------------------------
PROJECT_DIR = ROOT / "project"
if PROJECT_DIR.exists():
    app.mount("/project", StaticFiles(directory=PROJECT_DIR, html=False), name="project")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(PROJECT_DIR / "index.html")


# Pretty-print 404s on /api/* so the frontend can branch on missing data.
@app.exception_handler(HTTPException)
def http_exception_handler(_request, exc):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


# Root-level static files (markets.jsx, styles.css, etc.) — declared LAST so
# explicit routes above take precedence. Single-segment paths only; sub-paths
# like /api/markets won't match this pattern.
@app.get("/{filename}")
def serve_root_static(filename: str):
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=404, detail="not found")
    candidate = PROJECT_DIR / filename
    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)
    raise HTTPException(status_code=404, detail=f"{filename} not found")
