"""Rugged · paymaster sponsorship route.

POST /api/paymaster/sponsor

Takes an unsigned PackedUserOperation (v0.7) plus the wallet that will sign
it, decides whether the call is in-scope for Rugged sponsorship, and — if so
— returns a `paymasterAndData` blob the frontend can splice back into the
UserOp before the smart account signs it.

The same scope policy is enforced on-chain by RuggedPaymaster._validateScope
so this layer is purely a fast-path 4xx for obviously-out-of-scope requests:
the chain is the source of truth. We mirror the contract layout exactly so a
sponsorship signed here always validates on-chain.

paymasterAndData layout (mirrors VerifyingPaymaster + RuggedPaymaster):
    [0:20]     paymaster address
    [20:36]    validationGasLimit (uint128) || postOpGasLimit (uint128)
    [36:100]   abi.encode(uint48 validUntil, uint48 validAfter)
    [100:165]  65-byte ECDSA signature
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Literal

from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

log = logging.getLogger("api.paymaster")

router = APIRouter(prefix="/api/paymaster", tags=["paymaster"])


# ----------------------------------------------------------------------
#  Constants — mirror RuggedPaymaster.sol exactly
# ----------------------------------------------------------------------
EXECUTE_SELECTOR = keccak(text="execute(address,uint256,bytes)")[:4]              # 0xb61d27f6
USDC_TRANSFER_SELECTOR = bytes.fromhex("a9059cbb")
USDC_APPROVE_SELECTOR = bytes.fromhex("095ea7b3")
MARKET_PLACE_BET_SELECTOR = keccak(text="placeBet(bool,uint256)")[:4]             # 0xf7f74b22
MARKET_CLAIM_SELECTOR = keccak(text="claim()")[:4]                                # 0x4e71d92d
MARKET_CANCEL_BET_SELECTOR = keccak(text="cancelBet(bool)")[:4]                   # 0x5ed6302d

# Validity window for issued sponsorships. Short enough that a leaked
# signature has bounded blast radius, long enough that a slow bundler doesn't
# expire it mid-flight.
DEFAULT_VALID_WINDOW_SECONDS = 5 * 60     # 5 minutes
CLOCK_SKEW_SECONDS = 30                   # accept slight client-clock drift

# Gas-limit fields baked into paymasterAndData. These bound how much the
# paymaster is willing to spend on validation and the post-op refund hook.
# We keep them generous — Arc gas is cheap and the on-chain scope check is
# the real defense.
DEFAULT_VALIDATION_GAS_LIMIT = 150_000
DEFAULT_POST_OP_GAS_LIMIT = 30_000


# ----------------------------------------------------------------------
#  Request / response models
# ----------------------------------------------------------------------
class PackedUserOpJson(BaseModel):
    """JSON wire-format mirror of web/src/lib/userOpTypes.ts.

    All `bytes`/`uint` fields arrive as hex strings (`0x…`). We don't try
    to parse them into ints here — the hashing code wants raw bytes.
    """
    sender: str
    nonce: str
    initCode: str
    callData: str
    accountGasLimits: str
    preVerificationGas: str
    gasFees: str
    paymasterAndData: str = ""
    signature: str = ""


class SponsorRequest(BaseModel):
    userOp: PackedUserOpJson
    wallet: str = Field(..., description="The smart-account / signer address — used for logging + future rate limiting")
    chainId: int


class SponsorResponse(BaseModel):
    paymasterAndData: str
    validUntil: int
    validAfter: int
    scope: Literal[
        "usdc_approve", "usdc_transfer",
        "market_placeBet", "market_claim", "market_cancelBet",
    ]


# ----------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------
def _hex_to_bytes(s: str, *, field: str) -> bytes:
    if not s:
        return b""
    if not s.startswith("0x"):
        raise HTTPException(status_code=400, detail=f"{field}: must be a 0x-prefixed hex string")
    try:
        return bytes.fromhex(s[2:])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field}: invalid hex")


def _hex_to_int(s: str, *, field: str) -> int:
    if not s:
        return 0
    if not s.startswith("0x"):
        raise HTTPException(status_code=400, detail=f"{field}: must be a 0x-prefixed hex string")
    try:
        return int(s, 16)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field}: invalid hex int")


def _checksum_or_400(addr: str, *, field: str) -> str:
    if not isinstance(addr, str) or not addr.startswith("0x") or len(addr) != 42:
        raise HTTPException(status_code=400, detail=f"{field}: not a 20-byte address")
    try:
        int(addr, 16)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field}: invalid hex")
    return addr


# ----------------------------------------------------------------------
#  Scope validation — mirrors RuggedPaymaster._validateScope
# ----------------------------------------------------------------------
def _is_market_address(addr: str) -> bool:
    """Reverse-lookup against MarketFactory.isMarket(). Lazy-import the chain
    helper so the route module can be imported without a chain connection
    in test environments.
    """
    from chain.factory import _factory_contract  # lazy

    factory = _factory_contract()
    return bool(factory.functions.isMarket(addr).call())


def _validate_scope(call_data: bytes) -> Literal[
    "usdc_approve", "usdc_transfer",
    "market_placeBet", "market_claim", "market_cancelBet",
]:
    """Decode UserOp.callData expecting `execute(address,uint256,bytes)`,
    extract inner target + selector, and enforce Rugged's allowlist.
    Returns a tag identifying which scope rule matched.

    Raises HTTPException(403) on any out-of-scope call.
    """
    if len(call_data) < 4:
        raise HTTPException(status_code=400, detail="callData too short (need ≥4 bytes)")

    outer_selector = call_data[:4]
    if outer_selector != EXECUTE_SELECTOR:
        raise HTTPException(
            status_code=403,
            detail=f"only SimpleAccount.execute is sponsored (got selector 0x{outer_selector.hex()})",
        )

    # execute(address dest, uint256 value, bytes data)
    try:
        from eth_abi import decode as abi_decode

        target_addr, _value, inner_data = abi_decode(
            ["address", "uint256", "bytes"], call_data[4:]
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not decode execute args: {exc}")

    if len(inner_data) < 4:
        raise HTTPException(status_code=400, detail="inner call too short to contain a selector")

    inner_selector = inner_data[:4]
    target_addr_l = target_addr.lower()

    usdc_addr = os.environ.get("USDC_ADDRESS", "").lower()
    if usdc_addr and target_addr_l == usdc_addr:
        if inner_selector == USDC_APPROVE_SELECTOR:
            return "usdc_approve"
        if inner_selector == USDC_TRANSFER_SELECTOR:
            return "usdc_transfer"
        raise HTTPException(
            status_code=403,
            detail=f"USDC call selector 0x{inner_selector.hex()} not in scope (only approve/transfer)",
        )

    # Not USDC — must be a real Market deployed by our factory.
    try:
        from web3 import Web3
        target_checksum = Web3.to_checksum_address(target_addr)
        if not _is_market_address(target_checksum):
            raise HTTPException(
                status_code=403,
                detail=f"target {target_checksum} is not a Rugged Market — sponsorship refused",
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"factory.isMarket lookup failed: {exc}")

    if inner_selector == MARKET_PLACE_BET_SELECTOR:
        return "market_placeBet"
    if inner_selector == MARKET_CLAIM_SELECTOR:
        return "market_claim"
    if inner_selector == MARKET_CANCEL_BET_SELECTOR:
        return "market_cancelBet"
    raise HTTPException(
        status_code=403,
        detail=f"Market call selector 0x{inner_selector.hex()} not in scope (only placeBet/claim/cancelBet)",
    )


# ----------------------------------------------------------------------
#  Hash + sign — mirrors RuggedPaymaster.getHash()
# ----------------------------------------------------------------------
def _compute_userop_hash(
    *,
    sender: str,
    nonce: int,
    init_code: bytes,
    call_data: bytes,
    account_gas_limits: bytes,   # bytes32
    paymaster_gas_part: bytes,   # bytes32 (validationGasLimit || postOpGasLimit)
    pre_verification_gas: int,
    gas_fees: bytes,             # bytes32
    chain_id: int,
    paymaster_addr: str,
    valid_until: int,
    valid_after: int,
) -> bytes:
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


# ----------------------------------------------------------------------
#  Route
# ----------------------------------------------------------------------
@router.post("/sponsor", response_model=SponsorResponse)
def sponsor(req: SponsorRequest) -> SponsorResponse:
    """Issue a paymaster sponsorship signature for an in-scope UserOp."""
    paymaster_addr = os.environ.get("PAYMASTER_ADDRESS")
    signer_pk = os.environ.get("PAYMASTER_SIGNER_PRIVATE_KEY")
    expected_chain = int(os.environ.get("ARC_CHAIN_ID", "5042002"))
    if not paymaster_addr:
        raise HTTPException(status_code=500, detail="PAYMASTER_ADDRESS not configured")
    if not signer_pk:
        raise HTTPException(status_code=500, detail="PAYMASTER_SIGNER_PRIVATE_KEY not configured")

    if req.chainId != expected_chain:
        raise HTTPException(
            status_code=400,
            detail=f"chainId mismatch: expected {expected_chain}, got {req.chainId}",
        )

    op = req.userOp
    sender = _checksum_or_400(op.sender, field="userOp.sender")
    _checksum_or_400(req.wallet, field="wallet")

    nonce = _hex_to_int(op.nonce, field="userOp.nonce")
    init_code = _hex_to_bytes(op.initCode, field="userOp.initCode")
    call_data = _hex_to_bytes(op.callData, field="userOp.callData")
    account_gas_limits = _hex_to_bytes(op.accountGasLimits, field="userOp.accountGasLimits")
    pre_verification_gas = _hex_to_int(op.preVerificationGas, field="userOp.preVerificationGas")
    gas_fees = _hex_to_bytes(op.gasFees, field="userOp.gasFees")

    if len(account_gas_limits) != 32:
        raise HTTPException(status_code=400, detail="accountGasLimits must be exactly 32 bytes")
    if len(gas_fees) != 32:
        raise HTTPException(status_code=400, detail="gasFees must be exactly 32 bytes")

    # Off-chain scope check — fast 403 before we spend a signature.
    scope_tag = _validate_scope(call_data)

    now = int(time.time())
    valid_after = now - CLOCK_SKEW_SECONDS
    valid_until = now + DEFAULT_VALID_WINDOW_SECONDS

    validation_gas_limit = DEFAULT_VALIDATION_GAS_LIMIT
    post_op_gas_limit = DEFAULT_POST_OP_GAS_LIMIT
    paymaster_gas_part = (
        validation_gas_limit.to_bytes(16, "big")
        + post_op_gas_limit.to_bytes(16, "big")
    )

    op_hash = _compute_userop_hash(
        sender=sender,
        nonce=nonce,
        init_code=init_code,
        call_data=call_data,
        account_gas_limits=account_gas_limits,
        paymaster_gas_part=paymaster_gas_part,
        pre_verification_gas=pre_verification_gas,
        gas_fees=gas_fees,
        chain_id=req.chainId,
        paymaster_addr=paymaster_addr,
        valid_until=valid_until,
        valid_after=valid_after,
    )
    signed = Account.sign_message(encode_defunct(op_hash), private_key=signer_pk)
    signature = signed.signature  # 65 bytes

    paymaster_and_data = _build_paymaster_and_data(
        paymaster_addr,
        validation_gas_limit,
        post_op_gas_limit,
        valid_until,
        valid_after,
        signature,
    )

    log.info(
        "sponsored %s for %s — scope=%s validUntil=%d hash=0x%s",
        op.sender, req.wallet, scope_tag, valid_until, op_hash.hex(),
    )

    return SponsorResponse(
        paymasterAndData="0x" + paymaster_and_data.hex(),
        validUntil=valid_until,
        validAfter=valid_after,
        scope=scope_tag,
    )


# Lightweight discovery / health endpoint for the frontend or smoke tests.
@router.get("/info")
def paymaster_info() -> dict[str, Any]:
    return {
        "paymaster": os.environ.get("PAYMASTER_ADDRESS"),
        "entryPoint": os.environ.get("ENTRYPOINT_ADDRESS"),
        "verifyingSigner": os.environ.get("PAYMASTER_SIGNER_ADDRESS"),
        "chainId": int(os.environ.get("ARC_CHAIN_ID", "5042002")),
        "usdc": os.environ.get("USDC_ADDRESS"),
        "factory": os.environ.get("MARKET_FACTORY_ADDRESS"),
        "validWindowSeconds": DEFAULT_VALID_WINDOW_SECONDS,
    }
