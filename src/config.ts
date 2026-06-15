import * as dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function normalizePrivateKey(key: string): `0x${string}` {
  const trimmed = key.trim();
  const hex =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `Invalid PRIVATE_KEY: expected 64 hex chars (with or without 0x prefix), got length ${hex.length}`,
    );
  }
  return `0x${hex.toLowerCase()}` as `0x${string}`;
}

function parseTargetWallets(): string[] {
  const raw = process.env.TARGET_WALLETS;
  if (!raw) return []; // allowed — can be added later via Telegram
  return raw
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
}

export const config = {
  host: "https://clob.polymarket.com",
  privateKey: normalizePrivateKey(required("PRIVATE_KEY")),
  funderAddress: process.env.FUNDER_ADDRESS || "",
  signatureType: parseInt(process.env.SIGNATURE_TYPE || "3") as 0 | 1 | 2 | 3,

  targetWallets: parseTargetWallets(),

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000"),
  copySizeUsdc: parseFloat(process.env.COPY_SIZE_USDC || "0"),
  sizeMultiplier: parseFloat(process.env.SIZE_MULTIPLIER || "1.0"),
  maxTradeUsdc: parseFloat(process.env.MAX_TRADE_USDC || "100"),
  // Minimum copy size (USDC). Trades below this are SKIPPED.
  // Polymarket CLOB enforces $1 minimum on most markets — keep at 1 unless you know better.
  minTradeUsdc: parseFloat(process.env.MIN_TRADE_USDC || "1"),
  // Order type for live mode. GTC = Good-Til-Cancelled (order stays until filled or cancelled).
  // Supported values in clob-client-v2 are GTC and GTD.
  orderType: (process.env.ORDER_TYPE || "GTC").toUpperCase() as "GTC" | "GTD",
  dryRun: process.env.DRY_RUN !== "false",
  // Virtual starting balance used in dry-run mode so the bot can show how
  // much "money" you'd have left after the simulated trades.
  dryRunStartUsdc: parseFloat(process.env.DRY_RUN_START_USDC || "1000"),
  // Fee model used for both live estimates and dry-run accounting.
  // Example: 35 = 0.35%.
  liveFeeBps: parseFloat(process.env.LIVE_FEE_BPS || "0"),
  dryRunFeeBps: parseFloat(process.env.DRY_RUN_FEE_BPS || "0"),
  // Synthetic submit latency in dry-run so reported processing is closer to
  // real runtime behavior.
  dryRunSimulatedOrderLatencyMs: parseInt(
    process.env.DRY_RUN_SIMULATED_ORDER_LATENCY_MS || "250",
  ),

  // Optional SOCKS5/HTTP proxy (e.g. Cloudflare WARP: socks5://127.0.0.1:40000)
  proxyUrl: process.env.PROXY_URL || "",

  // Telegram
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
};
