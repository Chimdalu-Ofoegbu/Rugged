"""Rugged · self-bundler route.

POST /api/bundler/submit

Why a self-bundler (not Skandha):
  Arc testnet is not part of any public bundler operator's network. Running
  a local Skandha is feasible but heavy (Node service + RPC config + a
  local p2p mesh that nobody else can join). For our gas-sponsored UserOps,
  the only thing a bundler *has* to do is call EntryPoint.handleOps() on
  our behalf. We do that directly from the funded deployer key — same
  effect, zero infra dependency. The paymaster's on-chain scope check
  is the real defense; the bundler is just a relay.

Flow:
  1. Frontend builds + signs a UserOp, calls /api/paymaster/sponsor to
     get paymasterAndData, splices it in, signs the final UserOp hash
     with the smart-account owner key (Privy embedded wallet), and POSTs
     the fully-signed UserOp here.
  2. We compute the canonical userOpHash via EntryPoint.getUserOpHash()
     for the response.
  3. We submit EntryPoint.handleOps([userOp], beneficiary=deployer) as
     a normal EOA transaction.
  4. We wait for the tx receipt, parse the UserOperationEvent to confirm
     success, and return both the tx hash and userOpHash.

If the paymaster validation reverts on-chain, handleOps reverts — we
surface the revert reason to the caller.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from eth_account import Account
from eth_utils import keccak, to_checksum_address
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from api.routes.paymaster import PackedUserOpJson

log = logging.getLogger("api.bundler")

router = APIRouter(prefix="/api/bundler", tags=["bundler"])


# ----------------------------------------------------------------------
#  EntryPoint v0.7 — minimal ABI fragment
# ----------------------------------------------------------------------
ENTRYPOINT_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "handleOps",
        "stateMutability": "nonpayable",
        "inputs": [
            {
                "name": "ops",
                "type": "tuple[]",
                "components": [
                    {"name": "sender", "type": "address"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "initCode", "type": "bytes"},
                    {"name": "callData", "type": "bytes"},
                    {"name": "accountGasLimits", "type": "bytes32"},
                    {"name": "preVerificationGas", "type": "uint256"},
                    {"name": "gasFees", "type": "bytes32"},
                    {"name": "paymasterAndData", "type": "bytes"},
                    {"name": "signature", "type": "bytes"},
                ],
            },
            {"name": "beneficiary", "type": "address"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "getUserOpHash",
        "stateMutability": "view",
        "inputs": [
            {
                "name": "userOp",
                "type": "tuple",
                "components": [
                    {"name": "sender", "type": "address"},
                    {"name": "nonce", "type": "uint256"},
                    {"name": "initCode", "type": "bytes"},
                    {"name": "callData", "type": "bytes"},
                    {"name": "accountGasLimits", "type": "bytes32"},
                    {"name": "preVerificationGas", "type": "uint256"},
                    {"name": "gasFees", "type": "bytes32"},
                    {"name": "paymasterAndData", "type": "bytes"},
                    {"name": "signature", "type": "bytes"},
                ],
            }
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
    {
        "type": "event",
        "name": "UserOperationEvent",
        "anonymous": False,
        "inputs": [
            {"name": "userOpHash", "type": "bytes32", "indexed": True},
            {"name": "sender", "type": "address", "indexed": True},
            {"name": "paymaster", "type": "address", "indexed": True},
            {"name": "nonce", "type": "uint256", "indexed": False},
            {"name": "success", "type": "bool", "indexed": False},
            {"name": "actualGasCost", "type": "uint256", "indexed": False},
            {"name": "actualGasUsed", "type": "uint256", "indexed": False},
        ],
    },
    {
        "type": "event",
        "name": "UserOperationRevertReason",
        "anonymous": False,
        "inputs": [
            {"name": "userOpHash", "type": "bytes32", "indexed": True},
            {"name": "sender", "type": "address", "indexed": True},
            {"name": "nonce", "type": "uint256", "indexed": False},
            {"name": "revertReason", "type": "bytes", "indexed": False},
        ],
    },
]

# Gas overhead for the outer handleOps tx on top of the UserOp's own limits.
HANDLE_OPS_OVERHEAD = 100_000


# ----------------------------------------------------------------------
#  Request / response models
# ----------------------------------------------------------------------
class SubmitRequest(BaseModel):
    userOp: PackedUserOpJson


class SubmitResponse(BaseModel):
    userOpHash: str
    txHash: str
    blockNumber: int
    success: bool
    actualGasCost: int
    actualGasUsed: int
    revertReason: str | None = None


# ----------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------
def _h2b(s: str, *, field: str) -> bytes:
    if not s:
        return b""
    if not s.startswith("0x"):
        raise HTTPException(status_code=400, detail=f"{field}: must be 0x-hex")
    try:
        return bytes.fromhex(s[2:])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field}: invalid hex")


def _h2i(s: str, *, field: str) -> int:
    if not s:
        return 0
    if not s.startswith("0x"):
        raise HTTPException(status_code=400, detail=f"{field}: must be 0x-hex")
    try:
        return int(s, 16)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field}: invalid hex int")


def _userop_tuple(op: PackedUserOpJson) -> tuple:
    """Convert the JSON wire format to the web3 tuple EntryPoint expects."""
    sender = to_checksum_address(op.sender)
    account_gas_limits = _h2b(op.accountGasLimits, field="accountGasLimits")
    gas_fees = _h2b(op.gasFees, field="gasFees")
    if len(account_gas_limits) != 32:
        raise HTTPException(status_code=400, detail="accountGasLimits must be 32 bytes")
    if len(gas_fees) != 32:
        raise HTTPException(status_code=400, detail="gasFees must be 32 bytes")
    return (
        sender,
        _h2i(op.nonce, field="nonce"),
        _h2b(op.initCode, field="initCode"),
        _h2b(op.callData, field="callData"),
        account_gas_limits,
        _h2i(op.preVerificationGas, field="preVerificationGas"),
        gas_fees,
        _h2b(op.paymasterAndData, field="paymasterAndData"),
        _h2b(op.signature, field="signature"),
    )


# ----------------------------------------------------------------------
#  Route
# ----------------------------------------------------------------------
@router.post("/submit", response_model=SubmitResponse)
def submit(req: SubmitRequest) -> SubmitResponse:
    """Submit a fully-signed UserOp through EntryPoint.handleOps."""
    from chain.factory import _w3_client, _account  # lazy

    ep_addr = os.environ.get("ENTRYPOINT_ADDRESS")
    if not ep_addr:
        raise HTTPException(status_code=500, detail="ENTRYPOINT_ADDRESS not configured")

    w3 = _w3_client()
    relayer = _account()  # the funded deployer key acts as the relayer
    entrypoint = w3.eth.contract(address=to_checksum_address(ep_addr), abi=ENTRYPOINT_ABI)

    op_tuple = _userop_tuple(req.userOp)

    # Canonical userOpHash (matches what the smart account signed).
    try:
        user_op_hash = entrypoint.functions.getUserOpHash(op_tuple).call()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"getUserOpHash failed: {exc}")
    user_op_hash_hex = "0x" + user_op_hash.hex()

    # Build the handleOps tx.
    fn = entrypoint.functions.handleOps([op_tuple], relayer.address)
    try:
        gas_estimate = int(fn.estimate_gas({"from": relayer.address}) * 1.25)
    except Exception as exc:  # noqa: BLE001
        # Most likely a paymaster/account validation revert. Surface the chain reason.
        raise HTTPException(status_code=400, detail=f"handleOps estimate_gas reverted: {exc}")

    nonce = w3.eth.get_transaction_count(relayer.address)
    tx = fn.build_transaction({
        "from": relayer.address,
        "nonce": nonce,
        "gas": gas_estimate + HANDLE_OPS_OVERHEAD,
        "gasPrice": w3.eth.gas_price,
        "chainId": int(os.environ.get("ARC_CHAIN_ID", "5042002")),
    })
    signed = Account.sign_transaction(tx, private_key=relayer.key)
    try:
        tx_hash_bytes = w3.eth.send_raw_transaction(signed.raw_transaction)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"send_raw_transaction failed: {exc}")
    tx_hash = "0x" + tx_hash_bytes.hex()
    log.info("handleOps submitted: tx=%s userOpHash=%s", tx_hash, user_op_hash_hex)

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    if receipt.status != 1:
        raise HTTPException(status_code=502, detail=f"handleOps tx reverted: {tx_hash}")

    # Parse UserOperationEvent + UserOperationRevertReason from receipt.
    success = False
    actual_gas_cost = 0
    actual_gas_used = 0
    revert_reason: str | None = None
    for log_entry in receipt.logs:
        try:
            evt = entrypoint.events.UserOperationEvent().process_log(log_entry)
            success = bool(evt["args"]["success"])
            actual_gas_cost = int(evt["args"]["actualGasCost"])
            actual_gas_used = int(evt["args"]["actualGasUsed"])
            continue
        except Exception:
            pass
        try:
            evt = entrypoint.events.UserOperationRevertReason().process_log(log_entry)
            data = evt["args"]["revertReason"]
            revert_reason = "0x" + data.hex() if isinstance(data, (bytes, bytearray)) else str(data)
        except Exception:
            continue

    return SubmitResponse(
        userOpHash=user_op_hash_hex,
        txHash=tx_hash,
        blockNumber=int(receipt.blockNumber),
        success=success,
        actualGasCost=actual_gas_cost,
        actualGasUsed=actual_gas_used,
        revertReason=revert_reason,
    )


@router.get("/info")
def bundler_info() -> dict[str, Any]:
    from chain.factory import _account, _w3_client
    w3 = _w3_client()
    relayer = _account()
    bal_wei = w3.eth.get_balance(relayer.address)
    return {
        "mode": "self-bundler",
        "entryPoint": os.environ.get("ENTRYPOINT_ADDRESS"),
        "relayer": relayer.address,
        "relayerBalanceWei": bal_wei,
        "chainId": int(os.environ.get("ARC_CHAIN_ID", "5042002")),
    }
