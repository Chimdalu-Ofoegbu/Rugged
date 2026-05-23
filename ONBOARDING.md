# Rugged — Runbook

What runs where, how to demo it in five minutes, common operations.

## Services

| Service | What it does | Port | Start |
|---|---|---|---|
| **api** | FastAPI backend — markets, positions, paymaster sponsor, self-bundler, admin | 8001 | `uv run uvicorn api.main:app --host 127.0.0.1 --port 8001 --reload` |
| **web** | Vite + React + Privy SPA — the user-facing site | 5173 | `npm run dev --prefix web` |
| **orchestrator** | Watcher poll + resolver tick loop (settles expired markets) | — | `uv run python -m orchestrator --interval 30` |
| **telegram-bot** | Alert bot (`/markets`, `/stats`, `/mybets` deep-link) | — | `uv run python telegram-bot/bot.py` |

All four read from the **same `.env` at repo root**. The orchestrator embeds the watcher loop and the resolver daemon — you don't run them separately.

`.claude/launch.json` defines all four as preview targets so you can spin them up via Claude Code's preview tools.

## Five-minute demo path

1. **Start api + web + orchestrator** (the telegram bot is optional).
2. **Open the web app** at `http://localhost:5173`.
3. **Sign in** via the wallet pill → Privy email/Google login. The smart-account address is computed deterministically from your Privy EOA owner.
4. **Get testnet USDC**: wallet modal → *Balance* tab → "Get $10 testnet USDC". One claim/hour per browser identity.
5. **Spin up a fast market** so you don't wait 24h:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"duration_seconds":300}' \
     http://127.0.0.1:8001/api/admin/demo-market
   ```
   Returns the market id (usually the next sequential one).
6. **Bet** on `IT RUGS` or `IT HOLDS` from the market detail page. Bets sign client-side via Privy → sponsor route → bundler → on-chain. Gas is paid by the Rugged Paymaster.
7. **Wait the duration** (5 min in the example above).
8. **Force-resolve YES** for the demo finale:
   ```bash
   curl -X POST -H "Content-Type: application/json" \
     -d '{"outcome":"yes"}' \
     http://127.0.0.1:8001/api/admin/force-resolve/<market_id>
   ```
9. **Claim winnings** from the same market detail page — the bet UI flips to a Claim panel.

If you want the resolver daemon to handle resolution automatically instead of forcing, the orchestrator does that every 30s during its loop (no real price feed for synthetic mints, so you still need `force-resolve` for them).

## Demo-only endpoints (not for production)

- `POST /api/admin/demo-market` — synthetic short-duration market.
  - body: `{duration_seconds: int, seed_probability_bps: int}` (both optional; defaults 300, 7500)
- `POST /api/admin/force-resolve/{market_id}` — set the outcome directly.
  - body: `{outcome: "yes"|"no"}` (default `"yes"`)
  - Requires the market to be past expiry. Resolution.sol enforces that on-chain.
- `POST /api/admin/resolver-tick` — fire the resolver loop on demand.
- `POST /api/wallet/faucet` — send the caller's wallet $10 testnet USDC.
  - Rate-limited per `X-Rugged-User-Id` (1/hour). For a fresh user_id, generate a new UUID v4.

## Key contracts (Arc testnet, chain id 5042002)

All addresses live in `.env`. After any redeploy, **also update `web/src/config.ts`** (the frontend mirrors them so it can construct UserOps client-side).

- `MARKET_FACTORY_ADDRESS` — deploys `Market` instances; tracks `isMarket(addr)` for paymaster scope
- `MARKET_RESOLUTION_ADDRESS` — owner-set `resolver` calls `resolve(market, observedLow)`
- `REPUTATION_BOND_ADDRESS` — records outcome → feeds the slash-bond mechanic (Bond page is UI-only at the moment)
- `TRACE_REGISTRY_ADDRESS` — pins agent reasoning trace hashes; **survives factory redeploys**, so old marketIds keep their old traces
- `PAYMASTER_ADDRESS` — `RuggedPaymaster` v1.2.0-arc-scoped-cancel. Scope: USDC.{approve,transfer}, Market.{placeBet,claim,cancelBet}
- `ENTRYPOINT_ADDRESS` — canonical ERC-4337 v0.7 EntryPoint, `0x00000…32`

## Redeploying

When `Market.sol` or `MarketFactory.sol` change:

```bash
# 1. tests pass first
cd contracts && forge test

# 2. redeploy factory (Resolution + Bond + TraceRegistry are independent)
forge script script/DeployMarketFactory.s.sol:DeployMarketFactory \
  --rpc-url "$ARC_RPC_URL" --broadcast

# 3. update MARKET_FACTORY_ADDRESS in .env + web/src/config.ts
# 4. redeploy the paymaster (it holds an immutable reference to the old factory)
bash scripts/deploy_paymaster.sh

# 5. update PAYMASTER_ADDRESS in .env + web/src/config.ts
# 6. fund the new paymaster's EntryPoint deposit
uv run python -m scripts.fund_paymaster 0.2

# 7. prune the mint registry (old derived-address → mint rows the new
#    factory doesn't know about)
uv run python -m scripts.prune_mint_registry --apply

# 8. refresh ABIs if the function signatures changed
#    (chain/abis/{Market,MarketFactory}.json — copy abi[] from contracts/out/*)
```

When `RuggedPaymaster.sol` changes (e.g. new scope selector):

```bash
bash scripts/deploy_paymaster.sh
# update PAYMASTER_ADDRESS in .env + web/src/config.ts
uv run python -m scripts.fund_paymaster 0.2
```

## Common operations

- **Smoke the sponsor route**: `uv run python -m scripts.smoke_test_sponsor_route`
- **Smoke the full UserOp flow**: `uv run python -m scripts.smoke_test_e2e_userop`
- **Smoke the paymaster on-chain**: `uv run python -m scripts.smoke_test_paymaster`
- **Set Telegram subscribers manually**: see `data/subscribers.json`

## Architecture in one paragraph

A watcher polls RugCheck for blacklisted Solana mints. When one fires, the orchestrator runs a 3-agent swarm (Contract / Social / Onchain). If consensus fires, the orchestrator opens a 24-hour binary "drops >50%" market on Arc via `MarketFactory.createMarket`, pins the agent reasoning trace to Irys, and registers the hash on-chain. Users sign in via Privy (email/Google), get a deterministic ERC-4337 smart account, and bet USDC. Every bet/claim/cancel is a sponsored UserOp — the backend `/api/paymaster/sponsor` route signs scope-checked sponsorships, `/api/bundler/submit` relays via `EntryPoint.handleOps` from the deployer EOA. At expiry, the resolver daemon submits the observed 24h-low price to `Resolution.resolve`, which drives `Market.settle` (1.2% to treasury, 0.8% to the reputation bond fee pool, rest distributed pro-rata to winners).

## What's still in-progress

- Bond page is marketing-only — the on-chain `ReputationBond` works, but no UI for users to stake yet.
- Reasoning trace IPFS pinning works, but uses Irys; pinning may flake if the Irys gateway is down.
- Resolver auto-resolution depends on a real price source for the mint. For synthetic demo markets, use `/api/admin/force-resolve`.
