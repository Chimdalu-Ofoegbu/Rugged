# Rug Sentinel

**One-liner:** A tradable rugpull oracle built on a maintainer's blacklist commit log, with multi-agent verification, on-chain reasoning traces, and slash bonds on the maintainer's reputation. Markets open on Arc in the same block iterativv pushes a new blacklist entry.

**Hackathon:** Agora Agents Hackathon (Canteen × Circle × Arc), May 11 to May 25, 2026
**RFB home:** RFB 03, Prediction Market Verticals (partial brush against RFB 02)
**Submission deadline:** May 25, 2026
**Placement target:** Standout tier baseline ($650 to $750), 3rd place realistic ($5,000), 2nd place stretch ($7,500), 1st place reach ($10,000)
**Naming note:** Distinct from "Sentinel" (the Sui Overflow Agentic Web sub-track project). Use "Rug Sentinel" everywhere in this codebase to avoid collision.

---

## The Problem

Rugpull detection in DeFi is fragmented and reactive. By the time a coin lands on a public blacklist, retail capital has already drained. The maintainer of NostalgiaForInfinity (iterativv) does real-time, high-frequency rugpull detection through their blacklist commits on GitHub. The signal is public, free, and currently uncapitalized. No economic primitive exists that prices this signal, rewards the maintainer for accuracy, or lets the broader market trade on it.

## The Solution

Rug Sentinel turns iterativv's commit log into an on-chain prediction market vertical. A watcher parses new blacklist additions. A swarm of three independent agents verifies rug likelihood. Markets auto-open on Arc in the same block the commit is pushed, betting on whether the coin will lose more than 50% within 7 days. A slash bond layer prices iterativv's reputation directly: users stake USDC alongside the maintainer's blacklist record, and bonds slash if accuracy degrades over a rolling window.

The core economic claim: Arc's sub-second finality and $0.01 USDC gas make this product economically possible. On Ethereum mainnet the gas cost exceeds the alpha. This is not chain-agnostic; the chain is load-bearing.

---

## Architecture

```
GitHub Commit Watcher (Python service)
        ↓
  Coin Metadata Fetcher (address, chain, current price)
        ↓
  Multi-Agent Verification Swarm
  ├── Agent A: Contract Analyzer (mint auth, ownership, LP locks)
  ├── Agent B: Social Signal Analyzer (X, Telegram sentiment)
  └── Agent C: Onchain Flow Analyzer (LP changes, dev wallet movement)
        ↓ (consensus: ≥2 of 3 above 0.5 confidence)
  Reasoning Trace Hashing → Arc + IPFS/Irys
        ↓
  Market Factory Contract (Arc)
        ↓
  Auto-open 7-day "drops >50%" market, seeded by swarm consensus probability
        ↓
  User Betting (USDC, gas-free via Paymaster)
        ↓
  Idle Bet Capital → USYC (yield while markets open)
        ↓
  Resolution Contract (Pyth or aggregated CEX feed at expiry)
        ↓
  Slash Bond Updates (iterativv hit-rate tracked on-chain)
```

---

## Core Components

### 1. Commit Watcher
- Polls iterativv's NFI repo every 30 seconds for new blacklist commits.
- Parses commit diffs to extract added coin addresses, chains, and pair info.
- Emits a structured event consumed by the swarm and the market factory.

### 2. Multi-Agent Verification Swarm
- Three independent LLM agents (Claude or GPT class), each with a specialized role.
- **Agent A (Contract Analyzer):** mint authority renounced, ownership burned, LP locked, honeypot patterns.
- **Agent B (Social Signal Analyzer):** X and Telegram sentiment, coordinated shilling, dev silence.
- **Agent C (Onchain Flow Analyzer):** LP changes in the last 24 hours, dev wallet drains, top-holder concentration.
- Each agent outputs a rug-likelihood score 0 to 1 and a structured reasoning trace (JSON).
- Consensus: at least 2 of 3 agents above 0.5 triggers market creation.
- This is the 30% Agentic Sophistication play. Full autonomy on the "should we open a market?" decision.

### 3. Market Factory Contract (Solidity on Arc)
- Auto-creates a 7-day binary market: "Will [coin] drop >50% from blacklist-time price?"
- Initial market probability seeded from swarm consensus score.
- USDC bet placement, gas-free via Paymaster.
- Each market emits a `MarketOpened` event with a reference to the reasoning trace hash.

### 4. Reasoning Trace Layer
- Each market creation has its full swarm reasoning trace hashed (SHA-256) and stored on Arc via a `TraceRegistry` contract.
- Full JSON trace pinned to IPFS or Irys, with the IPFS CID logged on-chain.
- Public, permanent audit trail of why this market was created. Differentiator on the Innovation score.

### 5. Slash Bond Contract
- Users stake USDC behind iterativv's reputation via a `ReputationBond` contract.
- The contract tracks the hit rate of the last 30 resolved markets (percentage that dropped >50% within 7 days).
- If hit rate falls below 70%, bonds slash proportionally to the deviation.
- Slashed USDC redistributes to remaining bondholders.
- A genuine economic primitive: pricing a human maintainer's reputation on-chain.

### 6. Idle Capital Yield
- Bet capital in open markets parks in USYC until resolution.
- Yield split: 80% to winning bettors, 20% to the platform treasury.
- Hits the "creative Circle tool usage" criterion most teams will miss.

### 7. Frontend + Telegram Bot
- Next.js dashboard: browse markets, place bets, view reasoning traces, see iterativv's live hit rate.
- Telegram bot: new-market alerts with one-click bet links.
- Onboarding via Circle Developer-Controlled Wallets, email-based, no seed phrases.

---

## Circle Product Integrations

| Product | Usage |
|---------|-------|
| USDC | Settlement, bet denomination, bond denomination |
| Arc | Settlement chain, sub-second market opening |
| Contracts | MarketFactory, Resolution, ReputationBond, TraceRegistry |
| Wallets | User accounts (Developer-Controlled), agent wallets for the swarm |
| Paymaster | Gas-free betting UX, gas denominated in USDC |
| USYC | Idle bet capital earns yield while markets are open |
| App Kit (Send) | One-click bet placement |

Seven Circle products. The competitive baseline is three or four.

---

## Judging Alignment (30/30/20/20)

| Criterion | Weight | Estimate | Why |
|-----------|--------|----------|-----|
| Agentic Sophistication | 30% | 24 to 27 of 30 | Multi-agent swarm with autonomous market-creation decision. Three agents independently reason; consensus is the agency. |
| Traction | 30% | 20 to 24 of 30 | Pre-seeded historical markets, Telegram bot for distribution, realistic target 50 users + 200 bets + $1,000 volume. |
| Circle Tool Usage | 20% | 17 to 19 of 20 | Seven Circle products integrated. USYC and Paymaster usage are the differentiators. |
| Innovation | 20% | 15 to 17 of 20 | Three of Canteen's six published research hacks stacked: #3 (blacklist oracle), #1 (reasoning traces), #6 (slash bonds). |

**Total realistic range: 76 to 87 out of 100.**

---

## Differentiation / Moat

- **Host pre-validation.** Canteen published the core build spec in their research section (item #3). The hosts have already endorsed the idea.
- **Multi-agent swarm echoes DIVE.** DIVE was a top-10 finalist at ETHGlobal Cannes 2026 using a swarm to verify prediction market truth. Judges recognize the pattern.
- **Reasoning traces on-chain.** Free auditability layer that competitors will not have time to add in 11 days.
- **Slash bond on maintainer reputation.** No precedent in any prior hackathon. Genuinely novel economic primitive.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| iterativv historical hit rate is below 60% | Medium | Validate on Day 1 before committing further. If low, pivot to multi-maintainer feed (e.g., GoPlus blacklist, Solana rugcheck feeds). |
| Price oracle integration fails | Medium | Pyth as primary; allow manual judge resolution as demo fallback. |
| Multi-agent swarm consensus is unstable | Medium | Cut to single-agent fallback on Day 6 if needed; still ships. |
| Slash bond contract complexity blows timeline | Medium-High | Cut entirely on Day 8 if risky; reasoning traces alone still hit innovation score. |
| Hackathon application rejected (selective entry) | Low | Apply Day 1, use passphrase SITEx1313 on Luma. |
| Sui Overflow Phase 2 checkpoint conflict on May 22 | High | Front-load Sui work May 14 to 21. Treat Days 9 to 11 of Rug Sentinel as Sui-protected only for demo polish, no new features. |
| Other teams clone the idea from the research section | Medium | Speed-to-market + the slash bond and reasoning trace layers as defensible add-ons. |
| iterativv changes blacklist behavior mid-build | Low | Architecture is maintainer-agnostic; second feed swappable in. |

---

## Submission Deliverables (Per Site Requirements)

- Live working product deployed to Arc testnet, with a public URL.
- Founder pitch video, 2 to 3 minutes (who you are, what you built, why it matters).
- Public GitHub repo with a README that walks through architecture and Circle integrations.
- Traction answers: number of unique users onboarded, total bets placed, volume in USDC, user problems addressed.

---

## Pre-Planned Cut Lines

- **Day 1 cut:** If iterativv's historical hit rate is below 60% across a 30-market sample, pivot to a multi-maintainer feed before further build.
- **Day 4 cut:** If the market factory or resolution oracle is unstable, mock resolution for the demo and document the production path in the README.
- **Day 6 cut:** If multi-agent swarm consensus is flaky, ship a single-agent fallback. Keep the multi-agent code in a feature branch.
- **Day 8 cut:** If the slash bond contract is risky or buggy, cut it entirely. Reasoning traces and multi-agent swarm alone still hit Innovation and Agentic Sophistication.
- **Day 10 freeze:** No new features. Only demo polish, pitch video, README, traction documentation.

---

## File Structure

```
rug-sentinel/
├── watcher/                 # Python commit watcher service
│   ├── poller.py
│   ├── diff_parser.py
│   └── metadata_fetcher.py
├── agents/                  # Multi-agent swarm
│   ├── contract_analyzer.py
│   ├── social_signal_analyzer.py
│   ├── onchain_flow_analyzer.py
│   └── consensus.py
├── contracts/               # Solidity contracts (Foundry)
│   ├── src/
│   │   ├── MarketFactory.sol
│   │   ├── Market.sol
│   │   ├── Resolution.sol
│   │   ├── ReputationBond.sol
│   │   └── TraceRegistry.sol
│   └── test/
├── traces/                  # IPFS/Irys pinning service
│   └── pin_trace.py
├── frontend/                # Next.js dashboard
│   ├── pages/
│   ├── components/
│   └── lib/circle/          # Circle SDK integrations
├── telegram-bot/            # Alert bot
│   └── bot.py
├── scripts/
│   ├── seed_historical.py   # Pre-seed 30 historical markets
│   └── deploy.sh
├── README.md
├── ROADMAP.md
└── project.md
```
