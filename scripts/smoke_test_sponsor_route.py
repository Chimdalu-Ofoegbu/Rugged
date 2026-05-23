"""Rugged · smoke test for POST /api/paymaster/sponsor.

End-to-end check that the FastAPI route signs sponsorship blobs the
on-chain RuggedPaymaster accepts.

  1. Pick the most recently created market via factory.marketCount.
  2. Build a placeBet calldata for that market.
  3. POST the unsigned UserOp to /api/paymaster/sponsor via Starlette
     TestClient (no real server needed).
  4. Splice the returned paymasterAndData into the UserOp.
  5. eth_call paymaster.validatePaymasterUserOp from EntryPoint —
     expect sig_flag == 0 (accepted).
  6. Negative control: re-POST with a callData targeting a bogus
     address; expect 403.

Run:
    uv run python -m scripts.smoke_test_sponsor_route
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=True)

from eth_abi import encode as abi_encode  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.main import app  # noqa: E402
from chain.factory import _factory_contract, _w3_client  # noqa: E402
from scripts.smoke_test_paymaster import (  # noqa: E402
    EXECUTE_SELECTOR,
    PLACE_BET_SELECTOR,
    _build_place_bet_calldata,
    _call_validate,
)


def section(title: str) -> None:
    print()
    print("=" * 64)
    print(f"  {title}")
    print("=" * 64)


def _latest_market_address() -> str:
    factory = _factory_contract()
    count = factory.functions.marketCount().call()
    if count == 0:
        raise RuntimeError("no markets exist on-chain — run smoke_test_paymaster first")
    return factory.functions.getMarket(count - 1).call()


def _unsigned_userop_json(*, sender: str, call_data: bytes) -> dict:
    account_gas_limits = (100_000).to_bytes(16, "big") + (100_000).to_bytes(16, "big")
    gas_fees = (1_000_000_000).to_bytes(16, "big") + (1_000_000_000).to_bytes(16, "big")
    return {
        "sender": sender,
        "nonce": "0x0",
        "initCode": "0x",
        "callData": "0x" + call_data.hex(),
        "accountGasLimits": "0x" + account_gas_limits.hex(),
        "preVerificationGas": "0x" + (50_000).to_bytes(4, "big").hex().lstrip("0") or "0x0",
        "gasFees": "0x" + gas_fees.hex(),
        "paymasterAndData": "0x",
        "signature": "0x",
    }


def main() -> int:
    required = [
        "PAYMASTER_ADDRESS", "ENTRYPOINT_ADDRESS",
        "PAYMASTER_SIGNER_PRIVATE_KEY", "MARKET_FACTORY_ADDRESS",
        "USDC_ADDRESS", "ARC_RPC_URL", "ARC_CHAIN_ID",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    w3 = _w3_client()
    client = TestClient(app)
    chain_id = w3.eth.chain_id
    paymaster_addr = w3.to_checksum_address(os.environ["PAYMASTER_ADDRESS"])
    entrypoint_addr = w3.to_checksum_address(os.environ["ENTRYPOINT_ADDRESS"])

    section("Step 1 — /api/paymaster/info")
    r = client.get("/api/paymaster/info")
    r.raise_for_status()
    print(r.json())

    section("Step 2 — pick latest market + build placeBet calldata")
    market = _latest_market_address()
    print(f"  market           : {market}")
    sender = w3.to_checksum_address("0x" + "11" * 20)
    call_data = _build_place_bet_calldata(market, is_yes=True, amount_micro_usdc=1_000_000)
    print(f"  callData length  : {len(call_data)} bytes")

    section("Step 3 — POST /api/paymaster/sponsor (in-scope placeBet)")
    userop = _unsigned_userop_json(sender=sender, call_data=call_data)
    res = client.post(
        "/api/paymaster/sponsor",
        json={"userOp": userop, "wallet": sender, "chainId": chain_id},
    )
    print(f"  HTTP {res.status_code}: {res.text[:400]}")
    res.raise_for_status()
    payload = res.json()
    paymaster_and_data = bytes.fromhex(payload["paymasterAndData"][2:])
    assert len(paymaster_and_data) == 20 + 16 + 16 + 64 + 65, (
        f"unexpected paymasterAndData length {len(paymaster_and_data)}"
    )
    print(f"  [OK] sponsor returned scope={payload['scope']} validUntil={payload['validUntil']}")

    section("Step 4 — eth_call paymaster.validatePaymasterUserOp")
    context, validation_data = _call_validate(
        paymaster_addr=paymaster_addr,
        entrypoint_addr=entrypoint_addr,
        sender=sender,
        nonce=0,
        call_data=call_data,
        paymaster_and_data=paymaster_and_data,
    )
    sig_flag = validation_data & ((1 << 160) - 1)
    print(f"  context          : {context.hex() if context else '(empty)'}")
    print(f"  sig_flag         : {sig_flag}  (0 = OK, 1 = SIG_VALIDATION_FAILED)")
    if sig_flag != 0:
        raise AssertionError(f"on-chain validation rejected sponsorship: sig_flag={sig_flag}")
    print("  [OK] on-chain paymaster accepted the route-signed sponsorship")

    section("Step 5 -- Negative control: out-of-scope target -> 403")
    bogus_target = w3.to_checksum_address("0x" + "ab" * 20)
    inner_call = PLACE_BET_SELECTOR + b"\x00" * 31 + b"\x01" + (1_000_000).to_bytes(32, "big")
    exec_args = abi_encode(["address", "uint256", "bytes"], [bogus_target, 0, inner_call])
    bogus_call_data = EXECUTE_SELECTOR + exec_args
    bogus_userop = _unsigned_userop_json(sender=sender, call_data=bogus_call_data)
    res = client.post(
        "/api/paymaster/sponsor",
        json={"userOp": bogus_userop, "wallet": sender, "chainId": chain_id},
    )
    print(f"  HTTP {res.status_code}: {res.text[:200]}")
    if res.status_code != 403:
        raise AssertionError(f"expected 403, got {res.status_code}")
    print("  [OK] sponsor route refused out-of-scope target")

    section("SUMMARY")
    print("  /api/paymaster/sponsor  : [OK] signs in-scope, rejects out-of-scope")
    print("  on-chain validation     : [OK] route-signed sponsorship accepted")
    print()
    print("  Phase 4 done. Next: bundler (Phase 5).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
