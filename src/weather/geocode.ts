import axios from "axios";
import { GeoPoint } from "../types";

// Representative coordinates for the cities Polymarket runs recurring daily
// temperature markets on. Where possible these sit near the official reporting
// station (e.g. NYC → Central Park) since that is what the market resolves to.
// Anything not listed here falls back to Open-Meteo's geocoding API.
const CITY_COORDS: Record<string, GeoPoint> = {
  "new york": { lat: 40.779, lon: -73.9692, name: "New York (Central Park)" },
  "los angeles": { lat: 34.0522, lon: -118.2437, name: "Los Angeles" },
  chicago: { lat: 41.9742, lon: -87.9073, name: "Chicago (O'Hare)" },
  houston: { lat: 29.7604, lon: -95.3698, name: "Houston" },
  phoenix: { lat: 33.4484, lon: -112.074, name: "Phoenix" },
  philadelphia: { lat: 39.9526, lon: -75.1652, name: "Philadelphia" },
  "san antonio": { lat: 29.4241, lon: -98.4936, name: "San Antonio" },
  "san diego": { lat: 32.7157, lon: -117.1611, name: "San Diego" },
  dallas: { lat: 32.7767, lon: -96.797, name: "Dallas" },
  austin: { lat: 30.2672, lon: -97.7431, name: "Austin" },
  miami: { lat: 25.7617, lon: -80.1918, name: "Miami" },
  seattle: { lat: 47.6062, lon: -122.3321, name: "Seattle" },
  denver: { lat: 39.7392, lon: -104.9903, name: "Denver" },
  boston: { lat: 42.3601, lon: -71.0589, name: "Boston" },
  atlanta: { lat: 33.749, lon: -84.388, name: "Atlanta" },
  washington: { lat: 38.9072, lon: -77.0369, name: "Washington DC" },
  "san francisco": { lat: 37.7749, lon: -122.4194, name: "San Francisco" },
  "las vegas": { lat: 36.1699, lon: -115.1398, name: "Las Vegas" },
  london: { lat: 51.5074, lon: -0.1278, name: "London" },
  paris: { lat: 48.8566, lon: 2.3522, name: "Paris" },
  berlin: { lat: 52.52, lon: 13.405, name: "Berlin" },
  madrid: { lat: 40.4168, lon: -3.7038, name: "Madrid" },
  rome: { lat: 41.9028, lon: 12.4964, name: "Rome" },
  moscow: { lat: 55.7558, lon: 37.6173, name: "Moscow" },
  istanbul: { lat: 41.0082, lon: 28.9784, name: "Istanbul" },
  seoul: { lat: 37.5665, lon: 126.978, name: "Seoul" },
  tokyo: { lat: 35.6762, lon: 139.6503, name: "Tokyo" },
  beijing: { lat: 39.9042, lon: 116.4074, name: "Beijing" },
  shanghai: { lat: 31.2304, lon: 121.4737, name: "Shanghai" },
  "hong kong": { lat: 22.3193, lon: 114.1694, name: "Hong Kong" },
  singapore: { lat: 1.3521, lon: 103.8198, name: "Singapore" },
  mumbai: { lat: 19.076, lon: 72.8777, name: "Mumbai" },
  delhi: { lat: 28.6139, lon: 77.209, name: "Delhi" },
  dubai: { lat: 25.2048, lon: 55.2708, name: "Dubai" },
  sydney: { lat: -33.8688, lon: 151.2093, name: "Sydney" },
  melbourne: { lat: -37.8136, lon: 144.9631, name: "Melbourne" },
  toronto: { lat: 43.6532, lon: -79.3832, name: "Toronto" },
  "mexico city": { lat: 19.4326, lon: -99.1332, name: "Mexico City" },
  "sao paulo": { lat: -23.5505, lon: -46.6333, name: "São Paulo" },
  "buenos aires": { lat: -34.6037, lon: -58.3816, name: "Buenos Aires" },
};

// Common abbreviations / nicknames used in market titles → canonical key.
const ALIASES: Record<string, string> = {
  nyc: "new york",
  ny: "new york",
  "new york city": "new york",
  la: "los angeles",
  sf: "san francisco",
  dc: "washington",
  "washington dc": "washington",
  "washington d.c.": "washington",
  vegas: "las vegas",
  hk: "hong kong",
  "são paulo": "sao paulo",
};

function normalize(raw: string): string {
  return raw.toLowerCase().replace(/[.?!]/g, "").replace(/\s+/g, " ").trim();
}

const cache = new Map<string, GeoPoint | null>();

// Resolve a city token from a market title to coordinates. Tries the built-in
// table first (most accurate / station-aligned), then Open-Meteo geocoding.
// Results (including misses) are cached for the process lifetime.
export async function resolveCity(raw: string): Promise<GeoPoint | null> {
  const key = normalize(raw);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;

  const canonical = ALIASES[key] ?? key;
  const builtin = CITY_COORDS[canonical];
  if (builtin) {
    cache.set(key, builtin);
    return builtin;
  }

  const geocoded = await geocode(canonical);
  cache.set(key, geocoded);
  return geocoded;
}

async function geocode(name: string): Promise<GeoPoint | null> {
  try {
    const res = await axios.get(
      "https://geocoding-api.open-meteo.com/v1/search",
      {
        params: { name, count: 1, language: "en", format: "json" },
        timeout: 10_000,
      },
    );
    const r = res.data?.results?.[0];
    if (!r || typeof r.latitude !== "number") return null;
    return {
      lat: r.latitude,
      lon: r.longitude,
      name: r.name ?? name,
      timezone: r.timezone,
    };
  } catch (err: any) {
    console.error(`[Weather] geocode failed for "${name}": ${err.message}`);
    return null;
  }
}
