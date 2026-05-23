#!/usr/bin/env bash
# Rugged · deploy the RuggedPaymaster to Arc testnet.
#
# Reads from the repo-root .env:
#   - DEPLOYER_PRIVATE_KEY      (funds + owns the paymaster)
#   - PAYMASTER_SIGNER_ADDRESS  (off-chain verifying signer; you generated this earlier)
#   - ARC_RPC_URL               (Arc testnet RPC)
#
# Optional:
#   - ENTRYPOINT_ADDRESS              (defaults to 0x00000…32, the canonical v0.7)
#   - PAYMASTER_INITIAL_DEPOSIT_WEI   (defaults to 0; fund separately is fine)
#
# After successful deployment, print the PAYMASTER_ADDRESS and append it to .env.
#
# Usage:  bash scripts/deploy_paymaster.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load secrets / config from the repo-root .env
set -a
# shellcheck disable=SC1091
source "${ROOT}/.env"
set +a

# Sanity checks
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY missing in .env}"
: "${PAYMASTER_SIGNER_ADDRESS:?PAYMASTER_SIGNER_ADDRESS missing in .env (run the keygen one-liner first)}"
: "${ARC_RPC_URL:?ARC_RPC_URL missing in .env}"

cd "${ROOT}/contracts"
forge script script/DeployPaymaster.s.sol:DeployPaymaster \
  --rpc-url "${ARC_RPC_URL}" \
  --broadcast
