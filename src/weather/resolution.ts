import axios from "axios";
import { GeoPoint, TempUnit } from "../types";
import { normCdf } from "./forecast";

// ─────────────────────────────────────────────────────────────────────────────
// Resolution-source truth layer.
//
// Polymarket "Highest temperature in <US city>" markets settle on the daily
// maximum reported by an official NWS/ASOS station — the SAME data the U.S.
// National Weather Service publishes via api.weather.gov. This module reads the
// station's actual observations so the bot can reason about the *realized*
// high-so-far instead of a forecast guess.
//
// Two uses:
//   1. Ground-truth calibration  — the real daily max (no circular "market
//      price ≥ 0.9" proxy) for learning each city's grid→station bias.
//   2. Settlement-lock detection — intraday, once the realized high is locked,
//      compute P(final high ∈ bucket | obs so far). This is the only regime in
//      which a temperature contract is a genuine low-risk near-arb.
//
// NWS is U.S.-only and requires a descriptive User-Agent. Non-U.S. cities (and
// any transient API failure) resolve to `null` so callers fall back cleanly to
// the forecast-edge path.
// ─────────────────────────────────────────────────────────────────────────────

const NWS_API = "https://api.weather.gov";
// api.weather.gov mandates a unique, identifying User-Agent or it returns 403.
const NWS_HEADERS = {
  "User-Agent": "polymarket-ct-weather/1.0 (research bot; non-commercial)",
  Accept: "application/geo+json",
};

// Hour of day (local solar) by which daytime heating has essentially peaked.
// After this the running max rarely advances, so the lock collapses to ~0/1.
const PEAK_HEATING_HOUR = 16;
// °F of remaining-max uncertainty per hour of heating still left in the day.
// Scales the spread of how much hotter it can still get; → ~0 after the peak.
const SIGMA_PER_HEATING_HOUR_F = 1.1;

export interface StationObs {
  stationId: string; // e.g. "KNYC"
  timeZone: string; // IANA tz the measurement day is defined in
  unit: TempUnit; // unit of `obsMaxSoFar` (matches the market)
  obsMaxSoFar: number; // highest observed temperature so far on the target day
  readings: number; // how many observations contributed
  localHour: number; // current local hour (fractional) at the station
  hoursOfHeatingLeft: number; // estimated daytime-heating hours remaining
  asOf: number; // epoch ms when fetched
}

interface TzParts {
  date: string; // YYYY-MM-DD in the target tz
  hour: number; // fractional local hour
}

// Decompose an instant into (local date, fractional local hour) for a tz.
function partsInTz(d: Date, tz: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Intl can emit "24" for midnight; normalise to 0.
  const hh = (parseInt(get("hour"), 10) || 0) % 24;
  const mm = parseInt(get("minute"), 10) || 0;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: hh + mm / 60,
  };
}

function cToUnit(celsius: number, unit: TempUnit): number {
  return unit === "F" ? celsius * 1.8 + 32 : celsius;
}

// Estimate daytime-heating hours left from the current local hour. Before the
// afternoon peak this is the gap to the peak; after it, ~0 (high is locked in).
export function heatingHoursLeft(localHour: number): number {
  return Math.max(0, Math.min(12, PEAK_HEATING_HOUR - localHour));
}

/**
 * Fetch the official resolution-station observations for `targetDate` and
 * reduce them to the running daily maximum. Returns null for non-U.S. stations
 * or any API failure (caller should fall back to the forecast path).
 */
export async function fetchStationObs(
  geo: GeoPoint,
  unit: TempUnit,
  targetDate: string,
): Promise<StationObs | null> {
  try {
    // 1. Resolve the grid point → its observation-station list + local tz.
    const pts = await axios.get(
      `${NWS_API}/points/${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`,
      { headers: NWS_HEADERS, timeout: 15_000 },
    );
    const stationsUrl: string | undefined =
      pts.data?.properties?.observationStations;
    const timeZone: string =
      pts.data?.properties?.timeZone || geo.timezone || "UTC";
    if (!stationsUrl) return null; // non-U.S. point — no NWS coverage

    // 2. First listed station is the primary reporting station for the point.
    const stationsRes = await axios.get(stationsUrl, {
      headers: NWS_HEADERS,
      timeout: 15_000,
    });
    const station = stationsRes.data?.features?.[0];
    const stationId: string | undefined =
      station?.properties?.stationIdentifier;
    if (!stationId) return null;

    // 3. Pull observations from the start of the target local day to now.
    const start = `${targetDate}T00:00:00+00:00`;
    const obsRes = await axios.get(
      `${NWS_API}/stations/${stationId}/observations`,
      {
        headers: NWS_HEADERS,
        params: { start, limit: 250 },
        timeout: 20_000,
      },
    );
    const features: any[] = obsRes.data?.features ?? [];

    let maxC = -Infinity;
    let readings = 0;
    for (const f of features) {
      const ts: string | undefined = f?.properties?.timestamp;
      const tempC = f?.properties?.temperature?.value;
      if (!ts || tempC == null || !Number.isFinite(tempC)) continue;
      // Only readings whose LOCAL date is the market's measurement day count.
      if (partsInTz(new Date(ts), timeZone).date !== targetDate) continue;
      readings++;
      if (tempC > maxC) maxC = tempC;
    }
    if (!Number.isFinite(maxC) || readings === 0) return null;

    const now = new Date();
    const { hour: localHour } = partsInTz(now, timeZone);

    return {
      stationId,
      timeZone,
      unit,
      obsMaxSoFar: cToUnit(maxC, unit),
      readings,
      localHour,
      hoursOfHeatingLeft: heatingHoursLeft(localHour),
      asOf: now.getTime(),
    };
  } catch (err: any) {
    // 404 = point outside NWS coverage (non-U.S.); anything else = transient.
    if (err?.response?.status && err.response.status !== 404) {
      console.error(
        `[Weather] NWS obs failed for ${geo.name} ${targetDate}: ${err.message}`,
      );
    }
    return null;
  }
}

/**
 * Conditional probability that the FINAL daily high lands in bucket [lo, hi)
 * given the high observed so far. The final high is max(H, R) where H is the
 * observed-high-so-far and R is the (unknown) max over the remaining heating
 * hours, modelled as Normal(μ_R, σ) with σ shrinking to ~0 as the day ends:
 *
 *   H ≥ hi            → 0      (final ≥ H already exceeds the bucket top)
 *   lo ≤ H < hi       → P(R < hi)            = Φ((hi − μ_R)/σ)
 *   H < lo            → P(lo ≤ R < hi)        = Φ((hi − μ_R)/σ) − Φ((lo − μ_R)/σ)
 *
 * `forecastRemainingMax` (if known) sets μ_R when the high is still expected to
 * climb; otherwise μ_R defaults to H (no further rise), which keeps buckets
 * above the current obs conservatively near 0 until a forecast supports them.
 */
export function lockProbability(
  obs: StationObs,
  lo: number,
  hi: number,
  opts: { forecastRemainingMax?: number; sigmaPerHourF?: number } = {},
): number {
  const H = obs.obsMaxSoFar;
  if (H >= hi) return 0;

  const sigmaPerHourF = opts.sigmaPerHourF ?? SIGMA_PER_HEATING_HOUR_F;
  const perHour = obs.unit === "F" ? sigmaPerHourF : sigmaPerHourF / 1.8;
  const sigma = Math.max(0.1, perHour * obs.hoursOfHeatingLeft);

  // Expected remaining-hours max. It can never be below what's already observed.
  const muR = Math.max(H, opts.forecastRemainingMax ?? H);

  const upper = normCdf((hi - muR) / sigma);
  if (H >= lo) return upper; // H already inside the bucket
  const lower = normCdf((lo - muR) / sigma);
  return Math.max(0, upper - lower);
}
