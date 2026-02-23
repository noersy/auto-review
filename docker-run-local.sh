#!/usr/bin/env bash
# Local test runner — simulates Jenkins environment using Docker.
#
# Usage:
#   ./docker-run-local.sh <owner/repo> <pr-number> <path-to-pr-checkout>
#
# Examples:
#   ./docker-run-local.sh myorg/myrepo 42 /c/projects/myrepo
#   ./docker-run-local.sh myorg/myrepo 42 /c/projects/myrepo opened    # default action
#   ./docker-run-local.sh myorg/myrepo 42 /c/projects/myrepo synchronize
#
# Required env vars (set before running, or in .env.local):
#   GITHUB_TOKEN  — GitHub PAT with repo + PR comment permissions
#
# The script will:
#   1. Build the Docker image (auto-review-bot:local)
#   2. Mount the PR checkout directory as /repo inside the container
#   3. Mount claude-cli-session.json as ~/.claude.json for auth
#   4. Run the bot with the given args

set -euo pipefail

REPO="${1:?Usage: $0 <owner/repo> <pr-number> <path-to-pr-checkout> [action]}"
PR_NUMBER="${2:?Missing PR number}"
PR_CHECKOUT_PATH="${3:?Missing path to PR checkout}"
ACTION="${4:-opened}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_FILE="${SCRIPT_DIR}/claude-cli-session.json"

# --- Validation ---
if [[ -z "${GITHUB_TOKEN:-}" ]]; then
    echo "ERROR: GITHUB_TOKEN is not set."
    echo "  export GITHUB_TOKEN=ghp_..."
    exit 1
fi

if [[ ! -f "$SESSION_FILE" ]]; then
    echo "ERROR: claude-cli-session.json not found at: $SESSION_FILE"
    echo "  Copy your Claude auth from ~/.claude.json (or AppData equivalent)"
    echo "  and save it as claude-cli-session.json in this directory."
    exit 1
fi

if [[ ! -d "$PR_CHECKOUT_PATH" ]]; then
    echo "ERROR: PR checkout path does not exist: $PR_CHECKOUT_PATH"
    exit 1
fi

echo "=== auto-review local Docker test ==="
echo "  Repo:     $REPO"
echo "  PR:       #$PR_NUMBER"
echo "  Action:   $ACTION"
echo "  Checkout: $PR_CHECKOUT_PATH"
echo ""

# --- Build ---
echo "[1/2] Building Docker image..."
docker build -t auto-review-bot:local "$SCRIPT_DIR"

# --- Run ---
echo "[2/2] Running bot..."
docker run --rm \
    -e GITHUB_TOKEN="$GITHUB_TOKEN" \
    -e CI=true \
    -v "${PR_CHECKOUT_PATH}:/repo:ro" \
    -v "${SESSION_FILE}:/root/.claude.json:ro" \
    --workdir /app \
    auto-review-bot:local \
    --action "$ACTION" \
    --repo "$REPO" \
    --pr "$PR_NUMBER"
