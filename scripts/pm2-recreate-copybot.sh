#!/usr/bin/env bash
set -euo pipefail

pm2 delete polymarket-copybot || true
pm2 start ecosystem.config.js --only polymarket-copybot
