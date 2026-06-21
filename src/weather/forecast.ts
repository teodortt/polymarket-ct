import axios from "axios";
import { ForecastSummary, GeoPoint, TempUnit, WeatherConfig } from "../types";

const ENSEMBLE_API = "https://ensemble-api.open-meteo.com/v1/ensemble";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";

// ── Normal CDF (no deps) ──────────────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 error-function approximation (|err| < 1.5e-7).
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * A probabilistic forecast of a daily-maximum temperature, represented as a
 * Gaussian kernel-density estimate over ensemble member outcomes.
 *
 * Each of the N ensemble members contributes a Gaussian of width `sigma`
 * centred on its predicted daily max. The probability that the outcome lands
 * in an interval is the average interval-mass across all member kernels. This
 * smooths the finite ensemble, absorbs integer-rounding at bucket edges, and
 * (via `sigma`) accounts for station-vs-grid bias and ensemble under-dispersion.
 */
export class ForecastDistribution {
  readonly xs: number[]; // member daily-max values (market unit), inflated
  readonly sigma: number;

  constructor(memberMaxes: number[], sigma: number, spreadInflation = 1) {
    const mean =
      memberMaxes.reduce((s, v) => s + v, 0) / Math.max(1, memberMaxes.length);
    const inflate = Math.max(1, spreadInflation);
    this.xs =
      inflate === 1
        ? memberMaxes.slice()
        : memberMaxes.map((x) => mean + inflate * (x - mean));
    this.sigma = Math.max(0.1, sigma);
  }

  // P(lo ≤ X < hi). lo may be -Infinity and hi may be +Infinity.
  probInterval(lo: number, hi: number): number {
    if (hi <= lo || this.xs.length === 0) return 0;
    const s = this.sigma;
    let sum = 0;
    for (const x of this.xs) {
      const a = lo === -Infinity ? 0 : normCdf((lo - x) / s);
      const b = hi === Infinity ? 1 : normCdf((hi - x) / s);
      sum += Math.max(0, b - a);
    }
    return sum / this.xs.length;
  }

  probLE(t: number): number {
    return this.probInterval(-Infinity, t);
  }

  probGE(t: number): number {
    return this.probInterval(t, Infinity);
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function leadDaysUntil(targetDate: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const ms =
    Date.parse(targetDate + "T00:00:00Z") - Date.parse(today + "T00:00:00Z");
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * Pull a multi-model ensemble forecast and reduce it to the set of per-member
 * daily-maximum temperatures for `targetDate` (the market's local measurement
 * day). Returns null if the location/date can't be covered.
 */
export async function fetchEnsembleMaxes(
  geo: GeoPoint,
  unit: TempUnit,
  targetDate: string,
  models: string,
): Promise<{ maxes: number[]; leadDays: number } | null> {
  const leadDays = leadDaysUntil(targetDate);
  // Fetch a couple of extra days so the full local day is covered regardless of
  // the location's UTC offset.
  const forecastDays = Math.min(16, Math.max(2, leadDays + 2));

  try {
    const res = await axios.get(ENSEMBLE_API, {
      params: {
        latitude: geo.lat,
        longitude: geo.lon,
        hourly: "temperature_2m",
        models,
        temperature_unit: unit === "F" ? "fahrenheit" : "celsius",
        timezone: "auto",
        forecast_days: forecastDays,
      },
      timeout: 20_000,
    });

    const hourly = res.data?.hourly;
    const times: string[] = hourly?.time ?? [];
    if (times.length === 0) return null;

    // Indices that fall on the target local day.
    const dayIdx: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i].slice(0, 10) === targetDate) dayIdx.push(i);
    }
    if (dayIdx.length === 0) return null;

    // Every temperature_2m_* series is one ensemble member (plus control runs).
    const memberKeys = Object.keys(hourly).filter(
      (k) => k !== "time" && k.startsWith("temperature_2m"),
    );

    const maxes: number[] = [];
    for (const key of memberKeys) {
      const series: (number | null)[] = hourly[key];
      let m = -Infinity;
      let any = false;
      for (const i of dayIdx) {
        const v = series[i];
        if (v != null && Number.isFinite(v)) {
          if (v > m) m = v;
          any = true;
        }
      }
      if (any) maxes.push(m);
    }

    if (maxes.length < 10) return null; // too few members to trust
    return { maxes, leadDays };
  } catch (err: any) {
    console.error(
      `[Weather] ensemble fetch failed for ${geo.name} ${targetDate}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Pull the high-resolution *deterministic* daily-max forecast for the target
 * day. Open-Meteo's `best_match` picks the most skilful local model, which is
 * generally better-calibrated for the daily maximum than the coarse global
 * ensemble members. Used to de-bias (anchor) the ensemble centre. Returns null
 * when unavailable.
 */
export async function fetchDeterministicMax(
  geo: GeoPoint,
  unit: TempUnit,
  targetDate: string,
): Promise<number | null> {
  const leadDays = leadDaysUntil(targetDate);
  const forecastDays = Math.min(16, Math.max(2, leadDays + 2));
  try {
    const res = await axios.get(FORECAST_API, {
      params: {
        latitude: geo.lat,
        longitude: geo.lon,
        daily: "temperature_2m_max",
        temperature_unit: unit === "F" ? "fahrenheit" : "celsius",
        timezone: "auto",
        forecast_days: forecastDays,
      },
      timeout: 15_000,
    });
    const days: string[] = res.data?.daily?.time ?? [];
    const vals: (number | null)[] = res.data?.daily?.temperature_2m_max ?? [];
    const i = days.indexOf(targetDate);
    if (i >= 0 && vals[i] != null && Number.isFinite(vals[i] as number)) {
      return vals[i] as number;
    }
    return null;
  } catch (err: any) {
    console.error(
      `[Weather] deterministic fetch failed for ${geo.name} ${targetDate}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Build a calibrated forecast distribution for an event's target day, along
 * with a human-readable summary. Returns null when the forecast is unavailable.
 *
 * Prediction pipeline (the "best possible" logic with free public data):
 *   1. Multi-model ensemble (GFS/ICON/ECMWF, ~120 members) → per-member daily max.
 *   2. Anchor the centre on the high-resolution deterministic forecast, which is
 *      more skilful for the daily max and removes ensemble 2 m-temp biases that
 *      would otherwise manufacture phantom edges.
 *   3. Widen the kernel bandwidth by the deterministic-vs-ensemble disagreement
 *      (epistemic uncertainty) and by lead time (skill decay).
 *   4. Gaussian-KDE over the recentred members → per-bucket interval mass.
 */
export async function buildForecastDistribution(
  geo: GeoPoint,
  unit: TempUnit,
  targetDate: string,
  cfg: WeatherConfig,
  biasOffset = 0,
  errorSigmaFloor?: number,
): Promise<{ dist: ForecastDistribution; summary: ForecastSummary } | null> {
  const [fetched, det] = await Promise.all([
    fetchEnsembleMaxes(geo, unit, targetDate, cfg.models),
    fetchDeterministicMax(geo, unit, targetDate),
  ]);
  if (!fetched) return null;
  const { maxes, leadDays } = fetched;

  const ensembleMean = maxes.reduce((s, v) => s + v, 0) / maxes.length;

  // Anchor the centre on a blend of the deterministic max and the ensemble
  // mean, then shift every member so the cloud recentres on that anchor while
  // keeping the ensemble's (flow-dependent) spread and shape.
  const w = det != null ? Math.min(1, Math.max(0, cfg.deterministicWeight)) : 0;
  const rawAnchor = w * (det ?? ensembleMean) + (1 - w) * ensembleMean;
  // Fold in the learned per-city grid→station correction (market unit). Learned
  // from realized outcomes, this removes the systematic 1–3° offset between the
  // forecast grid cell and the official station the market resolves against.
  const anchor = rawAnchor + biasOffset;
  const shift = anchor - ensembleMean;
  const recentered = shift === 0 ? maxes.slice() : maxes.map((x) => x + shift);

  // KDE bandwidth grows with lead time (skill decays). Config is in °F; halve
  // roughly for °C markets so the smoothing stays physically similar.
  const bandwidthF = cfg.kdeBandwidthF + leadDays * cfg.kdeLeadPerDayF;
  const baseSigma = unit === "F" ? bandwidthF : bandwidthF / 1.8;
  // Disagreement between the two independent forecasts is genuine uncertainty:
  // fold it into the bandwidth so divergent forecasts produce flatter, less
  // confident bucket probabilities (fewer false edges).
  const disagreement = det != null ? Math.abs(det - ensembleMean) : 0;
  let sigma = Math.sqrt(
    baseSigma * baseSigma + (cfg.disagreementSigmaWeight * disagreement) ** 2,
  );

  const sorted = recentered.slice().sort((a, b) => a - b);
  const mean = recentered.reduce((s, v) => s + v, 0) / recentered.length;
  const variance =
    recentered.reduce((s, v) => s + (v - mean) * (v - mean), 0) /
    recentered.length;

  // Measured-σ floor (capital preservation against overconfidence). The KDE's
  // predictive spread is a mixture: total variance ≈ memberSpread² + kernel²,
  // where the member spread is inflated exactly as the distribution will inflate
  // it. If the empirically observed forecast-error σ (from the backtest harness)
  // is wider than that, raise the kernel σ so the predictive distribution is at
  // least that wide. It only ever widens — never narrows a model that is already
  // appropriately uncertain (e.g. from disagreement or long lead).
  if (
    errorSigmaFloor != null &&
    Number.isFinite(errorSigmaFloor) &&
    errorSigmaFloor > 0
  ) {
    const effSpread = Math.max(1, cfg.spreadInflation) * Math.sqrt(variance);
    const neededKernel = Math.sqrt(
      Math.max(0, errorSigmaFloor * errorSigmaFloor - effSpread * effSpread),
    );
    if (neededKernel > sigma) sigma = neededKernel;
  }

  const dist = new ForecastDistribution(recentered, sigma, cfg.spreadInflation);

  const summary: ForecastSummary = {
    members: recentered.length,
    mean,
    std: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    unit,
    leadDays,
    sigma,
    det,
    ensembleMean,
    rawCenter: rawAnchor,
    biasApplied: biasOffset,
  };

  return { dist, summary };
}
