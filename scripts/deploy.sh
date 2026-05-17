#!/usr/bin/env bash
# Rugged · contract deployment to Arc testnet.
#
# Phase 1. Exports the repo-root .env, then runs the Foundry deploy script
# against the `arc` RPC endpoint and writes the resulting contract addresses
# back into .env (MARKET_FACTORY_ADDRESS, … ).
#
# STUB — implemented in Phase 1 (project.md §"Phase 1: Smart Contracts").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load secrets / config from the repo-root .env
set -a
# shellcheck disable=SC1091
source "${ROOT}/.env"
set +a

echo "deploy.sh — Phase 1 stub. Arc RPC: ${ARC_RPC_URL:-<unset>}"
# Phase 1: forge script contracts/script/Deploy.s.sol --rpc-url arc --broadcast
