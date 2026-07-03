import {
  BucketSignal,
  ForecastSummary,
  GeoPoint,
  WeatherConfig,
  WeatherMarketEvent,
  WeatherSignal,
} from "../types";
import { ForecastDistribution } from "./forecast";

// Kelly fraction for buying a binary "Yes" share at `price` when the true
// win probability is `p`. Payout is 1 on win, 0 on loss, so the optimal
// bankroll fraction is (p − price) / (1 − price). Clamped at 0 (no bet).
export function kellyFraction(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const f = (p - price) / (1 - price);
  return f > 0 ? Math.min(1, f) : 0;
}

/**
 * Turn a forecast distribution into a per-bucket model-vs-market comparison.
 *
 * Because an event's buckets are mutually exclusive and exhaustive, the raw
 * KDE masses are renormalised to sum to 1 — this corrects kernel tail-leakage
 * and keeps the probabilities internally consistent with the market structure.
 */
export function predictEvent(
  event: WeatherMarketEvent,
  geo: GeoPoint,
  forecast: { dist: ForecastDistribution; summary: ForecastSummary },
  cfg: WeatherConfig,
): WeatherSignal {
  const { dist, summary } = forecast;

  const rawProbs = event.buckets.map((b) => dist.probInterval(b.lo, b.hi));
  const total = rawProbs.reduce((s, v) => s + v, 0);
  const norm = total > 0 ? total : 1;

  const signals: BucketSignal[] = event.buckets.map((bucket, i) => {
    const modelProb = rawProbs[i] / norm;
    // Buy cost is the best ask; fall back to the implied mid only when there
    // is a price but no resting ask quote.
    const buyPrice =
      bucket.bestAsk != null && bucket.bestAsk > 0 && bucket.bestAsk < 1
        ? bucket.bestAsk
        : null;
    const edge = buyPrice != null ? modelProb - buyPrice : -1;
    return {
      bucket,
      modelProb,
      marketProb: bucket.yesPrice,
      buyPrice,
      edge,
      kellyFraction: buyPrice != null ? kellyFraction(modelProb, buyPrice) : 0,
    };
  });

  signals.sort((a, b) => b.modelProb - a.modelProb);

  const { best, reason } = pickBest(signals, cfg);

  return {
    event,
    geo,
    forecast: summary,
    buckets: signals,
    best,
    bestRejectionReason: reason,
    generatedAt: Date.now(),
  };
}

// Best actionable bucket: tradeable price band, accepting orders, enough
// liquidity, and edge above the configured threshold — ranked by edge.
function pickBest(
  signals: BucketSignal[],
  cfg: WeatherConfig,
): { best: BucketSignal | null; reason?: string } {
  let best: BucketSignal | null = null;
  let firstReason: string | undefined;
  for (const s of signals) {
    let reason: string | undefined;
    if (!s.bucket.acceptingOrders) {
      reason = "bucket not accepting orders";
    } else if (s.buyPrice == null) {
      reason = "no best ask";
    } else if (s.buyPrice < cfg.minPrice) {
      reason = `ask ${s.buyPrice.toFixed(3)} < minPrice ${cfg.minPrice.toFixed(3)}`;
    } else if (s.buyPrice > cfg.maxPrice) {
      reason = `ask ${s.buyPrice.toFixed(3)} > maxPrice ${cfg.maxPrice.toFixed(3)}`;
    } else if (s.bucket.liquidity < cfg.minLiquidityUsdc) {
      reason = `liquidity ${s.bucket.liquidity.toFixed(0)} < minLiquidity ${cfg.minLiquidityUsdc.toFixed(0)}`;
    } else if (s.edge < cfg.minEdge) {
      reason = `edge ${(s.edge * 100).toFixed(1)}% < minEdge ${(cfg.minEdge * 100).toFixed(1)}%`;
    }

    if (reason) {
      if (!firstReason) firstReason = `${s.bucket.label}: ${reason}`;
      continue;
    }

    if (best == null || s.edge > best.edge) best = s;
  }
  return {
    best,
    reason: best ? undefined : (firstReason ?? "no actionable bucket"),
  };
}
