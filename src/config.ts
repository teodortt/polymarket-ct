import * as dotenv from "dotenv";
import { resolve } from "path";

// Load .env from the repo root regardless of PM2/process working directory.
const envResult = dotenv.config({ path: resolve(__dirname, "../.env") });

// PM2 can keep stale env snapshots across restarts/reloads. By default dotenv
// does not override existing process.env keys, so old WEATHER_* values may
// survive even after editing .env. Force .env precedence for weather knobs.
if (envResult.parsed) {
  for (const [k, v] of Object.entries(envResult.parsed)) {
    if (k.startsWith("WEATHER_")) {
      process.env[k] = v;
    }
  }
}

import { WeatherConfig } from "./types";

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

// ── Weather module (env-driven, all optional) ─────────────────────────────────
// Predicts Polymarket "Highest temperature in <city>" markets from a multi-model
// weather ensemble and auto-trades buckets the market misprices. Disabled unless
// WEATHER_ENABLED=true. Honors the global DRY_RUN flag for order placement.
const weather: WeatherConfig = {
  enabled: process.env.WEATHER_ENABLED === "true",
  // How often to rescan weather markets. Default 20 min — forecasts and order
  // books move slowly, so frequent scans add little but API load.
  scanIntervalMs: parseInt(process.env.WEATHER_SCAN_INTERVAL_MS || "600000"),
  // Only trade events whose measurement day is within this many days. Near-term
  // forecasts are far more skillful, so keep this small.
  lookaheadDays: parseInt(process.env.WEATHER_LOOKAHEAD_DAYS || "3"),
  // Allow same-day trading (lead 0) by default; same-day time risk is managed
  // by `sameDayCutoffHour` instead of event endDate.
  minLeadDays: parseInt(process.env.WEATHER_MIN_LEAD_DAYS || "0"),
  // Stop opening new same-day positions once local afternoon is mostly done.
  sameDayCutoffHour: parseInt(process.env.WEATHER_SAME_DAY_CUTOFF_HOUR || "16"),
  // Comma-separated case-insensitive city filter. Empty = every city found.
  cities: (process.env.WEATHER_CITIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Minimum edge (model probability − price paid) needed to fire a trade.
  minEdge: parseFloat(process.env.WEATHER_MIN_EDGE || "0.06"),
  // Fractional Kelly. 0.25 = quarter-Kelly (conservative, recommended).
  kellyFraction: parseFloat(process.env.WEATHER_KELLY_FRACTION || "0.25"),
  // Bankroll for Kelly sizing. 0 = auto (dry-run start balance / live USDC).
  bankrollUsdc: parseFloat(process.env.WEATHER_BANKROLL_USDC || "0"),
  maxTradeUsdc: parseFloat(process.env.WEATHER_MAX_TRADE_USDC || "20"),
  minTradeUsdc: parseFloat(process.env.WEATHER_MIN_TRADE_USDC || "1"),
  // Never consume more than this fraction of a bucket's resting liquidity.
  maxLiquidityFraction: parseFloat(
    process.env.WEATHER_MAX_LIQUIDITY_FRACTION ||
      process.env.WEATHER_MAX_LIQ_FRACTION ||
      "0.02",
  ),
  minLiquidityUsdc: parseFloat(process.env.WEATHER_MIN_LIQUIDITY_USDC || "150"),
  // Ignore buys outside this price band (a "0.99 → 1.00" edge isn't tradeable).
  minPrice: parseFloat(process.env.WEATHER_MIN_PRICE || "0.01"),
  maxPrice: parseFloat(process.env.WEATHER_MAX_PRICE || "0.97"),
  // Keep discovery broad; a same-day local-time cutoff is applied at trade-time.
  minHoursToResolve: parseFloat(
    process.env.WEATHER_MIN_HOURS_TO_RESOLVE || "0",
  ),
  maxTradesPerScan: parseInt(process.env.WEATHER_MAX_TRADES_PER_SCAN || "6"),
  maxTradesPerDay: parseInt(process.env.WEATHER_MAX_TRADES_PER_DAY || "30"),
  // KDE smoothing over ensemble members (°F). Covers integer rounding,
  // station-vs-grid bias and known ensemble under-dispersion.
  kdeBandwidthF: parseFloat(process.env.WEATHER_KDE_BANDWIDTH_F || "2.0"),
  kdeLeadPerDayF: parseFloat(process.env.WEATHER_KDE_LEAD_PER_DAY_F || "0.25"),
  // Inflate ensemble spread around its mean (>=1) to improve calibration.
  spreadInflation: parseFloat(process.env.WEATHER_SPREAD_INFLATION || "1.1"),
  // Blend the distribution centre toward the high-resolution deterministic
  // forecast (0 = pure ensemble, 1 = pure deterministic). The deterministic
  // model is more skilful for the daily max and removes ensemble temp biases.
  deterministicWeight: parseFloat(
    process.env.WEATHER_DETERMINISTIC_WEIGHT || "0.6",
  ),
  // When the deterministic and ensemble means disagree, widen the forecast by
  // this × the gap — a built-in epistemic-uncertainty brake on false edges.
  disagreementSigmaWeight: parseFloat(
    process.env.WEATHER_DISAGREEMENT_SIGMA_WEIGHT || "0.6",
  ),
  models:
    process.env.WEATHER_MODELS || "gfs_seamless,icon_seamless,ecmwf_ifs025",
};

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
  // This is most reliable with Polymarket's CLOB API.
  orderType: (process.env.ORDER_TYPE || "GTC").toUpperCase() as
    | "FAK"
    | "GTC"
    | "FOK",
  dryRun: process.env.DRY_RUN !== "false",
  // Virtual starting balance used in dry-run mode so the bot can show how
  // much "money" you'd have left after the simulated trades.
  dryRunStartUsdc: parseFloat(process.env.DRY_RUN_START_USDC || "1000"),

  // Optional SOCKS5/HTTP proxy (e.g. Cloudflare WARP: socks5://127.0.0.1:40000)
  proxyUrl: process.env.PROXY_URL || "",

  // Telegram
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),

  // Weather prediction + auto-trading module
  weather,
};
