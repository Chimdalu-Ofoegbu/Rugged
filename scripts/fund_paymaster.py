"""Rugged · fund the RuggedPaymaster's EntryPoint deposit.

Reads from .env:
    - DEPLOYER_PRIVATE_KEY   — the source of funds
    - PAYMASTER_ADDRESS      — the deployed paymaster
    - ENTRYPOINT_ADDRESS     — canonical v0.7 EntryPoint
    - ARC_RPC_URL            — Arc testnet RPC
    - ARC_CHAIN_ID           — Arc chain id (decimal)

Run:
    uv run python -m scripts.fund_paymaster              # default 0.1 ARC
    uv run python -m scripts.fund_paymaster 0.05         # custom amount
    uv run python -m scripts.fund_paymaster --check      # read-only: show current deposit + deployer balance

Why a script and not inline `python -c "..."`:
    PowerShell mangles backslash escapes (`\x00`) and multi-line single-quoted
    strings inside double-quoted -c arguments, leading to confusing failures.
    A file keeps the Python source intact.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=True)

from chain.factory import _account, _w3_client  # noqa: E402

DEPOSIT_SELECTOR = bytes.fromhex("d0e30db0")  # deposit()
BALANCE_OF_SELECTOR = bytes.fromhex("70a08231")  # balanceOf(address)


def _read_paymaster_deposit(w3, ep_addr: str, paymaster_addr: str) -> int:
    """Read EntryPoint.balanceOf(paymaster) — the current sponsorship pool."""
    paymaster_no_prefix = paymaster_addr.lower().replace("0x", "")
    call_data = BALANCE_OF_SELECTOR + b"\x00" * 12 + bytes.fromhex(paymaster_no_prefix)
    result = w3.eth.call({"to": ep_addr, "data": call_data})
    return int.from_bytes(result, "big")


def main(argv: list[str]) -> int:
    # Sanity-check required env
    required = ["DEPLOYER_PRIVATE_KEY", "PAYMASTER_ADDRESS", "ENTRYPOINT_ADDRESS", "ARC_RPC_URL", "ARC_CHAIN_ID"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"ERROR: missing env vars: {', '.join(missing)}", file=sys.stderr)
        return 1

    # Parse arg
    check_only = "--check" in argv
    amount_args = [a for a in argv if not a.startswith("--")]
    amount_ether = float(amount_args[0]) if amount_args else 0.1

    w3 = _w3_client()
    acct = _account()
    paymaster = w3.to_checksum_address(os.environ["PAYMASTER_ADDRESS"])
    ep = w3.to_checksum_address(os.environ["ENTRYPOINT_ADDRESS"])
    chain_id = int(os.environ["ARC_CHAIN_ID"])

    # Pre-flight: balances + state
    deployer_balance_wei = w3.eth.get_balance(acct.address)
    deployer_balance_eth = deployer_balance_wei / 1e18
    current_deposit_wei = _read_paymaster_deposit(w3, ep, paymaster)
    current_deposit_eth = current_deposit_wei / 1e18
    paymaster_code = w3.eth.get_code(paymaster)

    print("=== Pre-flight ===")
    print(f"  chain_id              : {chain_id}")
    print(f"  block                 : {w3.eth.block_number}")
    print(f"  deployer              : {acct.address}")
    print(f"  deployer balance      : {deployer_balance_eth:.6f} ARC")
    print(f"  paymaster             : {paymaster}")
    print(f"  paymaster code        : {len(paymaster_code) - 2} bytes ({'OK' if len(paymaster_code) > 2 else 'NO CONTRACT'})")
    print(f"  entrypoint            : {ep}")
    print(f"  current EP deposit    : {current_deposit_eth:.6f} ARC")
    print()

    if check_only:
        print("--check mode: no transaction sent.")
        return 0

    if len(paymaster_code) <= 2:
        print("ERROR: PAYMASTER_ADDRESS has no contract code on this chain.", file=sys.stderr)
        return 1

    value_wei = w3.to_wei(amount_ether, "ether")
    if deployer_balance_wei < value_wei * 2:  # rough buffer for gas
        print(
            f"ERROR: deployer has {deployer_balance_eth:.6f} ARC, asked to deposit {amount_ether} ARC.",
            file=sys.stderr,
        )
        print("       Need at least 2× the deposit amount for safety margin (deposit + gas).", file=sys.stderr)
        return 1

    # Build + send tx
    gas_price = w3.eth.gas_price
    tx = {
        "from": acct.address,
        "to": paymaster,
        "value": value_wei,
        "data": "0x" + DEPOSIT_SELECTOR.hex(),
        "gasPrice": gas_price,
        "nonce": w3.eth.get_transaction_count(acct.address),
        "chainId": chain_id,
    }
    # Estimate gas explicitly so we get a clear error if it would revert
    try:
        estimated_gas = w3.eth.estimate_gas(tx)
        tx["gas"] = int(estimated_gas * 1.2)
    except Exception as exc:
        print(f"ERROR: gas estimation reverted — {exc}", file=sys.stderr)
        print(
            "       This usually means the paymaster's deposit() function rejected the call. "
            "Check that PAYMASTER_ADDRESS is the verifying-paymaster (not some other contract).",
            file=sys.stderr,
        )
        return 1

    print(f"Sending {amount_ether} ARC to paymaster.deposit() …")
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction).hex()
    print(f"  tx hash: {tx_hash}")

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        print(f"ERROR: transaction reverted in block {receipt.blockNumber}", file=sys.stderr)
        return 1
    print(f"  confirmed in block {receipt.blockNumber} (gas used: {receipt.gasUsed})")
    print()

    new_deposit_wei = _read_paymaster_deposit(w3, ep, paymaster)
    new_deposit_eth = new_deposit_wei / 1e18
    delta_eth = (new_deposit_wei - current_deposit_wei) / 1e18
    print("=== After ===")
    print(f"  paymaster EP deposit  : {new_deposit_eth:.6f} ARC  (Δ +{delta_eth:.6f})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
