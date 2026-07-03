#!/usr/bin/env bash
set -euo pipefail

# Recover from PM2 stale-id / corrupted process-list state.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

pm2 kill || true
rm -rf "$HOME/.pm2/dump.pm2" "$HOME/.pm2/dump.pm2.bak" "$HOME/.pm2/pids" "$HOME/.pm2/logs"

pm2 start ecosystem.config.js --only polymarket-copybot
pm2 start ecosystem.config.js --only autopull
pm2 save

echo "[pm2-heal] PM2 state reset and apps restarted."
