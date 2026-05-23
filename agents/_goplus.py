"""Rugged · GoPlus client — signed-auth API wrapper.

GoPlus does NOT use a static API key. Auth flow:
    1. sign = sha1(app_key + time + app_secret)
    2. POST /api/v1/token with {app_key, time, sign}  →  {access_token}
    3. Use Bearer access_token on subsequent requests.

We cache the access_token in-process until it nears expiry.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time as _time
from typing import Any

import httpx

log = logging.getLogger("agents.goplus")

GOPLUS_BASE = "https://api.gopluslabs.io"
TOKEN_TTL_SECONDS = 30 * 60  # GoPlus tokens last ~1h; refresh proactively at 30m


# Module-level token cache.
_token: str | None = None
_token_expiry: float = 0.0


class GoPlusError(RuntimeError):
    pass


def _credentials() -> tuple[str, str]:
    app_key = os.environ.get("GOPLUS_APP_KEY")
    app_secret = os.environ.get("GOPLUS_APP_SECRET")
    if not app_key or not app_secret:
        raise GoPlusError("GOPLUS_APP_KEY / GOPLUS_APP_SECRET not set")
    return app_key, app_secret


async def _refresh_token(client: httpx.AsyncClient) -> str:
    """Mint a fresh GoPlus access token via the signed-auth flow."""
    global _token, _token_expiry
    app_key, app_secret = _credentials()
    ts = str(int(_time.time()))
    raw = f"{app_key}{ts}{app_secret}".encode()
    sign = hashlib.sha1(raw).hexdigest()
    resp = await client.post(
        f"{GOPLUS_BASE}/api/v1/token",
        json={"app_key": app_key, "time": int(ts), "sign": sign},
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    token = (body.get("result") or {}).get("access_token") or body.get("access_token")
    if not token:
        raise GoPlusError(f"no access_token in response: {body}")
    _token = token
    _token_expiry = _time.time() + TOKEN_TTL_SECONDS
    log.info("goplus: minted new access token (cached %ds)", TOKEN_TTL_SECONDS)
    return token


async def _get_token(client: httpx.AsyncClient) -> str:
    if _token and _time.time() < _token_expiry:
        return _token
    return await _refresh_token(client)


# ----------------------------------------------------------------------
#  Solana token security — Agent A's primary data source.
# ----------------------------------------------------------------------
async def solana_token_security(mint: str) -> dict[str, Any]:
    """Fetch GoPlus's Solana token-security report for a mint.

    The Solana endpoint is publicly available (no bearer required). We
    still mint the auth token at startup to validate the credentials and
    benefit from higher rate limits when GoPlus rolls out auth-gating.

    Returns the parsed `result` block (dict). Raises GoPlusError on failure.
    Empty `{}` means GoPlus has no data for this mint — caller decides
    whether to fall back.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        url = f"{GOPLUS_BASE}/api/v1/solana/token_security"
        resp = await client.get(url, params={"contract_addresses": mint})
        resp.raise_for_status()
        body = resp.json()
    if body.get("code") not in (1, 0):  # GoPlus uses code=1 for OK
        raise GoPlusError(f"goplus error code={body.get('code')} msg={body.get('message')}")
    result = body.get("result") or {}
    # GoPlus returns {mint_lowercase: {...}} — pull the single entry.
    if isinstance(result, dict) and result:
        # Try exact match first, then case-insensitive
        if mint in result:
            return result[mint]
        for k, v in result.items():
            if k.lower() == mint.lower():
                return v
    return {}
