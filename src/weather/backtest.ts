import axios from "axios";
import { GeoPoint } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Forecast-skill backtest / calibration harness.
//
// Measures, per (city, forecast lead), the daily-max forecast ERROR distribution
// against the model's own latest-run analysis. It answers the questions the
// live tuning has so far only guessed at:
//
//   • How wide is the forecast actually? (σ — the dispersion the KDE must match)
//   • Does the forecast drift with lead time? (bias / σ growth per lead day)
//
// Data source: Open-Meteo "previous runs" API. For each past timestamp it
// exposes both the latest-run value (`temperature_2m`, ≈ the realized analysis
// once the day is complete) and what the run from N days earlier predicted
// (`temperature_2m_previous_dayN`). Reducing both to a per-local-day maximum and
// differencing gives a clean lead-N forecast error, mirroring how the live
// pipeline derives a daily max from hourly members.
//
// IMPORTANT — what this measures and does NOT measure:
//   It measures forecast-vs-analysis dispersion (genuine predictive uncertainty,
//   in °C). It does NOT see the official resolution station, so it does NOT
//   capture the grid→station bias — that is learned separately by the live
//   obs-grounded calibrator. The measured σ is therefore a conservative LOWER
//   BOUND on the true predictive σ, which is exactly why the engine uses it only
//   as a floor that widens (never narrows) the forecast.
// ─────────────────────────────────────────────────────────────────────────────

const PREVIOUS_RUNS_API =
  "https://previous-runs-api.open-meteo.com/v1/forecast";

// Open-Meteo exposes previous runs out to 7 days back.
export const BACKTEST_MAX_LEAD = 7;
// A local day needs at least this many hourly readings to count (drops the
// still-running current day, which has only a partial max).
const MIN_HOURS_PER_DAY = 18;

export interface LeadErrorStats {
  lead: number; // forecast lead in days (1 = next-day)
  n: number; // scored days
  biasC: number; // mean(forecast − realized), °C (model self-consistency only)
  maeC: number; // mean absolute error, °C
  rmseC: number; // root-mean-square error, °C
  sigmaC: number; // population std of error, °C — the dispersion the KDE needs
  p10C: number; // error quantiles, °C
  p50C: number;
  p90C: number;
}

export interface ErrorSample {
  date: string; // YYYY-MM-DD local measurement day
  errC: number; // forecast − realized, °C
}

export interface CityBacktestEntry {
  city: string;
  geoName: string;
  lat: number;
  lon: number;
  days: number; // distinct local days with a realized max
  leads: Record<string, LeadErrorStats>; // keyed by lead (stringified)
  // Capped raw samples per lead so repeated runs accumulate statistics rather
  // than overwrite them. Keyed by lead.
  samples: Record<string, ErrorSample[]>;
}

export interface BacktestStore {
  generatedAt: number;
  lookbackDays: number;
  cities: Record<string, CityBacktestEntry>; // keyed by geoKey(geo)
}

// Coordinate key — stable across city aliases and independent of display name,
// so the CLI writer and the engine reader always agree on the same bucket.
export function geoKey(geo: GeoPoint): string {
  return `${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
}

// ── small stats helpers (no deps) ─────────────────────────────────────────────
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}

function pstd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return Math.sqrt(v);
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function statsFromSamples(
  lead: number,
  samples: ErrorSample[],
): LeadErrorStats {
  const errs = samples.map((s) => s.errC);
  return {
    lead,
    n: errs.length,
    biasC: mean(errs),
    maeC: mean(errs.map(Math.abs)),
    rmseC: Math.sqrt(mean(errs.map((e) => e * e))),
    sigmaC: pstd(errs),
    p10C: quantile(errs, 0.1),
    p50C: quantile(errs, 0.5),
    p90C: quantile(errs, 0.9),
  };
}

// Reduce an hourly series to { localDate → daily max }, keeping only days that
// have enough readings to be a complete day (drops the partial current day).
function dailyMax(
  times: string[],
  series: (number | null)[],
): Map<string, number> {
  const maxByDay = new Map<string, number>();
  const countByDay = new Map<string, number>();
  for (let i = 0; i < times.length; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) continue;
    const day = times[i].slice(0, 10);
    countByDay.set(day, (countByDay.get(day) ?? 0) + 1);
    const cur = maxByDay.get(day);
    if (cur == null || v > cur) maxByDay.set(day, v);
  }
  for (const [day, c] of countByDay) {
    if (c < MIN_HOURS_PER_DAY) maxByDay.delete(day);
  }
  return maxByDay;
}

/**
 * Pull the previous-run forecast errors for one location and reduce them to a
 * per-lead sample list (°C). Returns null on API failure.
 */
export async function fetchLeadErrorSamples(
  geo: GeoPoint,
  lookbackDays: number,
  maxLead = BACKTEST_MAX_LEAD,
): Promise<{ samples: Record<number, ErrorSample[]>; days: number } | null> {
  const leadKeys: string[] = [];
  for (let l = 1; l <= maxLead; l++) {
    leadKeys.push(`temperature_2m_previous_day${l}`);
  }
  try {
    const res = await axios.get(PREVIOUS_RUNS_API, {
      params: {
        latitude: geo.lat,
        longitude: geo.lon,
        hourly: ["temperature_2m", ...leadKeys].join(","),
        temperature_unit: "celsius",
        timezone: "auto",
        past_days: Math.max(2, Math.min(92, lookbackDays)),
        forecast_days: 1,
      },
      timeout: 30_000,
    });

    const hourly = res.data?.hourly;
    const times: string[] = hourly?.time ?? [];
    if (times.length === 0) return null;

    const realized = dailyMax(times, hourly.temperature_2m ?? []);
    const samples: Record<number, ErrorSample[]> = {};
    for (let l = 1; l <= maxLead; l++) {
      const fc = dailyMax(
        times,
        hourly[`temperature_2m_previous_day${l}`] ?? [],
      );
      const list: ErrorSample[] = [];
      for (const [day, fcMax] of fc) {
        const realMax = realized.get(day);
        if (realMax == null) continue;
        list.push({ date: day, errC: fcMax - realMax });
      }
      list.sort((a, b) => a.date.localeCompare(b.date));
      samples[l] = list;
    }
    return { samples, days: realized.size };
  } catch (err: any) {
    console.error(
      `[Weather] backtest fetch failed for ${geo.name}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Build (or refresh) one city's backtest entry from a freshly fetched sample
 * set, merging with any prior samples so repeated runs accumulate history.
 */
export function buildCityEntry(
  geo: GeoPoint,
  fresh: { samples: Record<number, ErrorSample[]>; days: number },
  prior: CityBacktestEntry | undefined,
  sampleCap: number,
): CityBacktestEntry {
  const mergedSamples: Record<string, ErrorSample[]> = {};
  const leads: Record<string, LeadErrorStats> = {};

  for (let l = 1; l <= BACKTEST_MAX_LEAD; l++) {
    const priorList = prior?.samples?.[String(l)] ?? [];
    const freshList = fresh.samples[l] ?? [];
    // Union by date (fresh wins), keep the most recent `sampleCap` days.
    const byDate = new Map<string, ErrorSample>();
    for (const s of priorList) byDate.set(s.date, s);
    for (const s of freshList) byDate.set(s.date, s);
    const merged = Array.from(byDate.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-sampleCap);
    mergedSamples[String(l)] = merged;
    if (merged.length > 0) leads[String(l)] = statsFromSamples(l, merged);
  }

  const allDays = new Set<string>();
  for (const list of Object.values(mergedSamples)) {
    for (const s of list) allDays.add(s.date);
  }

  return {
    city: geo.name,
    geoName: geo.name,
    lat: geo.lat,
    lon: geo.lon,
    days: allDays.size,
    leads,
    samples: mergedSamples,
  };
}

// ── engine-side consumption ───────────────────────────────────────────────────
export function loadBacktestStore(filePath: string): BacktestStore | null {
  try {
    const fs = require("fs") as typeof import("fs");
    if (!fs.existsSync(filePath)) return null;
    const p = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!p || typeof p.cities !== "object") return null;
    return p as BacktestStore;
  } catch {
    return null;
  }
}

/**
 * Measured forecast-error σ (°C) for a location at a given lead, or undefined
 * when there is no entry with at least `minSamples` scored days. Falls back to
 * the nearest shorter lead that does have enough samples (a shorter-lead σ is a
 * safe under-estimate of a longer-lead σ, preserving the floor's conservatism).
 */
export function measuredErrorSigmaC(
  store: BacktestStore | null,
  geo: GeoPoint,
  lead: number,
  minSamples: number,
): number | undefined {
  if (!store) return undefined;
  const entry = store.cities[geoKey(geo)];
  if (!entry) return undefined;
  const want = Math.max(1, Math.min(BACKTEST_MAX_LEAD, lead));
  for (let l = want; l >= 1; l--) {
    const s = entry.leads[String(l)];
    if (s && s.n >= minSamples && Number.isFinite(s.sigmaC)) return s.sigmaC;
  }
  return undefined;
}
