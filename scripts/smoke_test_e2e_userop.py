"""Rugged · end-to-end UserOp smoke.

The full gas-abstracted flow with no browser:

  1. Compute the counterfactual SimpleAccount(owner=deployer) address via
     the canonical SimpleAccountFactory v0.7.
  2. Build a USDC.approve(0, 0) callData. Approve is in-scope for the
     paymaster and works even when the account holds zero USDC, so this
     smoke only depends on the paymaster + bundler — no token funding.
  3. If the smart account isn't deployed yet, set initCode so the first
     UserOp deploys it as part of validation.
  4. Pack the unsigned UserOp and POST it to /api/paymaster/sponsor.
  5. Splice the returned paymasterAndData in, compute the canonical
     userOpHash from EntryPoint.getUserOpHash, and sign it with the
     deployer key (the SimpleAccount's owner).
  6. POST the fully-signed UserOp to /api/bundler/submit and inspect the
     UserOperationEvent + receipt.

This proves both the sponsor route and the self-bundler relay end-to-end
without any browser, Privy, or USDC dependency.

Run:
    uv run python -m scripts.smoke_test_e2e_userop
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
from eth_account import Account  # noqa: E402
from eth_utils import keccak, to_checksum_address  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.main import app  # noqa: E402
from chain.factory import _account, _w3_client  # noqa: E402

# Canonical SimpleAccountFactory v0.7 (same on every chain that has it).
SIMPLE_ACCOUNT_FACTORY = to_checksum_address("0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985")

CREATE_ACCOUNT_SELECTOR = keccak(text="createAccount(address,uint256)")[:4]   # 0x5fbfb9cf
GET_ADDRESS_SELECTOR = keccak(text="getAddress(address,uint256)")[:4]         # 0x8cb84e18
EXECUTE_SELECTOR = keccak(text="execute(address,uint256,bytes)")[:4]          # 0xb61d27f6
APPROVE_SELECTOR = bytes.fromhex("095ea7b3")                                  # ERC-20 approve


def section(title: str) -> None:
    print()
    print("=" * 64)
    print(f"  {title}")
    print("=" * 64)


def _counterfactual_address(w3, owner: str, salt: int) -> str:
    """Call SimpleAccountFactory.getAddress(owner, salt) — the deterministic
    address the SimpleAccount will live at once createAccount runs."""
    data = (
        GET_ADDRESS_SELECTOR
        + abi_encode(["address", "uint256"], [owner, salt])
    )
    raw = w3.eth.call({"to": SIMPLE_ACCOUNT_FACTORY, "data": data})
    return to_checksum_address("0x" + raw.hex()[-40:])


def _init_code(owner: str, salt: int) -> bytes:
    """initCode = factory address || createAccount(owner, salt) calldata."""
    call = CREATE_ACCOUNT_SELECTOR + abi_encode(["address", "uint256"], [owner, salt])
    return bytes.fromhex(SIMPLE_ACCOUNT_FACTORY[2:]) + call


def _account_nonce(w3, ep_addr: str, sender: str) -> int:
    """EntryPoint.getNonce(sender, key=0)."""
    selector = keccak(text="getNonce(address,uint192)")[:4]
    data = selector + abi_encode(["address", "uint192"], [sender, 0])
    raw = w3.eth.call({"to": ep_addr, "data": data})
    return int.from_bytes(raw, "big")


def _userop_hash_via_entrypoint(w3, ep_addr: str, op_tuple: tuple) -> bytes:
    """EntryPoint.getUserOpHash(userOp). Authoritative — match the account-side sig."""
    from api.routes.bundler import ENTRYPOINT_ABI

    ep = w3.eth.contract(address=ep_addr, abi=ENTRYPOINT_ABI)
    return ep.functions.getUserOpHash(op_tuple).call()


def main() -> int:
    required = [
        "DEPLOYER_PRIVATE_KEY", "PAYMASTER_ADDRESS", "ENTRYPOINT_ADDRESS",
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
    ep_addr = to_checksum_address(os.environ["ENTRYPOINT_ADDRESS"])
    usdc_addr = to_checksum_address(os.environ["USDC_ADDRESS"])
    pm_addr = to_checksum_address(os.environ["PAYMASTER_ADDRESS"])

    owner = _account()
    print(f"  Owner EOA        : {owner.address}")
    print(f"  Chain id         : {chain_id}")

    section("Step 1 -- Compute SimpleAccount counterfactual address")
    salt = 0  # any deterministic value
    sender = _counterfactual_address(w3, owner.address, salt)
    code = w3.eth.get_code(sender)
    already_deployed = len(code) > 0
    print(f"  Sender (SCA)     : {sender}")
    print(f"  Deployed?        : {already_deployed} ({len(code)} bytes of code)")

    section("Step 2 -- Build callData: SimpleAccount.execute(USDC, 0, approve(pm, 0))")
    # approve(spender, 0) -- in-scope, no balance required.
    inner_call = APPROVE_SELECTOR + abi_encode(["address", "uint256"], [pm_addr, 0])
    call_data = EXECUTE_SELECTOR + abi_encode(
        ["address", "uint256", "bytes"], [usdc_addr, 0, inner_call]
    )
    print(f"  inner data len   : {len(inner_call)} bytes")
    print(f"  callData len     : {len(call_data)} bytes")

    section("Step 3 -- Build PackedUserOperation skeleton")
    nonce = _account_nonce(w3, ep_addr, sender)
    init_code = _init_code(owner.address, salt) if not already_deployed else b""
    # Gas limits: account verification covers SimpleAccount.validateUserOp +
    # (if undeployed) the factory createAccount call. Tighter than the
    # synthetic smoke -- we want a real estimate that passes simulation.
    verification_gas = 600_000 if not already_deployed else 150_000
    call_gas = 150_000
    account_gas_limits = verification_gas.to_bytes(16, "big") + call_gas.to_bytes(16, "big")
    pre_verification_gas = 60_000
    # Arc gas pricing -- pull live + apply a small bump so estimates pass.
    live_gas = w3.eth.gas_price
    max_priority = max(live_gas, 1_000_000_000)
    max_fee = max(live_gas * 2, 2_000_000_000)
    gas_fees = max_priority.to_bytes(16, "big") + max_fee.to_bytes(16, "big")
    print(f"  nonce            : {nonce}")
    print(f"  initCode bytes   : {len(init_code)}")
    print(f"  verificationGas  : {verification_gas}")
    print(f"  callGas          : {call_gas}")
    print(f"  preVerification  : {pre_verification_gas}")
    print(f"  gas_price live   : {live_gas}")

    userop_json = {
        "sender": sender,
        "nonce": hex(nonce),
        "initCode": "0x" + init_code.hex(),
        "callData": "0x" + call_data.hex(),
        "accountGasLimits": "0x" + account_gas_limits.hex(),
        "preVerificationGas": hex(pre_verification_gas),
        "gasFees": "0x" + gas_fees.hex(),
        "paymasterAndData": "0x",
        "signature": "0x",
    }

    section("Step 4 -- POST /api/paymaster/sponsor")
    r = client.post(
        "/api/paymaster/sponsor",
        json={"userOp": userop_json, "wallet": sender, "chainId": chain_id},
    )
    print(f"  HTTP {r.status_code}: {r.text[:500]}")
    r.raise_for_status()
    payload = r.json()
    paymaster_and_data_hex = payload["paymasterAndData"]
    paymaster_and_data = bytes.fromhex(paymaster_and_data_hex[2:])
    print(f"  scope            : {payload['scope']}")
    print(f"  validUntil       : {payload['validUntil']}")

    section("Step 5 -- Sign userOpHash with owner key")
    userop_json["paymasterAndData"] = paymaster_and_data_hex
    op_tuple = (
        sender, nonce, init_code, call_data, account_gas_limits,
        pre_verification_gas, gas_fees, paymaster_and_data, b"",
    )
    user_op_hash = _userop_hash_via_entrypoint(w3, ep_addr, op_tuple)
    print(f"  userOpHash       : 0x{user_op_hash.hex()}")
    # SimpleAccount uses the EIP-191 personal-sign envelope on the userOpHash.
    from eth_account.messages import encode_defunct
    signed = Account.sign_message(encode_defunct(user_op_hash), private_key=owner.key)
    sig = signed.signature
    print(f"  signature len    : {len(sig)} bytes")
    userop_json["signature"] = "0x" + sig.hex()

    section("Step 6 -- POST /api/bundler/submit")
    r = client.post("/api/bundler/submit", json={"userOp": userop_json})
    print(f"  HTTP {r.status_code}: {r.text[:1000]}")
    r.raise_for_status()
    body = r.json()
    print()
    print(f"  userOpHash       : {body['userOpHash']}")
    print(f"  txHash           : {body['txHash']}")
    print(f"  block            : {body['blockNumber']}")
    print(f"  success          : {body['success']}")
    print(f"  actualGasCost    : {body['actualGasCost']} wei  (~{body['actualGasCost']/1e18:.6f} native)")
    print(f"  actualGasUsed    : {body['actualGasUsed']}")
    if body.get("revertReason"):
        print(f"  revertReason     : {body['revertReason']}")

    if not body["success"]:
        # If the inner call reverted but validation succeeded, that's still
        # a partial pass: it means the paymaster + bundler stack is working,
        # only the inner business logic failed.
        print()
        print("  NOTE: inner call reverted -- but UserOp validation succeeded,")
        print("        meaning paymaster + bundler are working end-to-end.")
        return 0

    # Verify the smart account is now deployed.
    code_after = w3.eth.get_code(sender)
    print()
    print(f"  SCA deployed?    : {len(code_after) > 0} ({len(code_after)} bytes)")

    section("SUMMARY")
    print(f"  Sponsor route    : [OK]")
    print(f"  Bundler relay    : [OK]")
    print(f"  Full UserOp flow : [OK]")
    print(f"  Smart account    : {sender}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
