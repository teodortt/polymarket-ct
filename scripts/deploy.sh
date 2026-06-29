#!/usr/bin/env bash
# Deploy script: pulls latest code and reloads the PM2 process.
# Intended to be invoked over SSH by the GitHub Actions workflow.
set -euo pipefail

# Resolve repo root (one level up from this script).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR"

echo ">>> Deploying in $REPO_DIR"

# Make sure shell has access to nvm-installed node/npm/pm2 if applicable.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo ">>> ERROR: repository is in detached HEAD; checkout a branch first"
  exit 1
fi

echo ">>> Fetching origin"
git fetch --all --prune

PREV_SHA="$(git rev-parse HEAD)"

echo ">>> Pulling latest for current branch: $BRANCH"
git pull --ff-only origin "$BRANCH"

NEW_SHA="$(git rev-parse HEAD)"
echo ">>> $PREV_SHA -> $NEW_SHA"

# Install deps only if package.json or lockfile changed (or first deploy).
if [ "$PREV_SHA" = "$NEW_SHA" ] || git diff --name-only "$PREV_SHA" "$NEW_SHA" | grep -E '^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$' >/dev/null; then
  echo ">>> Installing dependencies"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
else
  echo ">>> No dependency changes, skipping install"
fi

APP_NAME="polymarket-copybot"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  echo ">>> Reloading $APP_NAME"
  pm2 reload "$APP_NAME" --update-env
else
  echo ">>> Starting $APP_NAME from ecosystem.config.js"
  pm2 start ecosystem.config.js
fi

pm2 save >/dev/null 2>&1 || true

echo ">>> Deploy complete"
