"""Rugged · prune stale entries from data/mint_address_map.json.

The registry is append-only: every market created through chain.factory.create_market
adds a `derived_addr -> mint` row. When MarketFactory is redeployed, rows from
the previous deployment become unreachable — the new factory doesn't know about
those derived addresses, so /api/markets won't surface them and the UI can't
navigate to them.

This script walks the *currently configured* MarketFactory, collects every live
market's coin_address, and removes any rows in mint_address_map.json that don't
match. Safe to run any time; idempotent.

Run:
    uv run python -m scripts.prune_mint_registry              # report only
    uv run python -m scripts.prune_mint_registry --apply      # rewrite the file
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=True)

from chain.factory import _factory_contract  # noqa: E402
from chain.market import read_market  # noqa: E402

REGISTRY = ROOT / "data" / "mint_address_map.json"


def main(argv: list[str]) -> int:
    apply = "--apply" in argv

    factory = _factory_contract()
    count = factory.functions.marketCount().call()
    live_addrs: set[str] = set()
    for i in range(count):
        market_addr = factory.functions.getMarket(i).call()
        if int(market_addr, 16) == 0:
            continue
        try:
            state = read_market(market_addr)
            live_addrs.add(state["coin_address"].lower())
        except Exception as exc:  # noqa: BLE001
            print(f"  warning: could not read market {i} @ {market_addr}: {exc}")

    try:
        registry = json.loads(REGISTRY.read_text())
    except FileNotFoundError:
        print("registry file not found — nothing to prune")
        return 0

    keep: dict[str, dict] = {}
    stale: dict[str, dict] = {}
    for derived, meta in registry.items():
        if derived.lower() in live_addrs:
            keep[derived] = meta
        else:
            stale[derived] = meta

    print(f"  factory      : {factory.address}")
    print(f"  live markets : {len(live_addrs)}")
    print(f"  registry rows: {len(registry)}")
    print(f"  -> keep       : {len(keep)}")
    print(f"  -> stale      : {len(stale)}")
    if stale:
        print()
        print("  stale entries:")
        for k, v in list(stale.items())[:10]:
            print(f"    {k}  ->  {v.get('symbol', '?'):12}  {v.get('mint', '?')[:32]}")
        if len(stale) > 10:
            print(f"    … and {len(stale) - 10} more")

    if not apply:
        print()
        print("  (dry-run) — pass --apply to rewrite the file")
        return 0

    REGISTRY.write_text(json.dumps(keep, indent=2))
    print()
    print(f"  [OK] rewrote {REGISTRY} with {len(keep)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
