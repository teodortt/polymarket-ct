import axios, { AxiosResponse } from "axios";
import { ForecastSummary, GeoPoint, TempUnit, WeatherConfig } from "../types";

const ENSEMBLE_API = "https://ensemble-api.open-meteo.com/v1/ensemble";
const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
const ENSEMBLE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];
const ENSEMBLE_COOLDOWN_LOG_EVERY_MS = 30_000;
const MIN_ENSEMBLE_COOLDOWN_MS = 60_000;
const MAX_ENSEMBLE_RETRY_DELAY_MS =
  ENSEMBLE_RETRY_DELAYS_MS[ENSEMBLE_RETRY_DELAYS_MS.length - 1];

let ensembleCooldownUntil = 0;
let lastEnsembleCooldownLogAt = 0;

interface EnsembleHourlyResponse {
  hourly?: Record<string, (number | null)[] | string[] | undefined> & {
    time?: string[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After may be either delta-seconds or an HTTP-date.
function parseRetryAfterMs(err: unknown): number | null {
  if (!axios.isAxiosError(err)) return null;
  const raw =
    err.response?.headers?.["retry-after"] ??
    err.response?.headers?.["Retry-After"];
  if (raw === null || raw === undefined) return null;
  const s = Number(raw);
  if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
  const ts = Date.parse(String(raw));
  if (!Number.isNaN(ts)) {
    const ms = ts - Date.now();
    if (ms > 0) return ms;
  }
  return null;
}

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

function leadDaysUntil(targetDate: string): number {
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
  const now = Date.now();
  if (now < ensembleCooldownUntil) {
    if (now - lastEnsembleCooldownLogAt >= ENSEMBLE_COOLDOWN_LOG_EVERY_MS) {
      const sec = Math.max(1, Math.ceil((ensembleCooldownUntil - now) / 1000));
      console.warn(
        `[Weather] ensemble API cooling down after 429 — skipping ${geo.name} ${targetDate} for ${sec}s`,
      );
      lastEnsembleCooldownLogAt = now;
    }
    return null;
  }

  const leadDays = leadDaysUntil(targetDate);
  // Fetch a couple of extra days so the full local day is covered regardless of
  // the location's UTC offset.
  const forecastDays = Math.min(16, Math.max(2, leadDays + 2));

  const params = {
    latitude: geo.lat,
    longitude: geo.lon,
    hourly: "temperature_2m",
    models,
    temperature_unit: unit === "F" ? "fahrenheit" : "celsius",
    timezone: "auto",
    forecast_days: forecastDays,
  };

  try {
    let res!: AxiosResponse<EnsembleHourlyResponse>;
    const retries = ENSEMBLE_RETRY_DELAYS_MS.length;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const hasRetry = attempt < retries;
      try {
        res = await axios.get(ENSEMBLE_API, { params, timeout: 20_000 });
        break;
      } catch (err: unknown) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (status !== 429 || !hasRetry) {
          if (status === 429) {
            const retryAfterMs = parseRetryAfterMs(err);
            const cooldownMs = Math.max(
              MIN_ENSEMBLE_COOLDOWN_MS,
              retryAfterMs ?? MAX_ENSEMBLE_RETRY_DELAY_MS,
            );
            const nowTs = Date.now();
            ensembleCooldownUntil = nowTs + cooldownMs;
            lastEnsembleCooldownLogAt = nowTs;
            console.warn(
              `[Weather] rate-limited (429) — cooling ensemble requests for ${Math.ceil(cooldownMs / 1000)}s`,
            );
          }
          throw err;
        }
        const retryAfterMs = parseRetryAfterMs(err);
        const delayMs = retryAfterMs ?? ENSEMBLE_RETRY_DELAYS_MS[attempt];
        console.warn(
          `[Weather] rate-limited (429) — retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt + 1}/${retries})`,
        );
        await sleep(delayMs);
      }
    }
    const hourly = res.data?.hourly;
    if (!hourly) return null;
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
      const series = hourly[key];
      if (!Array.isArray(series)) continue;
      let m = -Infinity;
      let any = false;
      for (const i of dayIdx) {
        const v = series[i];
        if (typeof v === "number" && Number.isFinite(v)) {
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
): Promise<{ dist: ForecastDistribution; summary: ForecastSummary } | null> {
  // Keep ensemble fetch first: when that endpoint is in cooldown (429 burst),
  // we avoid extra deterministic calls that would increase API pressure.
  const fetched = await fetchEnsembleMaxes(geo, unit, targetDate, cfg.models);
  if (!fetched) return null;
  const det = await fetchDeterministicMax(geo, unit, targetDate);
  const { maxes, leadDays } = fetched;

  const ensembleMean = maxes.reduce((s, v) => s + v, 0) / maxes.length;

  // Anchor the centre on a blend of the deterministic max and the ensemble
  // mean, then shift every member so the cloud recentres on that anchor while
  // keeping the ensemble's (flow-dependent) spread and shape.
  const w = det != null ? Math.min(1, Math.max(0, cfg.deterministicWeight)) : 0;
  const anchor = w * (det ?? ensembleMean) + (1 - w) * ensembleMean;
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
  const sigma = Math.sqrt(
    baseSigma * baseSigma + (cfg.disagreementSigmaWeight * disagreement) ** 2,
  );

  const dist = new ForecastDistribution(recentered, sigma, cfg.spreadInflation);

  const sorted = recentered.slice().sort((a, b) => a - b);
  const mean = recentered.reduce((s, v) => s + v, 0) / recentered.length;
  const variance =
    recentered.reduce((s, v) => s + (v - mean) * (v - mean), 0) /
    recentered.length;

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
  };

  return { dist, summary };
}
