export interface Trade {
  id: string;
  market: string;
  outcome: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  transactionHash: string;
  maker_address: string;
  taker_address: string;
  type: "MAKER" | "TAKER";
}

export interface MarketInfo {
  conditionId: string;
  tokenId: string;
  outcome: string;
  question: string;
  tickSize: string;
  negRisk: boolean;
}

export interface CopiedTrade {
  originalTrade: Trade;
  orderId?: string;
  status: "PLACED" | "FAILED" | "SKIPPED" | "DRY_RUN";
  reason?: string;
  timestamp: number;
  sourceWallet?: string; // wallet whose trade was copied
}

export interface WalletConfig {
  wallet: string;
  label?: string;
  enabled: boolean;
  sizeMultiplier: number; // e.g. 1.0 = 100%, 0.5 = 50%
  sizePercent: number; // 0–100: % of trader's size. 0 = disabled (use multiplier)
  maxTradeUsdc: number;
  copySizeUsdc: number; // fixed USDC amount. 0 = disabled
}

// ── Weather prediction + auto-trading module ──────────────────────────────────

export type TempUnit = "F" | "C";

// Tunables for the weather module (mirrors the env-driven `config.weather`).
export interface WeatherConfig {
  enabled: boolean;
  scanIntervalMs: number;
  lookaheadDays: number;
  cities: string[]; // case-insensitive substring filter; empty = all
  minEdge: number; // min |model − market| probability to fire a trade
  kellyFraction: number; // fractional-Kelly scaler (0.25 = quarter Kelly)
  bankrollUsdc: number; // 0 = auto (dry-run start / live USDC balance)
  maxTradeUsdc: number;
  minTradeUsdc: number;
  maxLiquidityFraction: number; // cap order at this share of bucket liquidity
  minLiquidityUsdc: number; // skip thinner buckets
  minPrice: number; // ignore buys cheaper than this (avoids 0-edges)
  maxPrice: number; // ignore buys richer than this
  minHoursToResolve: number; // skip events resolving sooner than this
  minLeadDays: number; // never trade events whose measurement day is < this away
  maxTradesPerScan: number;
  maxTradesPerDay: number;
  kdeBandwidthF: number; // KDE smoothing bandwidth in °F
  kdeLeadPerDayF: number; // extra bandwidth per lead day (°F)
  spreadInflation: number; // ensemble variance inflation (>=1)
  deterministicWeight: number; // 0–1 blend toward the high-res deterministic max
  disagreementSigmaWeight: number; // widen σ by this × |det − ensemble mean|
  models: string; // Open-Meteo ensemble model ids (comma separated)
  // Per-city bias calibration (learns the grid-forecast → resolution-station
  // offset from realized outcomes so 1° buckets stop being systematically off).
  settleYesThreshold: number; // a bucket Yes ≥ this is treated as the realized outcome
  biasEmaAlpha: number; // EMA weight for each new bias sample (0–1)
  biasMinSamples: number; // require this many samples before applying a city bias
  maxCityBiasC: number; // clamp the learned correction to ±this (°C)
  // Hard cap on the bankroll fraction risked on a single event, applied on top
  // of fractional-Kelly sizing (capital-preservation invariant).
  maxBankrollFractionPerEvent: number; // e.g. 0.05 = never risk >5% on one event
  // Settlement-lock detector (intraday, obs-grounded). A bucket is a near-arb
  // only when the realized-high-so-far makes it ≥ lockMinProb certain AND the
  // ask is still ≤ lockMaxAsk. Used read-only until lockTradingEnabled is true.
  lockMinProb: number; // conditional P(final high ∈ bucket | obs) to call it locked
  lockMaxAsk: number; // only a "gap" if the bucket still asks ≤ this
  // Measured-σ floor: widen the predictive distribution to at least the
  // empirically observed forecast-error σ (per city + lead) recorded by the
  // backtest harness. Prevents overconfident, phantom-edge forecasts.
  backtestSigmaFloor: boolean; // apply the measured σ floor when data is present
  backtestMinSamples: number; // min scored days before a measured σ is trusted
  // Exit management: auto-close positions based on P&L thresholds.
  exitEnabled: boolean; // enable automatic exit/exit scanning
  exitProfitTarget: number; // exit with >=this profit fraction (e.g. 0.60 = 60%)
  exitStopLoss: number; // exit with <=this loss fraction (e.g. -0.30 = 30% loss)
  exitMinHoursHeld: number; // min hours to hold before exiting (e.g. 1, 6, 24)
  exitScanIntervalMs: number; // how often to check for exit opportunities
}

export interface GeoPoint {
  lat: number;
  lon: number;
  name: string; // resolved canonical name
  timezone?: string;
}

// One temperature bucket within an event (a single binary Yes/No market).
export interface TempBucket {
  tokenIdYes: string;
  tokenIdNo: string;
  conditionId: string;
  question: string;
  label: string; // groupItemTitle, e.g. "84-85°F"
  // Continuous interval [lo, hi) in the market unit the bucket resolves over,
  // after expanding integer labels by ±0.5°. lo may be -Infinity, hi +Infinity.
  lo: number;
  hi: number;
  yesPrice: number; // implied probability (outcomePrices[0])
  bestBid: number | null;
  bestAsk: number | null;
  liquidity: number;
  tickSize: number;
  acceptingOrders: boolean;
  negRisk: boolean;
}

// A discovered "Highest temperature in <city> on <date>?" event.
export interface WeatherMarketEvent {
  id: string;
  title: string;
  slug: string;
  city: string; // raw city token from the title
  unit: TempUnit;
  targetDate: string; // YYYY-MM-DD local measurement date
  endDate?: string;
  buckets: TempBucket[];
}

export interface ForecastSummary {
  members: number;
  mean: number; // centre actually used (deterministic-anchored)
  std: number;
  min: number;
  max: number;
  p10: number;
  p50: number;
  p90: number;
  unit: TempUnit;
  leadDays: number;
  sigma: number; // KDE bandwidth actually used (market unit)
  det: number | null; // deterministic high-res daily max
  ensembleMean: number; // raw (un-anchored) ensemble mean
  rawCenter: number; // distribution centre BEFORE the per-city bias correction
  biasApplied: number; // per-city correction folded into the centre (market unit)
}

// Model-vs-market comparison for a single bucket.
export interface BucketSignal {
  bucket: TempBucket;
  modelProb: number; // P(outcome ∈ bucket) from the ensemble forecast
  marketProb: number; // mid implied probability (yesPrice)
  buyPrice: number | null; // price to BUY Yes now (bestAsk); null if no ask
  edge: number; // modelProb − buyPrice (−1 when not actionable)
  kellyFraction: number; // suggested bankroll fraction (pre-scaling)
}

// Event-level prediction.
export interface WeatherSignal {
  event: WeatherMarketEvent;
  geo: GeoPoint;
  forecast: ForecastSummary;
  buckets: BucketSignal[]; // sorted by modelProb desc
  best: BucketSignal | null; // best actionable positive-edge bucket
  generatedAt: number;
}

// Record of an executed/simulated weather trade (BUY entry or SELL exit).
export interface WeatherTradeRecord {
  ts: number;
  executionMode?: "DRY_RUN" | "LIVE";
  eventId: string;
  eventTitle: string;
  city: string;
  targetDate: string;
  bucketLabel: string;
  tokenId: string;
  side: "BUY" | "SELL";
  outcome: "Yes";
  price: number;
  sizeUsdc: number;
  modelProb?: number; // only for BUY entries
  marketProb?: number; // only for BUY entries
  edge?: number; // only for BUY entries
  pnlFraction?: number; // (exitPrice - entryPrice) / entryPrice, for exits
  pnlUsd?: number; // realized PnL in USD, for exits
  relatedBuyTradeId?: string; // references the BUY trade this SELL closes
  status: string; // PLACED | DRY_RUN | FAILED | SKIPPED
  reason?: string;
  orderId?: string;
}
