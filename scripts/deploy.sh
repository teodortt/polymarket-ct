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

resolve_branch() {
  if [ -n "${DEPLOY_BRANCH:-}" ]; then
    printf '%s\n' "$DEPLOY_BRANCH"
    return
  fi

  local current_branch
  current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$current_branch" ]; then
    echo ">>> Unable to determine current branch. Set DEPLOY_BRANCH explicitly." >&2
    exit 1
  fi

  printf '%s\n' "$current_branch"
}

BRANCH="$(resolve_branch)"

echo ">>> Fetching origin"
git fetch --all --prune

PREV_SHA="$(git rev-parse HEAD)"

echo ">>> Resetting to origin/$BRANCH"
git reset --hard "origin/$BRANCH"

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
