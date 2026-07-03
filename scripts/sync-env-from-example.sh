#!/usr/bin/env bash
# Sync non-sensitive defaults from .env.example into .env.
# - Updates existing keys in .env
# - Appends missing keys at the end
# - Skips sensitive keys (wallets/keys/tokens/chat IDs)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLE_FILE="$REPO_DIR/.env.example"
ENV_FILE="$REPO_DIR/.env"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [ ! -f "$EXAMPLE_FILE" ]; then
  echo "[env-sync] missing $EXAMPLE_FILE"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
fi

EXTRACTED="$TMP_DIR/example.tsv"
FILTERED="$TMP_DIR/example.filtered.tsv"
OUTPUT="$TMP_DIR/env.out"
BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"

awk '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  {
    line = $0
    if (line !~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) next
    split(line, p, "=")
    key = p[1]
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)

    val = substr(line, index(line, "=") + 1)
    sub(/[[:space:]]+#.*/, "", val)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)

    print key "\t" val
  }
' "$EXAMPLE_FILE" > "$EXTRACTED"

grep -Ev '^(PRIVATE_KEY|FUNDER_ADDRESS|TARGET_WALLETS|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)[[:space:]]' "$EXTRACTED" > "$FILTERED" || true

cp "$ENV_FILE" "$BACKUP"

awk -F '\t' '
  NR == FNR {
    map[$1] = $2
    order[++count] = $1
    next
  }
  {
    line = $0
    if (match(line, /^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=/)) {
      split(line, p, "=")
      key = p[1]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key in map) {
        print key "=" map[key]
        seen[key] = 1
        next
      }
    }
    print line
  }
  END {
    for (i = 1; i <= count; i++) {
      k = order[i]
      if (!(k in seen)) print k "=" map[k]
    }
  }
' "$FILTERED" "$ENV_FILE" > "$OUTPUT"

mv "$OUTPUT" "$ENV_FILE"

echo "[env-sync] synced non-sensitive values from .env.example into .env"
echo "[env-sync] backup saved: $BACKUP"
