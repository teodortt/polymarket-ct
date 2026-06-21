import axios from "axios";
import { TempUnit } from "../types";
import { StationObs, cToUnit, heatingHoursLeft, partsInTz } from "./resolution";

// ─────────────────────────────────────────────────────────────────────────────
// Global resolution-station truth via METAR (aviationweather.gov).
//
// The NWS layer in resolution.ts only covers U.S. stations. This module provides
// the same running-daily-max observation for the rest of the world by reading
// the official airport METAR — the same hourly surface obs national met services
// publish — from NOAA's Aviation Weather Center JSON API.
//
// It returns the identical `StationObs` shape as the NWS path so callers can
// treat both sources uniformly (the CLI shows which one produced a reading, and
// later the calibrator can fold either in as ground truth).
//
// ⚠️  BEST-EFFORT STATION IDENTITY: each city is mapped to its principal airport
// METAR. That is NOT guaranteed to be the exact station Polymarket resolves a
// given market against (some cities resolve on a city-center synoptic station,
// e.g. Paris-Montsouris, which has no METAR). This is therefore wired READ-ONLY
// into `npm run weather:obs` first so a METAR-vs-market mismatch is visible
// before it is ever trusted for live calibration.
// ─────────────────────────────────────────────────────────────────────────────

const METAR_API = "https://aviationweather.gov/api/data/metar";
// Hours of METAR history to pull — enough to cover a full local measurement day
// for any timezone offset plus the current partial day.
const METAR_LOOKBACK_HOURS = 30;

export interface MetarStation {
  icao: string; // e.g. "VHHH"
  lat: number; // station coordinates (for future exact-station forecasting)
  lon: number;
  tz: string; // IANA tz the measurement day is defined in
  name: string; // human label
  // True only when this station's daily max matched the market's settled bucket
  // in the read-only verification. Gate live calibration on this.
  verified: boolean;
}

// City token → principal airport METAR station. Keyed by the normalized city
// name (lowercase, punctuation-stripped). U.S. cities are intentionally absent —
// they are served by the more authoritative NWS path in resolution.ts. The
// `verified` flag is attached by resolveMetarStation, not stored here.
const CITY_STATIONS: Record<string, Omit<MetarStation, "verified">> = {
  london: {
    icao: "EGLL",
    lat: 51.4775,
    lon: -0.4614,
    tz: "Europe/London",
    name: "London/Heathrow",
  },
  paris: {
    icao: "LFPO",
    lat: 48.7253,
    lon: 2.3597,
    tz: "Europe/Paris",
    name: "Paris/Orly",
  },
  berlin: {
    icao: "EDDB",
    lat: 52.3514,
    lon: 13.4939,
    tz: "Europe/Berlin",
    name: "Berlin/Brandenburg",
  },
  madrid: {
    icao: "LEMD",
    lat: 40.4719,
    lon: -3.5626,
    tz: "Europe/Madrid",
    name: "Madrid/Barajas",
  },
  rome: {
    icao: "LIRF",
    lat: 41.8003,
    lon: 12.2389,
    tz: "Europe/Rome",
    name: "Rome/Fiumicino",
  },
  moscow: {
    icao: "UUEE",
    lat: 55.9726,
    lon: 37.4146,
    tz: "Europe/Moscow",
    name: "Moscow/Sheremetyevo",
  },
  istanbul: {
    icao: "LTFM",
    lat: 41.2619,
    lon: 28.7414,
    tz: "Europe/Istanbul",
    name: "Istanbul Airport",
  },
  seoul: {
    icao: "RKSS",
    lat: 37.5583,
    lon: 126.7906,
    tz: "Asia/Seoul",
    name: "Seoul/Gimpo",
  },
  tokyo: {
    icao: "RJTT",
    lat: 35.5523,
    lon: 139.7798,
    tz: "Asia/Tokyo",
    name: "Tokyo/Haneda",
  },
  beijing: {
    icao: "ZBAA",
    lat: 40.0725,
    lon: 116.5974,
    tz: "Asia/Shanghai",
    name: "Beijing/Capital",
  },
  shanghai: {
    icao: "ZSSS",
    lat: 31.1979,
    lon: 121.3363,
    tz: "Asia/Shanghai",
    name: "Shanghai/Hongqiao",
  },
  "hong kong": {
    icao: "VHHH",
    lat: 22.3089,
    lon: 113.9145,
    tz: "Asia/Hong_Kong",
    name: "Hong Kong Intl",
  },
  singapore: {
    icao: "WSSS",
    lat: 1.3502,
    lon: 103.9944,
    tz: "Asia/Singapore",
    name: "Singapore/Changi",
  },
  mumbai: {
    icao: "VABB",
    lat: 19.0887,
    lon: 72.8679,
    tz: "Asia/Kolkata",
    name: "Mumbai/Shivaji",
  },
  delhi: {
    icao: "VIDP",
    lat: 28.5562,
    lon: 77.1,
    tz: "Asia/Kolkata",
    name: "Delhi/Gandhi",
  },
  dubai: {
    icao: "OMDB",
    lat: 25.2528,
    lon: 55.3644,
    tz: "Asia/Dubai",
    name: "Dubai Intl",
  },
  sydney: {
    icao: "YSSY",
    lat: -33.9461,
    lon: 151.1772,
    tz: "Australia/Sydney",
    name: "Sydney Intl",
  },
  melbourne: {
    icao: "YMML",
    lat: -37.669,
    lon: 144.841,
    tz: "Australia/Melbourne",
    name: "Melbourne Intl",
  },
  toronto: {
    icao: "CYYZ",
    lat: 43.6777,
    lon: -79.6248,
    tz: "America/Toronto",
    name: "Toronto/Pearson",
  },
  "mexico city": {
    icao: "MMMX",
    lat: 19.4363,
    lon: -99.0721,
    tz: "America/Mexico_City",
    name: "Mexico City Intl",
  },
  "sao paulo": {
    icao: "SBGR",
    lat: -23.4356,
    lon: -46.4731,
    tz: "America/Sao_Paulo",
    name: "São Paulo/Guarulhos",
  },
  "buenos aires": {
    icao: "SAEZ",
    lat: -34.8222,
    lon: -58.5358,
    tz: "America/Argentina/Buenos_Aires",
    name: "Buenos Aires/Ezeiza",
  },
};

// Match the geocode normalization so market city tokens resolve consistently.
const ALIASES: Record<string, string> = {
  hk: "hong kong",
  "são paulo": "sao paulo",
};

// ICAO stations whose realized daily max matched the market's settled bucket in
// the read-only verification (npm run weather:obs, 2026-06-21 snapshot). ONLY
// these should be trusted as ground truth for live calibration. The rest stay
// observational until confirmed over more days. Notably Seoul/RKSS (+2°C) and
// Shanghai/ZSSS (+1°C) read HOTTER than the market — their markets resolve on a
// city-center synoptic station (no METAR), not the airport, so trusting the
// airport would re-introduce the very grid→station bias we are removing.
const VERIFIED_STATIONS = new Set(["VHHH", "RJTT", "WSSS", "ZBAA"]);

function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[.?!]/g, "").replace(/\s+/g, " ").trim();
}

export function resolveMetarStation(city: string): MetarStation | null {
  const key = normalize(city);
  if (!key) return null;
  const canonical = ALIASES[key] ?? key;
  const entry = CITY_STATIONS[canonical];
  if (!entry) return null;
  return { ...entry, verified: VERIFIED_STATIONS.has(entry.icao) };
}

/**
 * Fetch the resolution-station METAR observations for `targetDate` and reduce
 * them to the running daily maximum, in the market's unit. Returns null for a
 * city with no mapped station, no readings on the target local day, or any API
 * failure (caller should fall back to the forecast/market path).
 */
export async function fetchMetarObs(
  city: string,
  unit: TempUnit,
  targetDate: string,
): Promise<StationObs | null> {
  const station = resolveMetarStation(city);
  if (!station) return null;
  try {
    const res = await axios.get(METAR_API, {
      params: {
        ids: station.icao,
        format: "json",
        hours: METAR_LOOKBACK_HOURS,
      },
      timeout: 20_000,
    });
    const obs: any[] = Array.isArray(res.data) ? res.data : [];

    let maxC = -Infinity;
    let readings = 0;
    for (const o of obs) {
      const tempC = o?.temp;
      const epoch = o?.obsTime;
      if (tempC == null || !Number.isFinite(tempC)) continue;
      if (epoch == null || !Number.isFinite(epoch)) continue;
      // Only readings whose LOCAL date is the market's measurement day count.
      if (partsInTz(new Date(epoch * 1000), station.tz).date !== targetDate) {
        continue;
      }
      readings++;
      if (tempC > maxC) maxC = tempC;
    }
    if (!Number.isFinite(maxC) || readings === 0) return null;

    const now = new Date();
    const { hour: localHour } = partsInTz(now, station.tz);

    return {
      stationId: station.icao,
      timeZone: station.tz,
      unit,
      obsMaxSoFar: cToUnit(maxC, unit),
      readings,
      localHour,
      hoursOfHeatingLeft: heatingHoursLeft(localHour),
      asOf: now.getTime(),
    };
  } catch (err: any) {
    console.error(
      `[Weather] METAR obs failed for ${city} (${station.icao}) ${targetDate}: ${err.message}`,
    );
    return null;
  }
}
