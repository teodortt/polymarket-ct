import * as fs from "fs";
import * as path from "path";
import { GeoPoint, TempUnit, WeatherMarketEvent } from "../types";
import { resolveCity } from "./geocode";
import { resolveNwsStation } from "./resolution";
import { resolveMetarStation } from "./metar";

// ─────────────────────────────────────────────────────────────────────────────
// Module 1 — Market & Resolution Research.
//
// Extracts and PERSISTS the exact resolution criteria for each live temperature
// market: which official station the daily high is read from, the source
// (NWS/ASOS vs airport METAR vs a city-centre synoptic station), the timezone
// the measurement day is defined in, the rounding rule, and — critically — any
// AMBIGUITY or known dispute pattern that would make an edge illusory.
//
// Why this matters (verified the hard way in this repo's history): the single
// biggest driver of weather-market P&L is matching the EXACT resolution station.
// Forecasting a city centroid that is 1–3°C off the station the market settles
// on turns a "20% edge" into a guaranteed loss in 1° buckets. This module turns
// that scattered, tribal knowledge into a structured, reusable, hand-editable
// store the rest of the pipeline can consult.
//
// Read-only: it never places orders. It writes exactly one artifact,
// data/weatherResolution.json, which the engine loads to SURFACE resolution risk
// on every scan (and, opt-in, to skip high-dispute markets).
// ─────────────────────────────────────────────────────────────────────────────

export type ResolutionSource = "NWS" | "METAR" | "SYNOPTIC" | "UNKNOWN";
export type DisputeRisk = "low" | "medium" | "high";

export interface ResolutionSpec {
  city: string; // normalized city key (matches the market-title token)
  displayName: string; // human-readable station/city label
  source: ResolutionSource; // how the market's daily high is measured
  stationId: string | null; // e.g. "KNYC" (NWS) or "VHHH" (ICAO METAR)
  stationName: string | null;
  timezone: string | null; // IANA tz the measurement day is defined in
  unit: TempUnit | null; // market unit hint (F for US markets, else usually C)
  rounding: string; // observed-high rounding rule the buckets encode
  observationWindow: string; // window the daily maximum is taken over
  forecastCoords: { lat: number; lon: number } | null; // grid used to forecast
  stationCoords: { lat: number; lon: number } | null; // resolution-station coords
  gridStationGapKm: number | null; // distance forecast grid ↔ station
  verified: boolean; // station confirmed to match settlement over ≥1 day
  disputeRisk: DisputeRisk;
  ambiguities: string[]; // flags / known dispute patterns
  notes?: string;
  updatedAt: number;
}

export interface ResolutionStore {
  generatedAt: number;
  specs: Record<string, ResolutionSpec>; // keyed by normalized city
}

// Whole-degree buckets: the market reports the observed high as an integer, so
// an "84-85°F" label covers observed highs of 84 or 85 → the true high lies in
// [83.5, 85.5). This is the invariant `markets.parseBucketInterval` encodes.
const DEFAULT_ROUNDING = "whole degree (bucket expands ±0.5°)";
const DEFAULT_WINDOW = "local calendar day (00:00–23:59 station-local)";
// A forecast grid cell more than this far from the resolution station is a
// material grid→station bias risk in 1° buckets.
const GRID_STATION_GAP_WARN_KM = 25;

// Documented dispute patterns learned from real settlements in this repo's
// history. Seeded so the research store starts with hard-won caveats even
// before a station is re-verified. Keyed by normalized city.
interface DisputeSeed {
  risk: DisputeRisk;
  source?: ResolutionSource;
  ambiguities: string[];
  notes?: string;
}

const KNOWN_DISPUTES: Record<string, DisputeSeed> = {
  seoul: {
    risk: "high",
    source: "SYNOPTIC",
    ambiguities: [
      "Airport METAR RKSS/Gimpo read ~+2°C hotter than the market's settled bucket — the market resolves on a city-centre synoptic station (no METAR), NOT the airport.",
      "Do NOT trust airport obs as ground truth; airport-anchored forecasts run hot here.",
    ],
    notes:
      "Find the correct KMA city-centre synoptic station before trusting any edge.",
  },
  shanghai: {
    risk: "high",
    source: "SYNOPTIC",
    ambiguities: [
      "Airport METAR ZSSS/Hongqiao read ~+1°C hotter than the market's settled bucket — likely a city-centre synoptic station, not the airport.",
    ],
    notes: "Airport-anchored forecast runs hot; verify the synoptic station.",
  },
  "los angeles": {
    risk: "medium",
    ambiguities: [
      "NWS point→station lookup for the LA centroid picked a coastal RAWS (e.g. FHMC1), not the downtown USC/KLAX station the market resolves on — coastal RAWS runs much cooler.",
      "Confirm the station id resolves to USC/downtown or KLAX before trading.",
    ],
  },
};

// ICAO stations independently confirmed to match the market's settled bucket in
// the read-only obs verification (mirrors metar.ts VERIFIED_STATIONS). Used only
// to seed the initial `verified` flag; re-verify periodically.
const VERIFIED_ICAO = new Set(["VHHH", "RJTT", "WSSS", "ZBAA"]);

export function normalizeCity(raw: string): string {
  return raw.toLowerCase().replace(/[.?!]/g, "").replace(/\s+/g, " ").trim();
}

// Great-circle distance in km between two lat/lon points.
function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A U.S. ASOS/AWOS primary-city station is a 4-letter ICAO starting with K (or
// P for the Pacific/Alaska). A station id that does not match that shape (e.g.
// the RAWS "FHMC1") is a hint the point lookup drifted off the city station.
function looksLikePrimaryUsStation(id: string): boolean {
  return /^[KP][A-Z]{3}$/.test(id);
}

function worstRisk(a: DisputeRisk, b: DisputeRisk): DisputeRisk {
  const rank: Record<DisputeRisk, number> = { low: 0, medium: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * Research one city's resolution criteria by consulting the same NWS and METAR
 * layers the live engine uses, cross-checking the forecast grid cell against the
 * resolution-station coordinates, and folding in any documented dispute pattern.
 * `unit` is the market unit when known (from a discovered event), else null.
 */
export async function researchCity(
  rawCity: string,
  unit: TempUnit | null = null,
): Promise<ResolutionSpec> {
  const city = normalizeCity(rawCity);
  const seed = KNOWN_DISPUTES[city];

  const geo: GeoPoint | null = await resolveCity(rawCity);
  const forecastCoords = geo ? { lat: geo.lat, lon: geo.lon } : null;

  let source: ResolutionSource = "UNKNOWN";
  let stationId: string | null = null;
  let stationName: string | null = null;
  let timezone: string | null = geo?.timezone ?? null;
  let stationCoords: { lat: number; lon: number } | null = null;
  let verified = false;
  const ambiguities: string[] = [];

  // 1. U.S. markets resolve on the authoritative NWS/ASOS station.
  if (geo) {
    const nws = await resolveNwsStation(geo);
    if (nws) {
      source = "NWS";
      stationId = nws.stationId;
      stationName = nws.stationId;
      timezone = nws.timeZone || timezone;
      verified = looksLikePrimaryUsStation(nws.stationId);
      if (!verified) {
        ambiguities.push(
          `NWS point lookup returned "${nws.stationId}", which is not a standard K-prefixed primary-city station — it may be a RAWS/secondary site, not the station the market settles on. Verify manually.`,
        );
      }
    }
  }

  // 2. Everything else → best-effort global airport METAR.
  if (source === "UNKNOWN") {
    const metar = resolveMetarStation(rawCity);
    if (metar) {
      source = "METAR";
      stationId = metar.icao;
      stationName = metar.name;
      timezone = metar.tz || timezone;
      stationCoords = { lat: metar.lat, lon: metar.lon };
      verified = metar.verified || VERIFIED_ICAO.has(metar.icao);
      if (!verified) {
        ambiguities.push(
          "Airport METAR is a best-effort proxy — NOT confirmed to match the market's resolution station. Verify daily max vs a settled bucket before trusting.",
        );
      }
    }
  }

  // Cross-check: a forecast grid cell far from the resolution station is a
  // direct grid→station bias risk (fatal in 1° buckets).
  let gridStationGapKm: number | null = null;
  if (forecastCoords && stationCoords) {
    gridStationGapKm = haversineKm(forecastCoords, stationCoords);
    if (gridStationGapKm > GRID_STATION_GAP_WARN_KM) {
      ambiguities.push(
        `Forecast grid cell is ${gridStationGapKm.toFixed(0)} km from the resolution station — the per-city bias calibrator must absorb this offset before trusting an edge.`,
      );
    }
  }

  if (source === "UNKNOWN") {
    ambiguities.push(
      "No resolution station identified (non-U.S. and unmapped). The engine falls back to a forecast-grid edge with no station anchor — treat any edge as unverified.",
    );
  }

  // Fold documented dispute patterns in.
  if (seed) {
    if (seed.source) source = seed.source;
    for (const a of seed.ambiguities) {
      if (!ambiguities.includes(a)) ambiguities.push(a);
    }
  }

  // Derive dispute risk from source quality, station match and any seed.
  let disputeRisk: DisputeRisk;
  if (source === "UNKNOWN") disputeRisk = "high";
  else if (source === "SYNOPTIC") disputeRisk = "high";
  else if (verified) disputeRisk = "low";
  else if (
    gridStationGapKm != null &&
    gridStationGapKm > GRID_STATION_GAP_WARN_KM
  )
    disputeRisk = "high";
  else disputeRisk = "medium";
  if (seed) disputeRisk = worstRisk(disputeRisk, seed.risk);

  return {
    city,
    displayName: geo?.name ?? stationName ?? rawCity,
    source,
    stationId,
    stationName,
    timezone,
    unit,
    rounding: DEFAULT_ROUNDING,
    observationWindow: DEFAULT_WINDOW,
    forecastCoords,
    stationCoords,
    gridStationGapKm,
    verified,
    disputeRisk,
    ambiguities,
    notes: seed?.notes,
    updatedAt: Date.now(),
  };
}

/**
 * Research every unique city in a set of discovered events and return a fresh
 * resolution store. Deduplicates by normalized city so each station is resolved
 * once.
 */
export async function researchEvents(
  events: WeatherMarketEvent[],
): Promise<ResolutionStore> {
  const unitByCity = new Map<string, TempUnit>();
  for (const e of events) {
    const key = normalizeCity(e.city);
    if (!unitByCity.has(key)) unitByCity.set(key, e.unit);
  }

  const specs: Record<string, ResolutionSpec> = {};
  for (const [key, unit] of unitByCity) {
    const spec = await researchCity(key, unit);
    specs[key] = spec;
  }
  return { generatedAt: Date.now(), specs };
}

// ── persistence ───────────────────────────────────────────────────────────────
export function loadResolutionStore(filePath: string): ResolutionStore | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const p = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!p || typeof p.specs !== "object") return null;
    return p as ResolutionStore;
  } catch {
    return null;
  }
}

export function saveResolutionStore(
  filePath: string,
  store: ResolutionStore,
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

/**
 * Merge freshly-researched specs into a prior store. A newly-identified station
 * upgrades an UNKNOWN one; a manual `verified: true` edit or note in the prior
 * store is preserved unless the fresh research also verifies it.
 */
export function mergeResolutionStore(
  prior: ResolutionStore | null,
  fresh: ResolutionStore,
): ResolutionStore {
  const specs: Record<string, ResolutionSpec> = { ...(prior?.specs ?? {}) };
  for (const [key, next] of Object.entries(fresh.specs)) {
    const old = specs[key];
    specs[key] = {
      ...next,
      // Preserve a human-confirmed verification and hand-written notes.
      verified: next.verified || Boolean(old?.verified),
      notes: next.notes ?? old?.notes,
    };
  }
  return { generatedAt: Date.now(), specs };
}

export function getResolutionSpec(
  store: ResolutionStore | null,
  city: string,
): ResolutionSpec | null {
  if (!store) return null;
  return store.specs[normalizeCity(city)] ?? null;
}

const RISK_ICON: Record<DisputeRisk, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
};

// One-line resolution note for reports/alerts (read-only surfacing).
export function resolutionNote(
  spec: ResolutionSpec | null,
): string | undefined {
  if (!spec) return undefined;
  const station = spec.stationId
    ? `${spec.source} ${spec.stationId}`
    : spec.source;
  const gap =
    spec.gridStationGapKm != null && spec.gridStationGapKm > 0
      ? ` · grid↔station ${spec.gridStationGapKm.toFixed(0)}km`
      : "";
  const flag =
    spec.ambiguities.length > 0 ? ` · ${spec.ambiguities.length} flag(s)` : "";
  return `${RISK_ICON[spec.disputeRisk]} resolution: ${station}${spec.verified ? " (verified)" : ""}${gap}${flag}`;
}

export function riskIcon(risk: DisputeRisk): string {
  return RISK_ICON[risk];
}
