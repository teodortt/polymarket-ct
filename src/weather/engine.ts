import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { Trade, WeatherSignal, WeatherTradeRecord } from "../types";
import { copyTradeWithSize, getLiveUsdcBalance } from "../trader";
import { resolveCity } from "./geocode";
import { buildForecastDistribution } from "./forecast";
import { discoverTemperatureEvents } from "./markets";
import { predictEvent } from "./predictor";
import { formatReport } from "./report";

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "weather.json");
const TRADES_MAX = 1000;

// Minimal sink so the engine never depends on the Telegram module directly.
export interface WeatherNotifier {
  send(text: string): Promise<unknown> | unknown;
}

interface WeatherState {
  trades: WeatherTradeRecord[];
  // local-date → token ids already traded that day (dedupe).
  traded: Record<string, string[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function todayStr(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export class WeatherEngine {
  private cfg = config.weather;
  private notifier?: WeatherNotifier;
  private running = false;
  private state: WeatherState = { trades: [], traded: {} };
  private lastSignals: WeatherSignal[] = [];
  private lastScanAt = 0;

  constructor(notifier?: WeatherNotifier) {
    this.notifier = notifier;
    this.loadState();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async start() {
    if (this.running) {
      console.log("[Weather] start() ignored — already running.");
      return;
    }
    this.running = true;
    if (this.cfg.enabled) {
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

    while (this.running) {
      try {
        if (this.cfg.enabled) await this.scanOnce();
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
      minHoursToResolve: this.cfg.minHoursToResolve,
    });
    console.log(`[Weather] scan: ${events.length} event(s) in window.`);

    const bankroll = place ? await this.resolveBankroll() : 0;
    const signals: WeatherSignal[] = [];
    let placedThisScan = 0;

    for (const event of events) {
      try {
        const geo = await resolveCity(event.city);
        if (!geo) {
          console.warn(`[Weather] no coordinates for "${event.city}" — skip.`);
          continue;
        }
        const forecast = await buildForecastDistribution(
          geo,
          event.unit,
          event.targetDate,
          this.cfg,
        );
        if (!forecast) continue;

        const signal = predictEvent(event, geo, forecast, this.cfg);
        signals.push(signal);

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
      await sleep(250); // be polite to the forecast API
    }

    this.lastSignals = signals;
    this.lastScanAt = Date.now();
    return signals;
  }

  // ── trading decision ──────────────────────────────────────────────────────────
  private async maybeTrade(
    signal: WeatherSignal,
    bankroll: number,
  ): Promise<boolean> {
    const best = signal.best;
    if (!best || best.buyPrice == null) return false;

    const bucket = best.bucket;
    // Already traded this bucket today — don't stack.
    if (this.tradedTokens().includes(bucket.tokenIdYes)) return false;

    // Kelly-sized notional, capped by config and available liquidity.
    const frac = best.kellyFraction * this.cfg.kellyFraction;
    let notional = frac * bankroll;
    notional = Math.min(
      notional,
      this.cfg.maxTradeUsdc,
      bucket.liquidity * this.cfg.maxLiquidityFraction,
    );
    notional = Math.floor(notional * 100) / 100;
    if (notional < this.cfg.minTradeUsdc) return false;

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
      eventId: signal.event.id,
      eventTitle: signal.event.title,
      city: signal.event.city,
      targetDate: signal.event.targetDate,
      bucketLabel: bucket.label,
      tokenId: bucket.tokenIdYes,
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

  // ── bankroll / accounting ─────────────────────────────────────────────────────
  private async resolveBankroll(): Promise<number> {
    if (this.cfg.bankrollUsdc > 0) return this.cfg.bankrollUsdc;
    if (config.dryRun) return config.dryRunStartUsdc;
    const live = await getLiveUsdcBalance();
    return live?.balance ?? this.cfg.maxTradeUsdc * 10;
  }

  private tradedTokens(): string[] {
    return this.state.traded[todayStr()] ?? [];
  }

  private tradesToday(): number {
    const t = todayStr();
    return this.state.trades.filter(
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

  // ── reporting ─────────────────────────────────────────────────────────────────
  getReport(): string {
    return formatReport(this.lastSignals, this.recentTrades(8), {
      markdown: true,
      lastScanAt: this.lastScanAt,
      enabled: this.cfg.enabled,
    });
  }

  recentTrades(n: number): WeatherTradeRecord[] {
    return this.state.trades.slice(-n).reverse();
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
      `Model ${(rec.modelProb * 100).toFixed(1)}% vs ask ${(rec.marketProb * 100).toFixed(1)}% ` +
      `→ edge *+${(rec.edge * 100).toFixed(1)}%*\n` +
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

  // ── persistence ───────────────────────────────────────────────────────────────
  private loadState() {
    try {
      if (!fs.existsSync(STATE_PATH)) return;
      const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      this.state = {
        trades: Array.isArray(parsed?.trades) ? parsed.trades : [],
        traded:
          parsed?.traded && typeof parsed.traded === "object"
            ? parsed.traded
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
}
