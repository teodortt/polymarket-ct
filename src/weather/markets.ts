import axios from "axios";
import { TempBucket, TempUnit, WeatherMarketEvent } from "../types";

const GAMMA_SEARCH = "https://gamma-api.polymarket.com/public-search";

// Polymarket runs these as recurring events titled e.g.
//   "Highest temperature in NYC on June 14?"
// whose child markets are mutually-exclusive integer-degree buckets.
const TITLE_RE = /highest temperature in (.+?) on /i;

interface DiscoverOpts {
  lookaheadDays: number;
  cities: string[]; // case-insensitive substring filter; empty = all
  minHoursToResolve?: number; // skip events resolving sooner than this
  searchTerms?: string[];
}

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

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function detectUnit(text: string): TempUnit | null {
  if (/°?\s*F\b/i.test(text)) return "F";
  if (/°?\s*C\b/i.test(text)) return "C";
  return null;
}

/**
 * Map a bucket label to the continuous interval [lo, hi) it resolves over.
 * Polymarket reports the daily high as a whole degree, so an "84-85°F" label
 * covers observed highs of 84 or 85 → the real high lies in [83.5, 85.5).
 */
export function parseBucketInterval(
  label: string,
): { lo: number; hi: number } | null {
  const t = label.replace(/°/g, " ").replace(/\s+/g, " ").trim();

  if (/or\s+below|or\s+lower|or\s+colder/i.test(t)) {
    const m = t.match(/(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    return { lo: -Infinity, hi: parseFloat(m[1]) + 0.5 };
  }
  if (/or\s+above|or\s+higher|or\s+warmer|or\s+more/i.test(t)) {
    const m = t.match(/(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    return { lo: parseFloat(m[1]) - 0.5, hi: Infinity };
  }
  // Range "84-85" / "84 - 85" / en-dash. Avoid matching a leading minus sign of
  // the first number as the separator by requiring a digit on both sides.
  const range = t.match(/(-?\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/);
  if (range) {
    const a = parseFloat(range[1]);
    const b = parseFloat(range[2]);
    return { lo: Math.min(a, b) - 0.5, hi: Math.max(a, b) + 0.5 };
  }
  const single = t.match(/(-?\d+(?:\.\d+)?)/);
  if (single) {
    const n = parseFloat(single[1]);
    return { lo: n - 0.5, hi: n + 0.5 };
  }
  return null;
}

function parseBucket(m: any, eventNegRisk: boolean): TempBucket | null {
  const label: string = m.groupItemTitle || m.question || "";
  const interval = parseBucketInterval(label);
  if (!interval) return null;

  const tokens = safeJsonArray(m.clobTokenIds);
  if (tokens.length < 2) return null;

  const prices = safeJsonArray(m.outcomePrices);
  const yesPrice = num(prices[0]) ?? 0;

  return {
    tokenIdYes: String(tokens[0]),
    tokenIdNo: String(tokens[1]),
    conditionId: String(m.conditionId ?? ""),
    question: String(m.question ?? label),
    label,
    lo: interval.lo,
    hi: interval.hi,
    yesPrice,
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    liquidity: num(m.liquidityNum) ?? num(m.liquidity) ?? 0,
    tickSize: num(m.orderPriceMinTickSize) ?? 0.001,
    acceptingOrders: Boolean(m.acceptingOrders),
    negRisk: Boolean(m.negRisk ?? eventNegRisk),
  };
}

function parseEventDate(raw: any): string | null {
  const candidate: string = raw.eventDate || raw.endDate || raw.startDate || "";
  if (!candidate) return null;
  const d = candidate.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function parseEvent(raw: any): WeatherMarketEvent | null {
  const title: string = raw.title ?? raw.question ?? "";
  const titleMatch = title.match(TITLE_RE);
  if (!titleMatch) return null;
  if (raw.closed) return null;

  const city = titleMatch[1].trim();
  const targetDate = parseEventDate(raw);
  if (!targetDate) return null;

  const rawMarkets: any[] = Array.isArray(raw.markets) ? raw.markets : [];
  const eventNegRisk = Boolean(raw.negRisk ?? raw.enableNegRisk);
  const buckets = rawMarkets
    .map((m) => parseBucket(m, eventNegRisk))
    .filter((b): b is TempBucket => b !== null);

  if (buckets.length < 3) return null;

  // Unit: first decisive signal from a bucket label, else the title.
  let unit: TempUnit = "F";
  for (const b of buckets) {
    const u = detectUnit(b.label) || detectUnit(b.question);
    if (u) {
      unit = u;
      break;
    }
  }

  return {
    id: String(raw.id ?? raw.slug ?? title),
    title,
    slug: String(raw.slug ?? ""),
    city,
    unit,
    targetDate,
    endDate: raw.endDate,
    buckets,
  };
}

/**
 * Discover active "Highest temperature in <city>" events within the lookahead
 * window. Uses Polymarket's public search (which returns each event with its
 * child bucket markets and live prices), de-duplicates, and filters by date /
 * optional city list.
 */
export async function discoverTemperatureEvents(
  opts: DiscoverOpts,
): Promise<WeatherMarketEvent[]> {
  const terms =
    opts.searchTerms && opts.searchTerms.length > 0
      ? opts.searchTerms
      : ["highest temperature"];

  const today = new Date().toISOString().slice(0, 10);
  const maxDate = new Date(Date.now() + opts.lookaheadDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const cityFilter = opts.cities.map((c) => c.toLowerCase());
  const byId = new Map<string, WeatherMarketEvent>();

  for (const term of terms) {
    let rawEvents: any[] = [];
    try {
      const res = await axios.get(GAMMA_SEARCH, {
        params: { q: term, limit_per_type: 40 },
        timeout: 15_000,
      });
      rawEvents = Array.isArray(res.data?.events) ? res.data.events : [];
    } catch (err: any) {
      console.error(`[Weather] market search failed (${term}): ${err.message}`);
      continue;
    }

    for (const raw of rawEvents) {
      const event = parseEvent(raw);
      if (!event) continue;
      if (event.targetDate < today || event.targetDate > maxDate) continue;
      // Drop events that are about to settle (realized high may already be in).
      if (
        opts.minHoursToResolve &&
        opts.minHoursToResolve > 0 &&
        event.endDate
      ) {
        const resolveMs = Date.parse(event.endDate);
        if (Number.isFinite(resolveMs)) {
          const hours = (resolveMs - Date.now()) / 3_600_000;
          if (hours < opts.minHoursToResolve) continue;
        }
      }
      if (
        cityFilter.length > 0 &&
        !cityFilter.some((c) => event.city.toLowerCase().includes(c))
      ) {
        continue;
      }
      byId.set(event.id, event);
    }
  }

  return [...byId.values()].sort((a, b) =>
    a.targetDate.localeCompare(b.targetDate),
  );
}
