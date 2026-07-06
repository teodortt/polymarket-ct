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

  const best = pickBest(signals, summary, cfg);
  const bestRejectionReason = best
    ? undefined
    : rejectReason(signals, summary, cfg);

  return {
    event,
    geo,
    forecast: summary,
    buckets: signals,
    best,
    bestRejectionReason,
    generatedAt: Date.now(),
  };
}

// Only the model's single most-likely bucket (its mode) is ever actionable.
//
// Ranking by *edge* instead selects the bucket where a noisy/biased forecast
// most disagrees with a liquid market — i.e. the model's biggest errors — so it
// systematically bought cheap long-shots that expire worthless. Restricting to
// the mode means we only bet our genuine best estimate, and only when even that
// estimate is mispriced enough to clear the gates.
// The market's own favorite bucket: the one (other than our mode pick) with
// the highest implied probability (yesPrice). If the market is confidently
// (>= cfg.maxMarketFavoriteProb) backing a DIFFERENT bucket than our model's
// mode, that is a strong signal our forecast is wrong, not that the market is
// mispriced. Verified against real settlements 2026-07-06: mode-bucket trades
// that fought a confident market like this lost 12 of 13 times regardless of
// stated edge.
function marketFavorite(
  signals: BucketSignal[],
  mode: BucketSignal,
): BucketSignal | null {
  let favorite: BucketSignal | null = null;
  for (const s of signals) {
    if (s.bucket === mode.bucket) continue;
    if (!favorite || s.marketProb > favorite.marketProb) favorite = s;
  }
  return favorite;
}

function qualityRejectReason(
  signals: BucketSignal[],
  summary: ForecastSummary,
  cfg: WeatherConfig,
): string | undefined {
  const mode = signals[0];
  if (!mode) return "no forecast buckets";
  if (mode.modelProb < cfg.minModeProb) {
    return `mode prob ${(mode.modelProb * 100).toFixed(1)}% < min ${(cfg.minModeProb * 100).toFixed(1)}%`;
  }
  const second = signals[1];
  const gap = mode.modelProb - (second?.modelProb ?? 0);
  if (gap < cfg.minModeGap) {
    return `mode gap ${(gap * 100).toFixed(1)}% < min ${(cfg.minModeGap * 100).toFixed(1)}%`;
  }
  if (summary.det != null) {
    const gapAbs = Math.abs(summary.det - summary.ensembleMean);
    const maxGap =
      summary.unit === "F"
        ? cfg.maxDetEnsembleGapC * 1.8
        : cfg.maxDetEnsembleGapC;
    if (gapAbs > maxGap) {
      return `det/ensemble disagreement ${gapAbs.toFixed(1)}${summary.unit} > max ${maxGap.toFixed(1)}${summary.unit}`;
    }
  }
  return undefined;
}

function pickBest(
  signals: BucketSignal[],
  summary: ForecastSummary,
  cfg: WeatherConfig,
): BucketSignal | null {
  const qualityReason = qualityRejectReason(signals, summary, cfg);
  if (qualityReason) return null;

  // `signals` is pre-sorted by modelProb desc, so [0] is the mode.
  const mode = signals[0];
  if (!mode) return null;
  if (!mode.bucket.acceptingOrders) return null;
  if (mode.buyPrice == null) return null;
  if (mode.buyPrice < cfg.minPrice || mode.buyPrice > cfg.maxPrice) return null;
  if (mode.bucket.liquidity < cfg.minLiquidityUsdc) return null;
  if (mode.edge < cfg.minEdge) return null;
  const favorite = marketFavorite(signals, mode);
  if (favorite && favorite.marketProb >= cfg.maxMarketFavoriteProb) return null;
  return mode;
}

function rejectReason(
  signals: BucketSignal[],
  summary: ForecastSummary,
  cfg: WeatherConfig,
): string {
  const qualityReason = qualityRejectReason(signals, summary, cfg);
  if (qualityReason) return qualityReason;

  const mode = signals[0];
  if (!mode) return "no forecast buckets";
  if (!mode.bucket.acceptingOrders) return "market not accepting orders";
  if (mode.buyPrice == null) return "no ask quote on model-top bucket";
  if (mode.buyPrice < cfg.minPrice)
    return `ask ${mode.buyPrice.toFixed(3)} < min price ${cfg.minPrice.toFixed(3)}`;
  if (mode.buyPrice > cfg.maxPrice)
    return `ask ${mode.buyPrice.toFixed(3)} > max price ${cfg.maxPrice.toFixed(3)}`;
  if (mode.bucket.liquidity < cfg.minLiquidityUsdc) {
    return `liquidity $${mode.bucket.liquidity.toFixed(0)} < min $${cfg.minLiquidityUsdc.toFixed(0)}`;
  }
  if (mode.edge < cfg.minEdge)
    return `edge ${(mode.edge * 100).toFixed(1)}% < min ${(cfg.minEdge * 100).toFixed(1)}%`;
  const favorite = marketFavorite(signals, mode);
  if (favorite && favorite.marketProb >= cfg.maxMarketFavoriteProb) {
    return `market favors "${favorite.bucket.label}" at ${(favorite.marketProb * 100).toFixed(1)}% vs our pick "${mode.bucket.label}" — disagreement guard`;
  }
  return "filtered by strategy guard";
}
