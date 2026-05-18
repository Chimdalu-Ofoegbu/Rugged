#!/usr/bin/env bash
# Rugged · deploy the contract suite to Arc testnet.
#
# Phase 1. Exports the repo-root .env, then runs the Foundry deploy script
# against Arc. Copy the printed addresses into .env (MARKET_FACTORY_ADDRESS,
# MARKET_RESOLUTION_ADDRESS, REPUTATION_BOND_ADDRESS, TRACE_REGISTRY_ADDRESS).
#
# Usage:  bash scripts/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load secrets / config from the repo-root .env
set -a
# shellcheck disable=SC1091
source "${ROOT}/.env"
set +a

cd "${ROOT}/contracts"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "${ARC_RPC_URL}" \
  --broadcast
