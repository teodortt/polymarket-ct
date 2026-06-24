import * as dotenv from "dotenv";
import { resolve } from "path";

// Load .env from the repo root regardless of PM2/process working directory.
dotenv.config({ path: resolve(__dirname, "../.env") });

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
  scanIntervalMs: parseInt(process.env.WEATHER_SCAN_INTERVAL_MS || "1200000"),
  // Only trade events whose measurement day is within this many days. Near-term
  // forecasts are far more skillful, so keep this small.
  lookaheadDays: parseInt(process.env.WEATHER_LOOKAHEAD_DAYS || "3"),
  // Comma-separated case-insensitive city filter. Empty = every city found.
  cities: (process.env.WEATHER_CITIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Minimum edge (model probability − price paid) needed to fire a trade.
  minEdge: parseFloat(process.env.WEATHER_MIN_EDGE || "0.08"),
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
  minLiquidityUsdc: parseFloat(process.env.WEATHER_MIN_LIQUIDITY_USDC || "250"),
  // Ignore buys outside this price band (a "0.99 → 1.00" edge isn't tradeable).
  minPrice: parseFloat(process.env.WEATHER_MIN_PRICE || "0.02"),
  maxPrice: parseFloat(process.env.WEATHER_MAX_PRICE || "0.97"),
  // Trade-time near-settlement guard: skip PLACING orders on events resolving
  // within this many hours. Same-day (lead 0) markets are tradeable while the
  // high is still uncertain, so this — not `minLeadDays` — is what keeps us out
  // of books that already know the realized high. Discovery still surfaces
  // these events so the bias calibrator can observe their settled outcome.
  minHoursToResolve: parseFloat(
    process.env.WEATHER_MIN_HOURS_TO_RESOLVE || "6",
  ),
  // Never trade an event whose measurement day is fewer than this many days
  // away. Defaults to 0 so same-day markets ARE tradeable while the high is
  // still uncertain; the `minHoursToResolve` gate (not this one) keeps us out
  // of near-settlement same-day books. Set to 1 to disable same-day trading.
  minLeadDays: parseInt(process.env.WEATHER_MIN_LEAD_DAYS || "0"),
  maxTradesPerScan: parseInt(process.env.WEATHER_MAX_TRADES_PER_SCAN || "3"),
  maxTradesPerDay: parseInt(process.env.WEATHER_MAX_TRADES_PER_DAY || "20"),
  // KDE smoothing over ensemble members (°F). Covers integer rounding,
  // station-vs-grid bias and known ensemble under-dispersion. Widened from the
  // original 1.0 — live scans showed true daily-max error of 2–3°C, far beyond
  // the old σ, which made the model overconfident and manufactured false edges.
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
  // A bucket whose Yes price is at/above this is treated as the realized
  // outcome, used to learn each city's grid-vs-station bias from history.
  settleYesThreshold: parseFloat(
    process.env.WEATHER_SETTLE_YES_THRESHOLD || "0.9",
  ),
  // EMA weight for each new per-city bias sample (higher = adapts faster).
  biasEmaAlpha: parseFloat(process.env.WEATHER_BIAS_EMA_ALPHA || "0.35"),
  // Require this many scored samples before trusting/applying a city's bias.
  biasMinSamples: parseInt(process.env.WEATHER_BIAS_MIN_SAMPLES || "2"),
  // Clamp the learned correction so a bad sample can't wildly shift forecasts.
  maxCityBiasC: parseFloat(process.env.WEATHER_MAX_CITY_BIAS_C || "6"),
  // Hard capital-preservation cap: never stake more than this fraction of the
  // bankroll on one event, regardless of what Kelly suggests. Default 5%.
  maxBankrollFractionPerEvent: parseFloat(
    process.env.WEATHER_MAX_BANKROLL_FRACTION_PER_EVENT || "0.05",
  ),
  // Settlement-lock detector thresholds (intraday, obs-grounded near-arb).
  lockMinProb: parseFloat(process.env.WEATHER_LOCK_MIN_PROB || "0.98"),
  lockMaxAsk: parseFloat(process.env.WEATHER_LOCK_MAX_ASK || "0.95"),
  // Use the measured per-(city, lead) forecast-error σ from data/weatherBacktest.json
  // (produced by `npm run weather:backtest`) as a floor on the predictive
  // distribution width — kills the overconfidence that manufactured false edges.
  // Safe no-op when the file is absent. Default on.
  backtestSigmaFloor: process.env.WEATHER_BACKTEST_SIGMA_FLOOR !== "false",
  // Require at least this many scored days for a measured σ before trusting it.
  backtestMinSamples: parseInt(
    process.env.WEATHER_BACKTEST_MIN_SAMPLES || "20",
  ),
  // Exit management: automatically close positions based on P&L thresholds.
  exitEnabled: process.env.WEATHER_EXIT_ENABLED === "true",
  // Exit position when profit reaches this fraction (e.g. 0.60 = 60% ROI).
  exitProfitTarget: parseFloat(
    process.env.WEATHER_EXIT_PROFIT_TARGET || "0.75",
  ),
  // Exit position when loss reaches this fraction (e.g. -0.30 = 30% loss).
  exitStopLoss: parseFloat(process.env.WEATHER_EXIT_STOP_LOSS || "-0.30"),
  // Minimum hours to hold a position before exiting (prevents churn).
  exitMinHoursHeld: parseFloat(process.env.WEATHER_EXIT_MIN_HOURS_HELD || "1"),
  // How often to scan for exit opportunities (milliseconds).
  exitScanIntervalMs: parseInt(
    process.env.WEATHER_EXIT_SCAN_INTERVAL_MS || "60000",
  ),
  // Trend-based protective exit: after a position gets into profit, close it
  // if current P&L drops enough from its observed peak.
  exitTrendEnabled: process.env.WEATHER_EXIT_TREND_ENABLED === "true",
  exitTrendDropFromPeak: parseFloat(
    process.env.WEATHER_EXIT_TREND_DROP_FROM_PEAK || "0.08",
  ),
  exitTrendMinProfit: parseFloat(
    process.env.WEATHER_EXIT_TREND_MIN_PROFIT || "0.05",
  ),
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
