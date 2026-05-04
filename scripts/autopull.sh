#!/data/data/com.termux/files/usr/bin/env bash
# Polls GitHub for new commits on $BRANCH and redeploys when HEAD advances.
# Designed for Termux. Run under `pm2` or `termux-services` so it auto-restarts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

BRANCH="${DEPLOY_BRANCH:-main}"
INTERVAL="${DEPLOY_POLL_INTERVAL:-60}"   # seconds
APP_NAME="polymarket-copybot"

echo "[autopull] watching origin/$BRANCH every ${INTERVAL}s in $REPO_DIR"

while true; do
  if git fetch --quiet origin "$BRANCH"; then
    LOCAL="$(git rev-parse HEAD)"
    REMOTE="$(git rev-parse "origin/$BRANCH")"

    if [ "$LOCAL" != "$REMOTE" ]; then
      echo "[autopull] new commit detected: $LOCAL -> $REMOTE"

      CHANGED_FILES="$(git diff --name-only "$LOCAL" "$REMOTE" || true)"
      git reset --hard "origin/$BRANCH"

      if echo "$CHANGED_FILES" | grep -E '^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$' >/dev/null; then
        echo "[autopull] dependency change, running install"
        if [ -f package-lock.json ]; then
          npm ci || npm install
        else
          npm install
        fi
      fi

      if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
        echo "[autopull] reloading $APP_NAME"
        pm2 reload "$APP_NAME" --update-env
      else
        echo "[autopull] starting $APP_NAME"
        pm2 start ecosystem.config.js
      fi
      pm2 save >/dev/null 2>&1 || true
    fi
  else
    echo "[autopull] git fetch failed, will retry"
  fi

  sleep "$INTERVAL"
done
