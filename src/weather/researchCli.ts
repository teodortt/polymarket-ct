import * as path from "path";
import { config } from "../config";
import { setupProxy, verifyProxy } from "../proxy";
import { discoverTemperatureEvents } from "./markets";
import {
  DisputeRisk,
  ResolutionSpec,
  loadResolutionStore,
  mergeResolutionStore,
  researchEvents,
  riskIcon,
  saveResolutionStore,
} from "./resolutionResearch";

// Module 1 — Market & Resolution Research (read-only, no orders).
//
// Discovers the live "Highest temperature in <city>" markets, identifies the
// exact resolution station + source (NWS / airport METAR / city-centre
// synoptic) for each, cross-checks the forecast grid cell against the station,
// flags ambiguities and known dispute patterns, and persists the result to
// data/weatherResolution.json for reuse by the engine and future runs.
//
//   npm run weather:research
//
// Re-running merges into the prior store (preserving any hand-confirmed
// `verified: true` edits), so you can curate the file over time.

const DATA_DIR = path.join(process.cwd(), "data");
const RESOLUTION_PATH = path.join(DATA_DIR, "weatherResolution.json");

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function riskCounts(specs: ResolutionSpec[]): Record<DisputeRisk, number> {
  const c: Record<DisputeRisk, number> = { low: 0, medium: 0, high: 0 };
  for (const s of specs) c[s.disputeRisk]++;
  return c;
}

async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  const cfg = config.weather;
  console.log(
    "🔬 Weather resolution research (read-only — no orders)\n" +
      "   Identifies the exact resolution station + rules per market and flags\n" +
      "   ambiguities. Aligning to the resolution station is the #1 edge factor.\n",
  );

  const events = await discoverTemperatureEvents({
    lookaheadDays: Math.max(1, cfg.lookaheadDays),
    cities: cfg.cities,
    minHoursToResolve: 0,
  });
  console.log(`Discovered ${events.length} temperature event(s).\n`);

  const fresh = await researchEvents(events);
  const prior = loadResolutionStore(RESOLUTION_PATH);
  const merged = mergeResolutionStore(prior, fresh);
  saveResolutionStore(RESOLUTION_PATH, merged);

  const specs = Object.values(fresh.specs).sort(
    (a, b) =>
      ({ high: 0, medium: 1, low: 2 })[a.disputeRisk] -
        { high: 0, medium: 1, low: 2 }[b.disputeRisk] ||
      a.city.localeCompare(b.city),
  );

  console.log(
    `${pad("", 3)}${pad("CITY", 16)}${pad("SOURCE", 9)}${pad("STATION", 10)}` +
      `${pad("TZ", 20)}${pad("GAP", 8)}${pad("VERIFIED", 9)}RISK`,
  );
  console.log("  " + "─".repeat(78));
  for (const s of specs) {
    const gap =
      s.gridStationGapKm != null ? `${s.gridStationGapKm.toFixed(0)}km` : "—";
    console.log(
      `${riskIcon(s.disputeRisk)} ${pad(s.city, 16)}` +
        `${pad(s.source, 9)}${pad(s.stationId ?? "—", 10)}` +
        `${pad(s.timezone ?? "—", 20)}${pad(gap, 8)}` +
        `${pad(s.verified ? "yes" : "no", 9)}${s.disputeRisk}`,
    );
  }

  // Detail the flagged markets so the caveats are actionable.
  const flagged = specs.filter((s) => s.ambiguities.length > 0);
  if (flagged.length > 0) {
    console.log(`\n⚠  Flagged markets (${flagged.length}):`);
    for (const s of flagged) {
      console.log(
        `\n  ${riskIcon(s.disputeRisk)} ${s.displayName} [${s.source}]`,
      );
      for (const a of s.ambiguities) console.log(`     • ${a}`);
      if (s.notes) console.log(`     ↳ ${s.notes}`);
    }
  }

  const counts = riskCounts(specs);
  console.log(
    `\n📊 Risk summary: 🟢 ${counts.low} low · 🟡 ${counts.medium} medium · 🔴 ${counts.high} high` +
      ` (of ${specs.length} cities).`,
  );
  console.log(
    `💾 Wrote ${path.relative(process.cwd(), RESOLUTION_PATH)}. ` +
      `The engine loads it to surface resolution risk on every scan.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[Weather] resolution research failed:", err?.message ?? err);
  process.exit(1);
});
