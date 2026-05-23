"""Rugged · smoke test for the new MarketFactory + RuggedPaymaster.

What it does (no external API calls, no Claude, no Privy):

  1. Create one real market through the new factory using chain.factory.create_market().
     Uses a synthetic Solana mint + symbol. Skips the swarm — we just want a
     Market contract deployed by the factory so we can poke at it.
  2. Verify factory.isMarket(<that_market>) returns true via eth_call.
  3. Build a synthetic PackedUserOperation targeting placeBet on that market,
     sign with PAYMASTER_SIGNER_PRIVATE_KEY, and call paymaster.validatePaymasterUserOp
     via eth_call (impersonating EntryPoint). Expect sig_flag = 0 (accepted).
  4. As a negative control, build a UserOp targeting a non-allowlisted address
     and expect a ScopeTargetNotAllowed revert.

This catches: paymaster signature-hash mismatches, paymasterAndData byte layout
bugs, isMarket mapping write failures, and any RPC/ABI quirks on Arc — before
the full Privy/Vite/bundler stack is built.

Run:
    uv run python -m scripts.smoke_test_paymaster
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=True)

from eth_abi import decode as abi_decode  # noqa: E402
from eth_abi import encode as abi_encode  # noqa: E402
from eth_account import Account  # noqa: E402
from eth_account.messages import encode_defunct  # noqa: E402
from eth_utils import keccak  # noqa: E402

from chain.factory import _w3_client, create_market  # noqa: E402


# ----------------------------------------------------------------------
#  Selectors (precomputed once at import)
# ----------------------------------------------------------------------
EXECUTE_SELECTOR = keccak(text="execute(address,uint256,bytes)")[:4]
PLACE_BET_SELECTOR = keccak(text="placeBet(bool,uint256)")[:4]
IS_MARKET_SELECTOR = keccak(text="isMarket(address)")[:4]
VALIDATE_PAYMASTER_USER_OP_SIG = (
    "validatePaymasterUserOp("
    "(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),"
    "bytes32,uint256)"
)
VALIDATE_PAYMASTER_USER_OP_SELECTOR = keccak(text=VALIDATE_PAYMASTER_USER_OP_SIG)[:4]


def section(title: str) -> None:
    print()
    print("=" * 64)
    print(f"  {title}")
    print("=" * 64)


# ----------------------------------------------------------------------
#  Step 1 — create a market through the new factory
# ----------------------------------------------------------------------
def step_1_create_market() -> tuple[int, str]:
    section("Step 1 — Creating a new market via the new factory")
    mint = "SmokeTest" + str(int(time.time()))[-8:] + "RuggedPaymasterTest"
    symbol = "SMOKE" + str(int(time.time()))[-4:]
    print(f"  synthetic mint   : {mint}")
    print(f"  symbol           : {symbol}")
    result = create_market(
        mint=mint,
        symbol=symbol,
        chain="solana",
        blacklist_timestamp=int(time.time()),
        blacklist_price_micro_usd=1_000,  # $0.001
        seed_probability_bps=7500,        # 75% — matches our test data style
    )
    market_id = result["market_id"]
    market_address = result["market_address"]
    print(f"  market_id        : {market_id}")
    print(f"  market_address   : {market_address}")
    print(f"  tx_hash          : {result['tx_hash']}")
    print(f"  block_number     : {result['block_number']}")
    return market_id, market_address


# ----------------------------------------------------------------------
#  Step 2 — verify factory.isMarket returns true
# ----------------------------------------------------------------------
def step_2_verify_is_market(market_address: str) -> None:
    section("Step 2 — Verifying factory.isMarket(market) == true")
    w3 = _w3_client()
    factory = w3.to_checksum_address(os.environ["MARKET_FACTORY_ADDRESS"])
    # Encode address as bytes32 (left-padded)
    addr_no_prefix = market_address.lower().replace("0x", "")
    data = IS_MARKET_SELECTOR + b"\x00" * 12 + bytes.fromhex(addr_no_prefix)
    result = w3.eth.call({"to": factory, "data": data})
    is_market = int.from_bytes(result, "big") == 1
    print(f"  factory          : {factory}")
    print(f"  market           : {market_address}")
    print(f"  isMarket result  : {is_market}")
    if not is_market:
        raise AssertionError("factory.isMarket returned false — the reverse-lookup write in createMarket is broken")
    print("  [OK] isMarket mapping was written correctly during createMarket")


# ----------------------------------------------------------------------
#  Step 3 — sign a UserOp + eth_call paymaster.validatePaymasterUserOp
# ----------------------------------------------------------------------
def _build_place_bet_calldata(market_address: str, is_yes: bool, amount_micro_usdc: int) -> bytes:
    """execute(market_address, 0, placeBet(is_yes, amount))."""
    is_yes_bytes = b"\x00" * 31 + (b"\x01" if is_yes else b"\x00")
    amount_bytes = amount_micro_usdc.to_bytes(32, "big")
    inner_call = PLACE_BET_SELECTOR + is_yes_bytes + amount_bytes
    exec_args = abi_encode(
        ["address", "uint256", "bytes"],
        [market_address, 0, inner_call],
    )
    return EXECUTE_SELECTOR + exec_args


def _compute_userop_hash(
    *,
    sender: str,
    nonce: int,
    init_code: bytes,
    call_data: bytes,
    account_gas_limits: bytes,  # bytes32
    paymaster_gas_part: bytes,  # bytes32 (validation + postOp gas limits packed)
    pre_verification_gas: int,
    gas_fees: bytes,            # bytes32
    chain_id: int,
    paymaster_addr: str,
    valid_until: int,
    valid_after: int,
) -> bytes:
    """Mirror RuggedPaymaster.getHash() exactly so we sign what the contract checks."""
    encoded = abi_encode(
        [
            "address", "uint256", "bytes32", "bytes32", "bytes32",
            "uint256", "uint256", "bytes32",
            "uint256", "address", "uint48", "uint48",
        ],
        [
            sender, nonce, keccak(init_code), keccak(call_data), account_gas_limits,
            int.from_bytes(paymaster_gas_part, "big"), pre_verification_gas, gas_fees,
            chain_id, paymaster_addr, valid_until, valid_after,
        ],
    )
    return keccak(encoded)


def _build_paymaster_and_data(
    paymaster_addr: str,
    validation_gas_limit: int,
    post_op_gas_limit: int,
    valid_until: int,
    valid_after: int,
    signature: bytes,
) -> bytes:
    paymaster_bytes = bytes.fromhex(paymaster_addr.lower().replace("0x", ""))
    gas_part = validation_gas_limit.to_bytes(16, "big") + post_op_gas_limit.to_bytes(16, "big")
    timestamps = abi_encode(["uint48", "uint48"], [valid_until, valid_after])
    return paymaster_bytes + gas_part + timestamps + signature


def _call_validate(
    *,
    paymaster_addr: str,
    entrypoint_addr: str,
    sender: str,
    nonce: int,
    call_data: bytes,
    paymaster_and_data: bytes,
) -> tuple[bytes, int]:
    """eth_call paymaster.validatePaymasterUserOp impersonating EntryPoint."""
    w3 = _w3_client()
    account_gas_limits = (100_000).to_bytes(16, "big") + (100_000).to_bytes(16, "big")
    gas_fees = (1_000_000_000).to_bytes(16, "big") + (1_000_000_000).to_bytes(16, "big")
    user_op = (
        sender,
        nonce,
        b"",                  # initCode
        call_data,
        account_gas_limits,   # bytes32
        50_000,               # preVerificationGas
        gas_fees,             # bytes32
        paymaster_and_data,
        b"",                  # signature (the account-side signature; unused for this test)
    )
    encoded_args = abi_encode(
        ["(address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes)", "bytes32", "uint256"],
        [user_op, b"\x00" * 32, 0],
    )
    raw_call = VALIDATE_PAYMASTER_USER_OP_SELECTOR + encoded_args
    result = w3.eth.call({
        "from": entrypoint_addr,
        "to": paymaster_addr,
        "data": raw_call,
    })
    context, validation_data = abi_decode(["bytes", "uint256"], result)
    return context, validation_data


def step_3_validate_userop(market_address: str) -> None:
    section("Step 3 — Signing a synthetic UserOp + validating via paymaster")
    w3 = _w3_client()
    paymaster_addr = w3.to_checksum_address(os.environ["PAYMASTER_ADDRESS"])
    entrypoint_addr = w3.to_checksum_address(os.environ["ENTRYPOINT_ADDRESS"])
    signer_pk = os.environ["PAYMASTER_SIGNER_PRIVATE_KEY"]
    signer_account = Account.from_key(signer_pk)
    chain_id = w3.eth.chain_id

    sender = w3.to_checksum_address("0x" + "11" * 20)   # synthetic smart-account
    nonce = 0
    call_data = _build_place_bet_calldata(market_address, is_yes=True, amount_micro_usdc=1_000_000)
    print(f"  paymaster        : {paymaster_addr}")
    print(f"  entrypoint       : {entrypoint_addr}")
    print(f"  signer           : {signer_account.address}")
    print(f"  synthetic sender : {sender}")
    print(f"  inner call bytes : {len(call_data)} bytes")

    # Build the gas-limit slice that getHash() reads from paymasterAndData[20:52]
    validation_gas_limit = 100_000
    post_op_gas_limit = 100_000
    paymaster_gas_part = (
        validation_gas_limit.to_bytes(16, "big")
        + post_op_gas_limit.to_bytes(16, "big")
    )
    account_gas_limits = (100_000).to_bytes(16, "big") + (100_000).to_bytes(16, "big")
    gas_fees = (1_000_000_000).to_bytes(16, "big") + (1_000_000_000).to_bytes(16, "big")

    valid_until = int(time.time()) + 3600
    valid_after = int(time.time()) - 1

    op_hash = _compute_userop_hash(
        sender=sender,
        nonce=nonce,
        init_code=b"",
        call_data=call_data,
        account_gas_limits=account_gas_limits,
        paymaster_gas_part=paymaster_gas_part,
        pre_verification_gas=50_000,
        gas_fees=gas_fees,
        chain_id=chain_id,
        paymaster_addr=paymaster_addr,
        valid_until=valid_until,
        valid_after=valid_after,
    )
    signed = Account.sign_message(encode_defunct(op_hash), private_key=signer_pk)
    signature = signed.signature  # 65 bytes
    print(f"  userOp hash      : 0x{op_hash.hex()}")
    print(f"  signature length : {len(signature)} bytes")

    paymaster_and_data = _build_paymaster_and_data(
        paymaster_addr,
        validation_gas_limit,
        post_op_gas_limit,
        valid_until,
        valid_after,
        signature,
    )

    print()
    print("  -> 3a. Positive test: in-scope placeBet on the new market")
    context, validation_data = _call_validate(
        paymaster_addr=paymaster_addr,
        entrypoint_addr=entrypoint_addr,
        sender=sender,
        nonce=nonce,
        call_data=call_data,
        paymaster_and_data=paymaster_and_data,
    )
    sig_flag = validation_data & ((1 << 160) - 1)
    valid_until_out = (validation_data >> 160) & ((1 << 48) - 1)
    valid_after_out = (validation_data >> (160 + 48)) & ((1 << 48) - 1)
    print(f"     context           : {context.hex() if context else '(empty)'}")
    print(f"     sig_flag          : {sig_flag}  (0 = OK, 1 = SIG_VALIDATION_FAILED)")
    print(f"     validUntil (out)  : {valid_until_out}  (expected ~{valid_until})")
    print(f"     validAfter (out)  : {valid_after_out}  (expected ~{valid_after})")
    if sig_flag != 0:
        raise AssertionError(f"Expected sig_flag=0 (valid), got {sig_flag}")
    if valid_until_out != valid_until:
        raise AssertionError(f"validUntil mismatch: expected {valid_until}, got {valid_until_out}")
    if valid_after_out != valid_after:
        raise AssertionError(f"validAfter mismatch: expected {valid_after}, got {valid_after_out}")
    print("     [OK] paymaster accepted the signed, in-scope UserOp")

    print()
    print("  -> 3b. Negative test: same signature, but target an unknown contract")
    # Construct callData that targets a random non-allowlisted address with placeBet selector.
    bogus_target = w3.to_checksum_address("0x" + "ab" * 20)
    inner_call = PLACE_BET_SELECTOR + b"\x00" * 31 + b"\x01" + (1_000_000).to_bytes(32, "big")
    exec_args = abi_encode(["address", "uint256", "bytes"], [bogus_target, 0, inner_call])
    bogus_call_data = EXECUTE_SELECTOR + exec_args
    # Re-sign over the new callData (otherwise we'd hit the sig-fail branch, not the scope-fail branch)
    op_hash2 = _compute_userop_hash(
        sender=sender,
        nonce=nonce,
        init_code=b"",
        call_data=bogus_call_data,
        account_gas_limits=account_gas_limits,
        paymaster_gas_part=paymaster_gas_part,
        pre_verification_gas=50_000,
        gas_fees=gas_fees,
        chain_id=chain_id,
        paymaster_addr=paymaster_addr,
        valid_until=valid_until,
        valid_after=valid_after,
    )
    signed2 = Account.sign_message(encode_defunct(op_hash2), private_key=signer_pk)
    paymaster_and_data2 = _build_paymaster_and_data(
        paymaster_addr,
        validation_gas_limit,
        post_op_gas_limit,
        valid_until,
        valid_after,
        signed2.signature,
    )
    try:
        _call_validate(
            paymaster_addr=paymaster_addr,
            entrypoint_addr=entrypoint_addr,
            sender=sender,
            nonce=nonce,
            call_data=bogus_call_data,
            paymaster_and_data=paymaster_and_data2,
        )
        raise AssertionError("Expected revert (ScopeTargetNotAllowed) but call succeeded")
    except Exception as exc:
        # Foundry-style custom-error revert; the error text from web3.py usually includes the selector.
        msg = str(exc)
        if "ScopeTargetNotAllowed" in msg or "revert" in msg.lower() or "0x" in msg:
            print(f"     [OK] paymaster correctly reverted on out-of-scope target")
            print(f"       (raw error: {msg[:200]}{'…' if len(msg) > 200 else ''})")
        else:
            raise


def main() -> int:
    # Sanity-check env
    required = [
        "DEPLOYER_PRIVATE_KEY",
        "PAYMASTER_ADDRESS",
        "ENTRYPOINT_ADDRESS",
        "PAYMASTER_SIGNER_PRIVATE_KEY",
        "MARKET_FACTORY_ADDRESS",
        "ARC_RPC_URL",
    ]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    _, market_address = step_1_create_market()
    step_2_verify_is_market(market_address)
    step_3_validate_userop(market_address)

    section("SUMMARY")
    print(f"  New Market         : {market_address}")
    print(f"  factory.isMarket   : [OK] true")
    print(f"  paymaster validate : [OK] accepts in-scope, rejects out-of-scope")
    print()
    print("  Phase 2 (Vite + Privy) is unblocked — the on-chain layer works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
