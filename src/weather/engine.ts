import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import { config } from "../config";
import {
  TempBucket,
  TempUnit,
  Trade,
  WeatherMarketEvent,
  WeatherSignal,
  WeatherTradeRecord,
  GeoPoint,
} from "../types";
import { copyTradeWithSize, getLiveUsdcBalance } from "../trader";
import { resolveCity } from "./geocode";
import { buildForecastDistribution, leadDaysUntil } from "./forecast";
import { fetchStationObs } from "./resolution";
import {
  BacktestStore,
  loadBacktestStore,
  measuredErrorSigmaC,
} from "./backtest";
import { discoverTemperatureEvents } from "./markets";
import { predictEvent } from "./predictor";
import { formatReport } from "./report";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "weather.json");
const CALIB_PATH = path.join(DATA_DIR, "weatherCalibration.json");
const BACKTEST_PATH = path.join(DATA_DIR, "weatherBacktest.json");
const TRADES_MAX = 1000;
const CLOB_API = "https://clob.polymarket.com";

// Minimal sink so the engine never depends on the Telegram module directly.
export interface WeatherNotifier {
  send(text: string): Promise<unknown> | unknown;
}

export interface WeatherDataProviders {
  getOrders?: () => Promise<any[]>;
}

interface WeatherState {
  trades: WeatherTradeRecord[];
  // local-date → token ids already traded that day (dedupe).
  traded: Record<string, string[]>;
  // per-position runtime state for trend-based exits
  exitTrend: Record<string, ExitTrendState>;
}

interface ExitTrendState {
  peakPnlFraction: number;
  lastPnlFraction: number;
  updatedAt: number;
}

interface CityBias {
  offsetC: number; // learned grid→station correction, in °C
  samples: number;
  unit: TempUnit;
  updatedAt: number;
}

// Persistent learning store for the per-city bias correction.
interface CalibrationState {
  // `${cityKey}|${targetDate}` → latest uncorrected forecast centre.
  centers: Record<string, { rawCenter: number; unit: TempUnit; at: number }>;
  // `${cityKey}|${targetDate}` → realized daily-high centre. `source` records
  // whether it came from official station obs (ground truth) or the market
  // price proxy (fallback for stations NWS doesn't cover).
  realized: Record<
    string,
    { center: number; unit: TempUnit; at: number; source?: "obs" | "market" }
  >;
  // keys already folded into a city's bias (so each day counts once).
  scored: string[];
  // cityKey → learned bias.
  bias: Record<string, CityBias>;
}

interface WeatherPnLByDate {
  pnl: number;
  invested: number;
  pricedTrades: number;
  totalTrades: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayStr(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function tradeExecutionMode(trade: WeatherTradeRecord): "DRY_RUN" | "LIVE" {
  if (trade.executionMode === "DRY_RUN" || trade.executionMode === "LIVE") {
    return trade.executionMode;
  }
  return trade.status === "DRY_RUN" ? "DRY_RUN" : "LIVE";
}

function cityKey(city: string): string {
  return city.trim().toLowerCase();
}

// Representative realized value for a winning bucket interval (market unit).
function bucketCenter(lo: number, hi: number): number {
  if (Number.isFinite(lo) && Number.isFinite(hi)) return (lo + hi) / 2;
  if (!Number.isFinite(lo) && Number.isFinite(hi)) return hi - 0.5; // "x or below"
  if (Number.isFinite(lo) && !Number.isFinite(hi)) return lo + 0.5; // "x or higher"
  return NaN;
}

export class WeatherEngine {
  private cfg = config.weather;
  private notifier?: WeatherNotifier;
  private dataProviders: WeatherDataProviders = {};
  private running = false;
  private state: WeatherState = { trades: [], traded: {}, exitTrend: {} };
  private calib: CalibrationState = {
    centers: {},
    realized: {},
    scored: [],
    bias: {},
  };
  private lastSignals: WeatherSignal[] = [];
  private lastScanAt = 0;
  // Measured per-(city, lead) forecast-error σ, read from data/weatherBacktest.json
  // (produced by `npm run weather:backtest`). Used as a floor on forecast width.
  private backtest: BacktestStore | null = null;

  constructor(
    notifier?: WeatherNotifier,
    dataProviders?: WeatherDataProviders,
  ) {
    this.notifier = notifier;
    this.dataProviders = dataProviders ?? {};
    this.loadState();
    this.loadCalibration();
    this.loadBacktest();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async start() {
    if (this.running) {
      console.log("[Weather] start() ignored — already running.");
      return;
    }
    this.running = true;
    if (config.weather.enabled) {
      console.log(
        `🌦  [Weather] started | every ${Math.round(this.cfg.scanIntervalMs / 60000)}m | ` +
          `lookahead ${this.cfg.lookaheadDays}d | minEdge ${(this.cfg.minEdge * 100).toFixed(0)}% | ` +
          `dry ${config.dryRun}`,
      );
      await this.notifier?.send(
        `🌦 *Weather engine started*\nScan every ${Math.round(this.cfg.scanIntervalMs / 60000)}m • ` +
          `min edge ${(this.cfg.minEdge * 100).toFixed(0)}% • Dry: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}`,
      );
    } else {
      console.log(
        "[Weather] started in standby (disabled). Use Telegram to enable.",
      );
    }

    // Track when to run next exit scan
    let nextExitScanAt = Date.now() + this.cfg.exitScanIntervalMs;

    while (this.running) {
      try {
        if (config.weather.enabled) {
          await this.scanOnce();
          // Opportunistically scan for exits
          if (this.cfg.exitEnabled && Date.now() >= nextExitScanAt) {
            await this.scanForExits();
            nextExitScanAt = Date.now() + this.cfg.exitScanIntervalMs;
          }
        }
      } catch (err: any) {
        console.error("[Weather] scan error:", err?.message ?? err);
      }
      await sleep(this.cfg.scanIntervalMs);
    }
  }

  stop() {
    this.running = false;
  }

  // ── scanning ────────────────────────────────────────────────────────────────
  /**
   * One full pass: discover events, build a forecast + prediction for each,
   * and (when `place` is true) act on the best mispriced bucket. Returns every
   * computed signal so callers (CLI/report) can inspect predictions.
   */
  async scanOnce(opts: { place?: boolean } = {}): Promise<WeatherSignal[]> {
    const place = opts.place ?? true;
    const events = await discoverTemperatureEvents({
      lookaheadDays: this.cfg.lookaheadDays,
      cities: this.cfg.cities,
      // Keep near-settlement events visible so the bias calibrator can still
      // observe their realized high late in the day. The near-settlement
      // *trade* guard is applied per-event in `maybeTrade` instead.
      minHoursToResolve: 0,
    });
    console.log(`[Weather] scan: ${events.length} event(s) in window.`);

    const bankroll = place ? await this.resolveBankroll() : 0;
    const signals: WeatherSignal[] = [];
    let placedThisScan = 0;

    // Per-scan caches: avoid re-fetching the same city geocode or the same
    // (city, unit, targetDate) forecast when multiple market buckets share
    // the same underlying data point. Each unique combination fires exactly
    // one pair of HTTP requests instead of one per market bucket.
    const geoCache = new Map<string, ReturnType<typeof resolveCity>>();
    const forecastCache = new Map<
      string,
      ReturnType<typeof buildForecastDistribution>
    >();

    for (const event of events) {
      try {
        let geoPromise = geoCache.get(event.city);
        if (!geoPromise) {
          geoPromise = resolveCity(event.city);
          geoCache.set(event.city, geoPromise);
        }
        const geo = await geoPromise;
        if (!geo) {
          console.warn(`[Weather] no coordinates for "${event.city}" — skip.`);
          continue;
        }
        const biasOffset = this.cityBiasOffset(event.city, event.unit);
        const sigmaFloor = this.measuredSigmaFloor(
          geo,
          event.unit,
          leadDaysUntil(event.targetDate),
        );
        const forecastKey = `${event.city}|${event.unit}|${event.targetDate}`;
        let forecastPromise = forecastCache.get(forecastKey);
        if (!forecastPromise) {
          forecastPromise = buildForecastDistribution(
            geo,
            event.unit,
            event.targetDate,
            this.cfg,
            biasOffset,
            sigmaFloor,
          );
          forecastCache.set(forecastKey, forecastPromise);
        }
        const forecast = await forecastPromise;
        if (!forecast) continue;

        const signal = predictEvent(event, geo, forecast, this.cfg);
        signals.push(signal);

        // Ground-truth calibration: on the measurement day, read the official
        // resolution-station obs. Once the day's heating is done the observed
        // high is effectively the settled daily max — a non-circular realized
        // value, far better than inferring it from the market's own price.
        let realized: { obsMax?: number; nwsCovered: boolean } | undefined;
        if (signal.forecast.leadDays === 0) {
          const obs = await fetchStationObs(geo, event.unit, event.targetDate);
          realized = obs
            ? {
                nwsCovered: true,
                obsMax: obs.localHour >= 17 ? obs.obsMaxSoFar : undefined,
              }
            : { nwsCovered: false };
        }
        this.learnFromEvent(event, signal, realized);

        if (
          place &&
          placedThisScan < this.cfg.maxTradesPerScan &&
          this.tradesToday() < this.cfg.maxTradesPerDay
        ) {
          const acted = await this.maybeTrade(signal, bankroll);
          if (acted) placedThisScan++;
        }
      } catch (err: any) {
        console.error(
          `[Weather] event "${event.title}" failed: ${err?.message ?? err}`,
        );
      }
      await sleep(1_500); // rate-limit buffer for Open-Meteo API
    }

    this.lastSignals = signals;
    this.lastScanAt = Date.now();
    if (place) {
      if (placedThisScan > 0) {
        console.log(`[Weather] placed ${placedThisScan} order(s) this scan.`);
      } else {
        const effectiveMinBankroll =
          this.cfg.minTradeUsdc /
          Math.max(this.cfg.maxBankrollFractionPerEvent, 1e-9);
        const fundsNote =
          bankroll < effectiveMinBankroll
            ? ` — bankroll $${bankroll.toFixed(2)} is below the ~$${effectiveMinBankroll.toFixed(2)} needed to clear the $${this.cfg.minTradeUsdc.toFixed(2)} min trade at a ${this.cfg.maxBankrollFractionPerEvent} per-event cap; fund the live wallet to trade`
            : "";
        console.log(
          `[Weather] no orders placed this scan (${signals.length} signal(s) evaluated)${fundsNote}`,
        );
      }
    }
    return signals;
  }

  // ── trading decision ──────────────────────────────────────────────────────────
  private async maybeTrade(
    signal: WeatherSignal,
    bankroll: number,
  ): Promise<boolean> {
    const best = signal.best;
    if (!best || best.buyPrice == null) return false;

    // Never trade essentially-settled, same-day outcomes — the book already
    // knows the realized high while the forecast still shows its prior guess.
    if (signal.forecast.leadDays < this.cfg.minLeadDays) return false;

    // Same-day (lead 0) markets are tradeable while the day's high is still
    // uncertain, but once the city is past its afternoon heating peak the high
    // is effectively locked and a stale forecast would just trade against a
    // market that already knows the outcome. Polymarket's `endDate` is always
    // 12:00 UTC (the local MORNING for western cities), so it can't tell us
    // this — instead approximate the city's local wall-clock from longitude
    // (±1h is plenty for a peak-heating cutoff) and compare it to the
    // measurement day. Skip only once we're at/after the cutoff ON that day.
    if (signal.forecast.leadDays === 0 && this.cfg.sameDayCutoffHour < 24) {
      const offsetMs = (signal.geo.lon / 15) * 3_600_000;
      const localNow = new Date(Date.now() + offsetMs);
      const localDate = localNow.toISOString().slice(0, 10);
      const localHour = localNow.getUTCHours() + localNow.getUTCMinutes() / 60;
      const onOrAfterPeak =
        localDate > signal.event.targetDate ||
        (localDate === signal.event.targetDate &&
          localHour >= this.cfg.sameDayCutoffHour);
      if (onOrAfterPeak) return false;
    }

    const bucket = best.bucket;
    // One position per city+date. Buckets are mutually exclusive, so stacking
    // adjacent ones across scans/days just guarantees losers.
    if (
      this.hasOpenPositionForEvent(signal.event.city, signal.event.targetDate)
    ) {
      return false;
    }
    // Already traded this bucket today — don't stack.
    if (this.tradedTokens().includes(bucket.tokenIdYes)) return false;

    // Kelly-sized notional, capped by config and available liquidity.
    const frac = best.kellyFraction * this.cfg.kellyFraction;
    let notional = frac * bankroll;
    notional = Math.min(
      notional,
      this.cfg.maxTradeUsdc,
      // Hard capital-preservation invariant: never risk more than the
      // configured bankroll fraction on a single event, whatever Kelly says.
      bankroll * this.cfg.maxBankrollFractionPerEvent,
      bucket.liquidity * this.cfg.maxLiquidityFraction,
    );
    notional = Math.floor(notional * 100) / 100;
    if (notional < this.cfg.minTradeUsdc) {
      console.log(
        `[Weather] skip ${signal.event.city} ${signal.event.targetDate}: ` +
          `notional $${notional.toFixed(2)} < minTrade $${this.cfg.minTradeUsdc.toFixed(2)} ` +
          `(bankroll $${bankroll.toFixed(2)} × ${this.cfg.maxBankrollFractionPerEvent} cap — fund the live wallet to trade this edge)`,
      );
      return false;
    }

    // Limit price: cross the spread slightly for fill, but never above fair
    // value (model prob) or the configured ceiling.
    const tick = bucket.tickSize || 0.001;
    const ceil = Math.min(best.modelProb, this.cfg.maxPrice, 1 - tick);
    let limit = Math.min(best.buyPrice + 2 * tick, ceil);
    if (limit < best.buyPrice) limit = best.buyPrice;

    const trade: Trade = {
      id: `weather-${bucket.tokenIdYes}-${Date.now()}`,
      market: bucket.conditionId,
      outcome: "Yes",
      tokenId: bucket.tokenIdYes,
      side: "BUY",
      price: limit,
      size: notional,
      timestamp: Math.floor(Date.now() / 1000),
      transactionHash: "",
      maker_address: "",
      taker_address: "",
      type: "TAKER",
    };

    console.log(
      `[Weather] 🎯 ${signal.event.city} ${signal.event.targetDate} | ${bucket.label} | ` +
        `model ${(best.modelProb * 100).toFixed(1)}% vs ask ${(best.buyPrice * 100).toFixed(1)}% ` +
        `→ edge +${(best.edge * 100).toFixed(1)}% | $${notional.toFixed(2)} @ ${limit}`,
    );

    const result = await copyTradeWithSize(trade, notional);

    const rec: WeatherTradeRecord = {
      ts: Date.now(),
      executionMode: this.currentExecutionMode(),
      eventId: signal.event.id,
      eventTitle: signal.event.title,
      city: signal.event.city,
      targetDate: signal.event.targetDate,
      bucketLabel: bucket.label,
      tokenId: bucket.tokenIdYes,
      conditionId: bucket.conditionId,
      side: "BUY",
      outcome: "Yes",
      price: limit,
      sizeUsdc: notional,
      modelProb: best.modelProb,
      marketProb: best.marketProb,
      edge: best.edge,
      status: result.status,
      reason: result.reason,
      orderId: result.orderId,
    };
    this.recordTrade(rec);

    await this.notifyTrade(signal, rec);
    return result.status === "PLACED" || result.status === "DRY_RUN";
  }

  // ── exit management ──────────────────────────────────────────────────────────
  /**
   * Scan for open positions that should be exited based on P&L thresholds or
   * profit-taking targets. Runs periodically in the main loop.
   */
  private async scanForExits(): Promise<void> {
    const openPositions = this.getOpenPositions();
    if (openPositions.length === 0) return;

    this.pruneExitTrend(openPositions);

    console.log(
      `[Weather] Scanning ${openPositions.length} open position(s) for exits...`,
    );

    for (const buyTrade of openPositions) {
      try {
        await this.maybeExitPosition(buyTrade);
      } catch (err: any) {
        console.error(
          `[Weather] Exit scan failed for ${buyTrade.tokenId}: ${err?.message ?? err}`,
        );
      }
      await sleep(250); // be polite to API
    }
  }

  /**
   * Find all open BUY positions (trades without a corresponding SELL).
   * Public so Telegram can query and manually trigger exits.
   */
  getOpenPositions(): WeatherTradeRecord[] {
    const opens: WeatherTradeRecord[] = [];

    // Return all active BUY trades that still have remaining shares to exit.
    for (const trade of this.activeTrades()) {
      if (trade.side !== "BUY") continue;
      if (!(trade.status === "PLACED" || trade.status === "DRY_RUN")) continue;
      if (this.isTerminalExitSkip(trade)) continue;
      if (this.remainingSharesForBuyTrade(trade) <= 0.000001) continue;

      opens.push(trade);
    }

    return opens;
  }

  private isTerminalExitSkip(buyTrade: WeatherTradeRecord): boolean {
    return this.activeTrades().some(
      (trade) =>
        trade.side === "SELL" &&
        trade.status === "SKIPPED" &&
        this.matchesExitToBuyTrade(buyTrade, trade) &&
        /minimum|too small to exit/i.test(String(trade.reason ?? "")),
    );
  }

  private matchesExitToBuyTrade(
    buyTrade: WeatherTradeRecord,
    exitTrade: WeatherTradeRecord,
  ): boolean {
    if (exitTrade.side !== "SELL") return false;
    if (
      buyTrade.orderId &&
      exitTrade.relatedBuyTradeId &&
      exitTrade.relatedBuyTradeId === buyTrade.orderId
    ) {
      return true;
    }

    // Backward-compat fallback for historical records missing relatedBuyTradeId.
    return (
      exitTrade.tokenId === buyTrade.tokenId &&
      exitTrade.ts >= buyTrade.ts &&
      (!exitTrade.relatedBuyTradeId || !buyTrade.orderId)
    );
  }

  private remainingSharesForBuyTrade(buyTrade: WeatherTradeRecord): number {
    const buyShares =
      buyTrade.price > 0 ? buyTrade.sizeUsdc / buyTrade.price : 0;
    if (!Number.isFinite(buyShares) || buyShares <= 0) return 0;

    let soldShares = 0;
    for (const trade of this.activeTrades()) {
      if (
        trade.side === "SELL" &&
        (trade.status === "PLACED" || trade.status === "DRY_RUN") &&
        this.matchesExitToBuyTrade(buyTrade, trade)
      ) {
        const shares = trade.price > 0 ? trade.sizeUsdc / trade.price : 0;
        if (Number.isFinite(shares) && shares > 0) {
          soldShares += shares;
        }
      }
    }

    return Math.max(0, buyShares - soldShares);
  }

  /**
   * Check if a position should be exited based on P&L thresholds.
   * Returns {pnlFraction, exitPrice, shouldExit, reason}.
   */
  private async calculatePositionPnL(buyTrade: WeatherTradeRecord): Promise<{
    pnlFraction: number | null;
    exitPrice: number | null;
    shouldExit: boolean;
    reason: string;
  }> {
    // Fetch current market price for liquidation (SELL side).
    let exitPrice: number | null = null;
    try {
      const res = await axios.get(`${CLOB_API}/price`, {
        params: { token_id: buyTrade.tokenId, side: "SELL" },
        timeout: 3000,
      });
      exitPrice = parseFloat(res.data?.price ?? "NaN");
      if (!Number.isFinite(exitPrice)) exitPrice = null;
    } catch {
      /* ignore fetch errors; just can't exit this time */
    }

    if (!exitPrice) {
      return {
        pnlFraction: null,
        exitPrice: null,
        shouldExit: false,
        reason: "No market price available",
      };
    }

    const pnlFraction = (exitPrice - buyTrade.price) / buyTrade.price;
    const hoursHeld = (Date.now() - buyTrade.ts) / (1000 * 3600);

    // Check hold time
    if (hoursHeld < this.cfg.exitMinHoursHeld) {
      return {
        pnlFraction,
        exitPrice,
        shouldExit: false,
        reason: `Only held ${hoursHeld.toFixed(1)}h (min ${this.cfg.exitMinHoursHeld}h)`,
      };
    }

    // Trend-exit: if a profitable position drops far enough from its own
    // observed peak P&L, close it early (independent of fixed stop/profit).
    if (this.cfg.exitTrendEnabled) {
      const trend = this.updateExitTrendState(buyTrade, pnlFraction);
      const dropFromPeak = trend.peakPnlFraction - pnlFraction;
      if (
        trend.peakPnlFraction >= this.cfg.exitTrendMinProfit &&
        pnlFraction > 0 &&
        dropFromPeak >= this.cfg.exitTrendDropFromPeak
      ) {
        return {
          pnlFraction,
          exitPrice,
          shouldExit: true,
          reason:
            `Trend down from peak: peak ${(trend.peakPnlFraction * 100).toFixed(1)}% ` +
            `→ now ${(pnlFraction * 100).toFixed(1)}% ` +
            `(drop ${(dropFromPeak * 100).toFixed(1)}%)`,
        };
      }
    }

    // In trend-exit mode we let winners run and only protect gains via
    // drawdown-from-peak, so the fixed take-profit does not force an early cap.
    if (
      !this.cfg.exitTrendEnabled &&
      pnlFraction >= this.cfg.exitProfitTarget
    ) {
      return {
        pnlFraction,
        exitPrice,
        shouldExit: true,
        reason: `Hit profit target: +${(pnlFraction * 100).toFixed(1)}%`,
      };
    }

    // Check stop loss
    if (pnlFraction <= this.cfg.exitStopLoss) {
      return {
        pnlFraction,
        exitPrice,
        shouldExit: true,
        reason: `Hit stop loss: ${(pnlFraction * 100).toFixed(1)}%`,
      };
    }

    return {
      pnlFraction,
      exitPrice,
      shouldExit: false,
      reason: `Within thresholds (${(pnlFraction * 100).toFixed(1)}%)`,
    };
  }

  /**
   * Check if an open position should be exited and place a SELL if so.
   * Public so Telegram can manually trigger exits.
   */
  async maybeExitPosition(buyTrade: WeatherTradeRecord): Promise<void> {
    const pnlInfo = await this.calculatePositionPnL(buyTrade);

    if (!pnlInfo.shouldExit) {
      // Just log, don't exit
      if (pnlInfo.exitPrice) {
        const pnlPct = pnlInfo.pnlFraction
          ? (pnlInfo.pnlFraction * 100).toFixed(1)
          : "?";
        console.log(
          `[Weather] ${buyTrade.city}/${buyTrade.bucketLabel}: ${pnlPct}% ` +
            `(${pnlInfo.reason})`,
        );
      }
      return;
    }

    if (!pnlInfo.exitPrice) {
      console.warn(
        `[Weather] Cannot exit ${buyTrade.tokenId}: no market price`,
      );
      return;
    }

    // Place SELL order
    console.log(
      `[Weather] 🚪 Exiting ${buyTrade.city}/${buyTrade.bucketLabel}: ` +
        `${pnlInfo.reason} | Price: ${buyTrade.price} → ${pnlInfo.exitPrice}`,
    );

    const remainingShares = this.remainingSharesForBuyTrade(buyTrade);
    if (!Number.isFinite(remainingShares) || remainingShares <= 0.000001) {
      return;
    }
    const remainingSizeUsdc = remainingShares * buyTrade.price;

    const trade: Trade = {
      id: `weather-exit-${buyTrade.tokenId}-${Date.now()}`,
      market: buyTrade.conditionId ?? "",
      outcome: "Yes",
      tokenId: buyTrade.tokenId,
      side: "SELL",
      price: pnlInfo.exitPrice,
      size: remainingShares,
      timestamp: Math.floor(Date.now() / 1000),
      transactionHash: "",
      maker_address: "",
      taker_address: "",
      type: "TAKER",
    };

    const result = await copyTradeWithSize(trade, remainingSizeUsdc);

    const soldShares = Math.max(
      0,
      result.submittedSizeShares ?? remainingShares,
    );
    const soldSizeUsdc = Math.max(
      0,
      result.submittedNotionalUsdc ?? soldShares * buyTrade.price,
    );

    const pnlUsd = (pnlInfo.exitPrice - buyTrade.price) * soldShares;

    const rec: WeatherTradeRecord = {
      ts: Date.now(),
      executionMode: this.currentExecutionMode(),
      eventId: buyTrade.eventId,
      eventTitle: buyTrade.eventTitle,
      city: buyTrade.city,
      targetDate: buyTrade.targetDate,
      bucketLabel: buyTrade.bucketLabel,
      tokenId: buyTrade.tokenId,
      side: "SELL",
      outcome: "Yes",
      price: pnlInfo.exitPrice,
      sizeUsdc: soldSizeUsdc,
      pnlFraction: pnlInfo.pnlFraction || 0,
      pnlUsd,
      relatedBuyTradeId: buyTrade.orderId,
      status: result.status,
      reason: result.reason || pnlInfo.reason,
      orderId: result.orderId,
    };
    this.recordTrade(rec);

    const fullyClosed = soldShares >= remainingShares - 0.000001;
    if (
      (result.status === "PLACED" || result.status === "DRY_RUN") &&
      fullyClosed
    ) {
      delete this.state.exitTrend[this.positionKey(buyTrade)];
      this.saveState();
    }

    await this.notifyExit(buyTrade, rec);
  }

  private positionKey(buyTrade: WeatherTradeRecord): string {
    return buyTrade.orderId
      ? `order:${buyTrade.orderId}`
      : `${buyTrade.tokenId}:${buyTrade.ts}:${buyTrade.price}:${buyTrade.sizeUsdc}`;
  }

  private updateExitTrendState(
    buyTrade: WeatherTradeRecord,
    pnlFraction: number,
  ): ExitTrendState {
    const key = this.positionKey(buyTrade);
    const cur = this.state.exitTrend[key];
    const peakPnlFraction = cur
      ? Math.max(cur.peakPnlFraction, pnlFraction)
      : pnlFraction;
    const next: ExitTrendState = {
      peakPnlFraction,
      lastPnlFraction: pnlFraction,
      updatedAt: Date.now(),
    };
    this.state.exitTrend[key] = next;
    this.saveState();
    return next;
  }

  private pruneExitTrend(openPositions: WeatherTradeRecord[]) {
    const openKeys = new Set(openPositions.map((p) => this.positionKey(p)));
    let changed = false;
    for (const key of Object.keys(this.state.exitTrend)) {
      if (!openKeys.has(key)) {
        delete this.state.exitTrend[key];
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  // ── bankroll / accounting ─────────────────────────────────────────────────────
  private async resolveBankroll(): Promise<number> {
    if (this.cfg.bankrollUsdc > 0) return this.cfg.bankrollUsdc;
    if (config.dryRun) return config.dryRunStartUsdc;
    const live = await getLiveUsdcBalance();
    return live?.balance ?? this.cfg.maxTradeUsdc * 10;
  }

  private currentExecutionMode(): "DRY_RUN" | "LIVE" {
    return config.dryRun ? "DRY_RUN" : "LIVE";
  }

  private activeTrades(): WeatherTradeRecord[] {
    const mode = this.currentExecutionMode();
    return this.state.trades.filter(
      (trade) => tradeExecutionMode(trade) === mode,
    );
  }

  private tradedTokens(): string[] {
    const today = todayStr();
    return this.activeTrades()
      .filter(
        (trade) =>
          todayStr(trade.ts) === today &&
          (trade.status === "PLACED" || trade.status === "DRY_RUN"),
      )
      .map((trade) => trade.tokenId);
  }

  private tradesToday(): number {
    const t = todayStr();
    return this.activeTrades().filter(
      (r) =>
        todayStr(r.ts) === t &&
        (r.status === "PLACED" || r.status === "DRY_RUN"),
    ).length;
  }

  private recordTrade(rec: WeatherTradeRecord) {
    this.state.trades.push(rec);
    if (this.state.trades.length > TRADES_MAX) {
      this.state.trades = this.state.trades.slice(-TRADES_MAX);
    }
    if (rec.status === "PLACED" || rec.status === "DRY_RUN") {
      const day = todayStr(rec.ts);
      const set = new Set(this.state.traded[day] ?? []);
      set.add(rec.tokenId);
      this.state.traded[day] = [...set];
      this.pruneTradedDates();
    }
    this.saveState();
  }

  // Keep only the last 7 day-keys in the dedupe map.
  private pruneTradedDates() {
    const days = Object.keys(this.state.traded).sort();
    while (days.length > 7) {
      const d = days.shift();
      if (d) delete this.state.traded[d];
    }
  }

  // ── per-city bias calibration ─────────────────────────────────────────────
  // Learn the systematic gap between the forecast grid cell and the official
  // station each market resolves against — from realized outcomes — and correct
  // future forecasts by it. Without this, 1° buckets stay perpetually off.

  // Learned correction for a city, in the market's unit (0 until trusted).
  private cityBiasOffset(city: string, unit: TempUnit): number {
    const entry = this.calib.bias[cityKey(city)];
    if (!entry || entry.samples < this.cfg.biasMinSamples) return 0;
    const cap = this.cfg.maxCityBiasC;
    const offsetC = Math.max(-cap, Math.min(cap, entry.offsetC));
    return unit === "F" ? offsetC * 1.8 : offsetC; // stored in °C
  }

  // Empirically-measured forecast-error σ (backtest harness) for this location
  // and lead, converted to the market unit. Returned as a floor the forecast
  // builder uses to widen an overconfident distribution. Undefined (no floor)
  // when disabled or there is not enough measured history.
  private measuredSigmaFloor(
    geo: GeoPoint,
    unit: TempUnit,
    leadDays: number,
  ): number | undefined {
    if (!this.cfg.backtestSigmaFloor) return undefined;
    const sigmaC = measuredErrorSigmaC(
      this.backtest,
      geo,
      leadDays,
      this.cfg.backtestMinSamples,
    );
    if (sigmaC == null) return undefined;
    return unit === "F" ? sigmaC * 1.8 : sigmaC; // stored in °C
  }

  // Record this scan's forecast centre, capture the realized daily high, and
  // fold the (predicted, realized) gap into the city bias. The realized high is
  // taken from official station obs when available (ground truth), falling back
  // to the market-price proxy only for cities NWS doesn't cover.
  private learnFromEvent(
    event: WeatherMarketEvent,
    signal: WeatherSignal,
    realized?: { obsMax?: number; nwsCovered: boolean },
  ) {
    const key = `${cityKey(event.city)}|${event.targetDate}`;

    // Overwrite with the freshest (lowest-lead) uncorrected centre, so scoring
    // isolates the representativeness bias rather than lead-time forecast error.
    this.calib.centers[key] = {
      rawCenter: signal.forecast.rawCenter,
      unit: event.unit,
      at: Date.now(),
    };

    // Realized capture only makes sense on the measurement day itself.
    if (signal.forecast.leadDays === 0) {
      if (realized?.obsMax != null && Number.isFinite(realized.obsMax)) {
        // Ground truth from the resolution station (day's heating done). Always
        // prefer this; let it upgrade a prior market-proxy estimate.
        const existing = this.calib.realized[key];
        if (!existing || existing.source !== "obs") {
          this.calib.realized[key] = {
            center: realized.obsMax,
            unit: event.unit,
            at: Date.now(),
            source: "obs",
          };
        }
      } else if (!realized?.nwsCovered && !this.calib.realized[key]) {
        // Fallback for non-NWS stations: once the market parks a bucket at/above
        // the settle threshold, treat its centre as the observed daily high.
        let top: TempBucket | null = null;
        for (const b of event.buckets) {
          if (!top || b.yesPrice > top.yesPrice) top = b;
        }
        if (top && top.yesPrice >= this.cfg.settleYesThreshold) {
          const center = bucketCenter(top.lo, top.hi);
          if (Number.isFinite(center)) {
            this.calib.realized[key] = {
              center,
              unit: event.unit,
              at: Date.now(),
              source: "market",
            };
          }
        }
      }
    }

    // Fold a completed (predicted, realized) pair into the city's bias once.
    const c = this.calib.centers[key];
    const r = this.calib.realized[key];
    if (c && r && c.unit === r.unit && !this.calib.scored.includes(key)) {
      const sampleNative = r.center - c.rawCenter;
      const sampleC = event.unit === "F" ? sampleNative / 1.8 : sampleNative;
      this.applyBiasSample(event.city, event.unit, sampleC);
      this.calib.scored.push(key);
      console.log(
        `[Weather] calib ${event.city} ${event.targetDate}: realized ` +
          `${r.center.toFixed(1)}°${event.unit} (${r.source ?? "?"}) vs forecast ` +
          `${c.rawCenter.toFixed(1)}°${event.unit} → bias sample ${sampleC.toFixed(2)}°C`,
      );
    }

    this.pruneCalibration();
    this.saveCalibration();
  }

  private applyBiasSample(city: string, unit: TempUnit, sampleC: number) {
    const k = cityKey(city);
    const cur = this.calib.bias[k];
    const a = Math.min(1, Math.max(0, this.cfg.biasEmaAlpha));
    let offsetC = cur ? (1 - a) * cur.offsetC + a * sampleC : sampleC;
    const cap = this.cfg.maxCityBiasC;
    offsetC = Math.max(-cap, Math.min(cap, offsetC));
    this.calib.bias[k] = {
      offsetC,
      samples: (cur?.samples ?? 0) + 1,
      unit,
      updatedAt: Date.now(),
    };
  }

  private hasOpenPositionForEvent(city: string, targetDate: string): boolean {
    const ck = cityKey(city);
    return this.activeTrades().some(
      (t) =>
        cityKey(t.city) === ck &&
        t.targetDate === targetDate &&
        (t.status === "PLACED" || t.status === "DRY_RUN"),
    );
  }

  private pruneCalibration() {
    const cutoff = Date.now() - 30 * 86_400_000; // keep ~30 days of day-keys
    for (const map of [this.calib.centers, this.calib.realized] as const) {
      for (const k of Object.keys(map)) {
        if (map[k].at < cutoff) delete map[k];
      }
    }
    this.calib.scored = this.calib.scored.filter(
      (k) => this.calib.centers[k] || this.calib.realized[k],
    );
  }

  private loadCalibration() {
    try {
      if (!fs.existsSync(CALIB_PATH)) return;
      const p = JSON.parse(fs.readFileSync(CALIB_PATH, "utf8"));
      this.calib = {
        centers: p?.centers && typeof p.centers === "object" ? p.centers : {},
        realized:
          p?.realized && typeof p.realized === "object" ? p.realized : {},
        scored: Array.isArray(p?.scored) ? p.scored : [],
        bias: p?.bias && typeof p.bias === "object" ? p.bias : {},
      };
      const n = Object.keys(this.calib.bias).length;
      if (n > 0) {
        console.log(`[Weather] Restored bias calibration for ${n} city(ies).`);
      }
    } catch (err: any) {
      console.error("[Weather] Failed to load calibration:", err.message);
    }
  }

  private loadBacktest() {
    this.backtest = loadBacktestStore(BACKTEST_PATH);
    if (this.backtest && this.cfg.backtestSigmaFloor) {
      const n = Object.keys(this.backtest.cities).length;
      if (n > 0) {
        console.log(
          `[Weather] Loaded forecast-error σ floor for ${n} location(s).`,
        );
      }
    }
  }

  private saveCalibration() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CALIB_PATH, JSON.stringify(this.calib, null, 2));
    } catch (err: any) {
      console.error("[Weather] Failed to save calibration:", err.message);
    }
  }

  // ── reporting ─────────────────────────────────────────────────────────────────
  private async calculateWeatherPnL(): Promise<{
    totalPnl: number;
    totalInvested: number;
    byTargetDate: Record<string, WeatherPnLByDate>;
  }> {
    const openTrades = this.activeTrades().filter(
      (t) => t.status === "PLACED" || t.status === "DRY_RUN",
    );

    if (openTrades.length === 0) {
      return { totalPnl: 0, totalInvested: 0, byTargetDate: {} };
    }

    // Fetch current prices for unique tokenIds.
    // Prefer SELL side for mark-to-market (liquidation value), then fall back
    // to BUY side if needed. Run requests in parallel so a slow token does not
    // starve the whole report and bias pricing coverage.
    const tokenIdPrices: Record<string, number> = {};
    const uniqueTokenIds = [...new Set(openTrades.map((t) => t.tokenId))];

    const fetchPrice = async (
      tokenId: string,
      side: "BUY" | "SELL",
    ): Promise<number | null> => {
      try {
        const res = await axios.get(`${CLOB_API}/price`, {
          params: { token_id: tokenId, side },
          timeout: 3000,
        });
        const px = parseFloat(res.data?.price ?? "NaN");
        return Number.isFinite(px) ? px : null;
      } catch {
        return null;
      }
    };

    await Promise.allSettled(
      uniqueTokenIds.map(async (tokenId) => {
        const sellPx = await fetchPrice(tokenId, "SELL");
        if (sellPx != null) {
          tokenIdPrices[tokenId] = sellPx;
          return;
        }
        const buyPx = await fetchPrice(tokenId, "BUY");
        if (buyPx != null) {
          tokenIdPrices[tokenId] = buyPx;
        }
      }),
    );

    // Calculate PNL per trade
    let totalPnl = 0;
    let totalInvested = 0;
    const byTargetDate: Record<string, WeatherPnLByDate> = {};

    for (const trade of openTrades) {
      const currentPrice = tokenIdPrices[trade.tokenId];
      const invested = trade.sizeUsdc;
      totalInvested += invested;

      const date = trade.targetDate;
      if (!byTargetDate[date]) {
        byTargetDate[date] = {
          pnl: 0,
          invested: 0,
          pricedTrades: 0,
          totalTrades: 0,
        };
      }
      byTargetDate[date].invested += invested;
      byTargetDate[date].totalTrades += 1;

      if (Number.isFinite(currentPrice)) {
        const shares = invested / trade.price;
        const pnl = (currentPrice - trade.price) * shares;
        totalPnl += pnl;
        byTargetDate[date].pnl += pnl;
        byTargetDate[date].pricedTrades += 1;
      }
    }

    return { totalPnl, totalInvested, byTargetDate };
  }

  async getReport(): Promise<string> {
    const orders = this.dataProviders.getOrders
      ? await this.dataProviders.getOrders()
      : undefined;

    const pnlData = await this.calculateWeatherPnL();

    return formatReport(this.lastSignals, this.recentTrades(8), {
      markdown: true,
      lastScanAt: this.lastScanAt,
      enabled: config.weather.enabled,
      allWeatherTrades: this.activeTrades(),
      weatherPnL: pnlData,
      orders,
    });
  }

  // Keep runtime toggles in one place so Telegram and engine loops stay aligned.
  setEnabled(enabled: boolean) {
    this.cfg.enabled = enabled;
    config.weather.enabled = enabled;
  }

  recentTrades(n: number): WeatherTradeRecord[] {
    return this.activeTrades().slice(-n).reverse();
  }

  private async notifyTrade(signal: WeatherSignal, rec: WeatherTradeRecord) {
    if (!this.notifier) return;
    const icon =
      rec.status === "PLACED"
        ? "✅"
        : rec.status === "DRY_RUN"
          ? "🔵"
          : rec.status === "SKIPPED"
            ? "⏭️"
            : "❌";
    const f = signal.forecast;
    const msg =
      `${icon} *Weather bet* — ${rec.status}\n\n` +
      `🌡 ${signal.event.city} • ${rec.targetDate}\n` +
      `Bucket: *${rec.bucketLabel}*\n` +
      (rec.modelProb != null && rec.marketProb != null && rec.edge != null
        ? `Model ${(rec.modelProb * 100).toFixed(1)}% vs ask ${(rec.marketProb * 100).toFixed(1)}% ` +
          `→ edge *+${(rec.edge * 100).toFixed(1)}%*\n`
        : "") +
      `Forecast μ ${f.mean.toFixed(1)}°${f.unit} (p10–p90 ${f.p10.toFixed(0)}–${f.p90.toFixed(0)})\n` +
      `*BUY* $${rec.sizeUsdc.toFixed(2)} @ ${rec.price}` +
      (rec.reason ? `\n_${rec.reason}_` : "") +
      (rec.orderId ? `\n\`${rec.orderId}\`` : "");
    try {
      await this.notifier.send(msg);
    } catch {
      /* notification failures must never break the loop */
    }
  }

  private async notifyExit(
    buyTrade: WeatherTradeRecord,
    sellRec: WeatherTradeRecord,
  ) {
    if (!this.notifier) return;
    const icon =
      sellRec.status === "PLACED"
        ? "✅"
        : sellRec.status === "DRY_RUN"
          ? "🔵"
          : sellRec.status === "SKIPPED"
            ? "⏭️"
            : "❌";
    const pnlPct = sellRec.pnlFraction
      ? (sellRec.pnlFraction * 100).toFixed(1)
      : "?";
    const pnlSign = sellRec.pnlFraction && sellRec.pnlFraction >= 0 ? "+" : "";
    const msg =
      `${icon} *Weather exit* — ${sellRec.status}\n\n` +
      `🌡 ${sellRec.city} • ${sellRec.targetDate}\n` +
      `Bucket: *${sellRec.bucketLabel}*\n` +
      `*SELL* $${sellRec.sizeUsdc.toFixed(2)} @ ${sellRec.price}\n` +
      `P&L: *${pnlSign}${pnlPct}%* ($${sellRec.pnlUsd?.toFixed(2) ?? "?"})\n` +
      `Reason: _${sellRec.reason || "manual"}_` +
      (sellRec.orderId ? `\n\`${sellRec.orderId}\`` : "");
    try {
      await this.notifier.send(msg);
    } catch {
      /* notification failures must never break the loop */
    }
  }

  // ── persistence ───────────────────────────────────────────────────────────────
  private loadState() {
    try {
      if (!fs.existsSync(STATE_PATH)) return;
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      this.state = {
        trades: Array.isArray(parsed?.trades)
          ? parsed.trades.map((trade: WeatherTradeRecord) => ({
              ...trade,
              executionMode: tradeExecutionMode(trade),
            }))
          : [],
        traded:
          parsed?.traded && typeof parsed.traded === "object"
            ? parsed.traded
            : {},
        exitTrend:
          parsed?.exitTrend && typeof parsed.exitTrend === "object"
            ? parsed.exitTrend
            : {},
      };
      console.log(
        `[Weather] Restored ${this.state.trades.length} weather trade(s).`,
      );
    } catch (err: any) {
      console.error("[Weather] Failed to load state:", err.message);
    }
  }

  private saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      console.error("[Weather] Failed to save state:", err.message);
    }
  }

  /**
   * Permanently drop weather trade records (both DRY_RUN and LIVE) placed
   * before `cutoffMs`, so /weather reports, P&L and history only reflect
   * activity from that point forward. Also prunes the day-keyed dedupe map
   * for days entirely before the cutoff. Persists immediately.
   */
  trimTradesBefore(cutoffMs: number): {
    removedTrades: number;
    keptTrades: number;
    removedDays: number;
  } {
    const before = this.state.trades.length;
    this.state.trades = this.state.trades.filter(
      (trade) => trade.ts >= cutoffMs,
    );
    const removedTrades = before - this.state.trades.length;

    const cutoffDay = todayStr(cutoffMs);
    const dayKeysBefore = Object.keys(this.state.traded).length;
    for (const day of Object.keys(this.state.traded)) {
      if (day < cutoffDay) delete this.state.traded[day];
    }
    const removedDays = dayKeysBefore - Object.keys(this.state.traded).length;

    this.saveState();
    console.log(
      `[Weather] Trimmed trades before ${cutoffDay}: removed ${removedTrades}, kept ${this.state.trades.length}.`,
    );
    return {
      removedTrades,
      keptTrades: this.state.trades.length,
      removedDays,
    };
  }
}
