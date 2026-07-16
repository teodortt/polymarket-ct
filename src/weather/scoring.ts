import axios from "axios";
import { WeatherTradeRecord } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Module 6 — Backtesting & Monitoring (prediction scoring).
//
// Closes the loop the strategy was missing: it scores the bot's OWN recorded
// probabilistic predictions against the eventual RESOLVED market outcome. Unlike
// backtest.ts (which measures raw forecast-vs-analysis dispersion), this answers
// "were we actually right, and did we make money?":
//
//   • Brier score & log-loss of model probability vs realized outcome
//   • Reliability bins (are our 20% calls right ~20% of the time?)
//   • Hit rate and realized P&L, overall and by forecast horizon (lead)
//   • Model-vs-market skill: does the model's Brier beat the entry price's?
//   • A calibration-health verdict that can drive an opt-in kill switch
//
// Resolution source: the Gamma API. CLOB order-book/price endpoints 404 once a
// market's book is torn down after settlement, so we read the resolved
// `outcomePrices` from Gamma (verified reliable in this repo's history).
// Read-only: places no orders; writes only data/weatherScore.json via the CLI.
// ─────────────────────────────────────────────────────────────────────────────

const GAMMA_API = "https://gamma-api.polymarket.com";

function safeJsonArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Extract the resolved Yes probability (0 or 1 once settled) from a Gamma market
// object, or null if the market is not resolved / not parseable.
function resolvedYesFromMarket(market: any): number | null {
  if (!market) return null;
  const prices = safeJsonArray(market.outcomePrices).map((p) => parseFloat(p));
  const outcomes = safeJsonArray(market.outcomes).map((o) => String(o));
  if (prices.length < 2 || prices.some((p) => !Number.isFinite(p))) return null;

  // Locate the "Yes" leg; default to index 0 (the Yes token in these markets).
  let yesIdx = outcomes.findIndex((o) => /^yes$/i.test(o));
  if (yesIdx < 0) yesIdx = 0;
  const yes = prices[yesIdx];

  // Only treat as resolved when the market is closed AND the price has collapsed
  // to a near-binary settlement value (avoids scoring a live mid-price).
  const closed =
    Boolean(market.closed) || market.umaResolutionStatus === "resolved";
  const settled = yes <= 0.02 || yes >= 0.98;
  if (!closed && !settled) return null;
  return yes >= 0.5 ? 1 : 0;
}

const outcomeCache = new Map<string, number | null>();

/**
 * Resolve the settled outcome (1 = the traded Yes bucket won, 0 = lost) for one
 * trade. Prefers a direct condition-id market lookup; falls back to the parent
 * event and matching the bucket by its label. Returns null if still unresolved.
 */
export async function resolveBucketOutcome(
  trade: WeatherTradeRecord,
): Promise<number | null> {
  const cacheKey = trade.conditionId || `${trade.eventId}|${trade.bucketLabel}`;
  if (outcomeCache.has(cacheKey)) return outcomeCache.get(cacheKey) ?? null;

  let outcome: number | null = null;

  // 1. Direct per-bucket lookup by condition id (most precise).
  if (trade.conditionId) {
    try {
      const res = await axios.get(`${GAMMA_API}/markets`, {
        params: { condition_ids: trade.conditionId },
        timeout: 15_000,
      });
      const markets = Array.isArray(res.data) ? res.data : res.data?.markets;
      if (Array.isArray(markets) && markets.length > 0) {
        outcome = resolvedYesFromMarket(markets[0]);
      }
    } catch {
      /* fall through to event lookup */
    }
  }

  // 2. Fall back to the parent event, matching the bucket by its label.
  if (outcome == null && /^\d+$/.test(trade.eventId)) {
    try {
      const res = await axios.get(`${GAMMA_API}/events/${trade.eventId}`, {
        timeout: 15_000,
      });
      const markets: any[] = res.data?.markets ?? [];
      const match =
        markets.find(
          (m) =>
            String(m.groupItemTitle ?? "").trim() === trade.bucketLabel.trim(),
        ) ?? markets.find((m) => String(m.conditionId) === trade.conditionId);
      if (match) outcome = resolvedYesFromMarket(match);
    } catch {
      /* leave unresolved */
    }
  }

  outcomeCache.set(cacheKey, outcome);
  return outcome;
}

export interface ScoredTrade {
  ts: number;
  city: string;
  targetDate: string;
  bucketLabel: string;
  leadDays: number;
  modelProb: number;
  marketProb: number;
  entryPrice: number;
  sizeUsdc: number;
  outcome: number; // 1 win, 0 loss
  pnlUsd: number; // realized P&L at settlement
  brier: number; // (modelProb − outcome)²
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number; // mean model prob in the bin
  observedFreq: number; // fraction that actually won
}

export interface ScoreMetrics {
  n: number;
  wins: number;
  hitRate: number;
  modelBrier: number; // mean Brier of model probability
  marketBrier: number; // mean Brier of entry price (market) — beats us?
  logLoss: number; // mean −[o·ln p + (1−o)·ln(1−p)]
  avgModelProb: number;
  invested: number;
  realizedPnl: number;
  roi: number;
}

export type HealthStatus = "healthy" | "degraded" | "insufficient";

export interface CalibrationHealth {
  status: HealthStatus;
  reasons: string[];
  scoredTrades: number;
}

export interface ScoreReport {
  generatedAt: number;
  overall: ScoreMetrics;
  byLead: Record<string, ScoreMetrics>;
  reliability: ReliabilityBin[];
  health: CalibrationHealth;
  unresolved: number;
  scored: ScoredTrade[];
}

function leadDaysOf(trade: WeatherTradeRecord): number {
  const tradeDay = new Date(trade.ts).toISOString().slice(0, 10);
  const ms =
    Date.parse(trade.targetDate + "T00:00:00Z") -
    Date.parse(tradeDay + "T00:00:00Z");
  return Math.max(0, Math.round(ms / 86_400_000));
}

function clamp01(p: number): number {
  return Math.min(1 - 1e-9, Math.max(1e-9, p));
}

function metricsFrom(rows: ScoredTrade[]): ScoreMetrics {
  const n = rows.length;
  if (n === 0) {
    return {
      n: 0,
      wins: 0,
      hitRate: 0,
      modelBrier: 0,
      marketBrier: 0,
      logLoss: 0,
      avgModelProb: 0,
      invested: 0,
      realizedPnl: 0,
      roi: 0,
    };
  }
  let wins = 0;
  let modelBrier = 0;
  let marketBrier = 0;
  let logLoss = 0;
  let sumProb = 0;
  let invested = 0;
  let pnl = 0;
  for (const r of rows) {
    wins += r.outcome;
    modelBrier += r.brier;
    marketBrier += (r.marketProb - r.outcome) ** 2;
    const p = clamp01(r.modelProb);
    logLoss += -(r.outcome * Math.log(p) + (1 - r.outcome) * Math.log(1 - p));
    sumProb += r.modelProb;
    invested += r.sizeUsdc;
    pnl += r.pnlUsd;
  }
  return {
    n,
    wins,
    hitRate: wins / n,
    modelBrier: modelBrier / n,
    marketBrier: marketBrier / n,
    logLoss: logLoss / n,
    avgModelProb: sumProb / n,
    invested,
    realizedPnl: pnl,
    roi: invested > 0 ? pnl / invested : 0,
  };
}

function reliabilityBins(rows: ScoredTrade[]): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBin = rows.filter(
      (r) =>
        r.modelProb >= lo && (i === 9 ? r.modelProb <= hi : r.modelProb < hi),
    );
    if (inBin.length === 0) continue;
    const meanPredicted =
      inBin.reduce((s, r) => s + r.modelProb, 0) / inBin.length;
    const observedFreq =
      inBin.reduce((s, r) => s + r.outcome, 0) / inBin.length;
    bins.push({ lo, hi, count: inBin.length, meanPredicted, observedFreq });
  }
  return bins;
}

/**
 * Judge calibration health from the scored set. Feeds the opt-in kill switch:
 *   • insufficient — fewer than `minScored` resolved trades to judge.
 *   • degraded    — model Brier worse than the market's on the same buckets,
 *                   or realized ROI below `maxLossRoi`. These are the exact
 *                   failure modes that produced the historical −35% run.
 *   • healthy     — beats the market and is not deeply underwater.
 */
export function judgeHealth(
  overall: ScoreMetrics,
  opts: { minScored: number; maxLossRoi: number },
): CalibrationHealth {
  const reasons: string[] = [];
  if (overall.n < opts.minScored) {
    return {
      status: "insufficient",
      reasons: [
        `only ${overall.n} resolved trade(s) scored (need ≥ ${opts.minScored} to judge calibration)`,
      ],
      scoredTrades: overall.n,
    };
  }
  if (overall.modelBrier > overall.marketBrier) {
    reasons.push(
      `model Brier ${overall.modelBrier.toFixed(3)} is worse than the market's ${overall.marketBrier.toFixed(3)} on the traded buckets (model is not adding skill)`,
    );
  }
  if (overall.roi < opts.maxLossRoi) {
    reasons.push(
      `realized ROI ${(overall.roi * 100).toFixed(1)}% is below the ${(opts.maxLossRoi * 100).toFixed(0)}% floor`,
    );
  }
  return {
    status: reasons.length > 0 ? "degraded" : "healthy",
    reasons:
      reasons.length > 0
        ? reasons
        : ["beats the market and ROI is above the floor"],
    scoredTrades: overall.n,
  };
}

/**
 * Score a set of recorded weather trades against their resolved outcomes.
 * Only BUY entries that placed/dry-ran and that have a model probability are
 * eligible; unresolved markets are skipped and counted.
 */
export async function scoreTrades(
  trades: WeatherTradeRecord[],
  opts: {
    minScored?: number;
    maxLossRoi?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ScoreReport> {
  const eligible = trades.filter(
    (t) =>
      t.side === "BUY" &&
      (t.status === "PLACED" || t.status === "DRY_RUN") &&
      typeof t.modelProb === "number" &&
      t.price > 0,
  );

  const scored: ScoredTrade[] = [];
  let unresolved = 0;
  let done = 0;
  for (const t of eligible) {
    const outcome = await resolveBucketOutcome(t);
    done++;
    opts.onProgress?.(done, eligible.length);
    if (outcome == null) {
      unresolved++;
      continue;
    }
    const shares = t.sizeUsdc / t.price;
    const pnlUsd = outcome === 1 ? shares - t.sizeUsdc : -t.sizeUsdc;
    scored.push({
      ts: t.ts,
      city: t.city,
      targetDate: t.targetDate,
      bucketLabel: t.bucketLabel,
      leadDays: leadDaysOf(t),
      modelProb: t.modelProb as number,
      marketProb: typeof t.marketProb === "number" ? t.marketProb : t.price,
      entryPrice: t.price,
      sizeUsdc: t.sizeUsdc,
      outcome,
      pnlUsd,
      brier: ((t.modelProb as number) - outcome) ** 2,
    });
  }

  const overall = metricsFrom(scored);
  const byLead: Record<string, ScoreMetrics> = {};
  const leads = [...new Set(scored.map((s) => s.leadDays))].sort(
    (a, b) => a - b,
  );
  for (const lead of leads) {
    byLead[String(lead)] = metricsFrom(
      scored.filter((s) => s.leadDays === lead),
    );
  }

  const health = judgeHealth(overall, {
    minScored: opts.minScored ?? 10,
    maxLossRoi: opts.maxLossRoi ?? -0.1,
  });

  return {
    generatedAt: Date.now(),
    overall,
    byLead,
    reliability: reliabilityBins(scored),
    health,
    unresolved,
    scored: scored.sort((a, b) => a.ts - b.ts),
  };
}
