import { config } from "../config";
import { setupProxy, verifyProxy } from "../proxy";
import { discoverTemperatureEvents } from "./markets";
import { resolveCity } from "./geocode";
import { fetchStationObs, lockProbability } from "./resolution";

// Read-only settlement-lock scanner. For each near-term temperature event it
// pulls the OFFICIAL NWS resolution-station observations, computes the
// realized-high-so-far, and shows P(final high ∈ bucket | obs) against the live
// ask — surfacing genuine intraday "resolution gaps" WITHOUT placing any order.
//
//   npm run weather:obs
//
// Non-U.S. cities (no NWS coverage) and future days (no observations yet) are
// reported as skipped — they fall back to the forecast-edge path in the engine.
async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  const cfg = config.weather;
  console.log("🔎 Weather settlement-lock scan (read-only — no orders)\n");

  const events = await discoverTemperatureEvents({
    lookaheadDays: Math.max(1, cfg.lookaheadDays),
    cities: cfg.cities,
    minHoursToResolve: 0,
  });
  console.log(`Discovered ${events.length} temperature event(s).\n`);

  const u = (unit: string) => `°${unit}`;
  let gaps = 0;

  for (const event of events) {
    const geo = await resolveCity(event.city);
    if (!geo) {
      console.log(`• ${event.city} ${event.targetDate} — no coordinates, skip`);
      continue;
    }

    const obs = await fetchStationObs(geo, event.unit, event.targetDate);
    if (!obs) {
      console.log(
        `• ${event.city} ${event.targetDate} — no NWS obs yet ` +
          `(non-U.S. station or future day), skip`,
      );
      continue;
    }

    console.log(
      `\n=== ${event.city} ${event.targetDate} — station ${obs.stationId} ===`,
    );
    console.log(
      `   realized high so far: ${obs.obsMaxSoFar.toFixed(1)}${u(event.unit)} ` +
        `| local ${obs.localHour.toFixed(1)}h ` +
        `| heating left ~${obs.hoursOfHeatingLeft.toFixed(1)}h ` +
        `| ${obs.readings} readings`,
    );

    const rows = event.buckets
      .slice()
      .sort((a, b) => a.lo - b.lo)
      .map((bucket) => {
        const p = lockProbability(obs, bucket.lo, bucket.hi);
        const ask = bucket.bestAsk;
        // A real gap needs a resting ask inside a sane band: above the engine's
        // min price (sub-cent asks are empty/stale books, not fills) and at or
        // below the lock ceiling (a 100¢ winner has no edge left).
        const tradeable =
          ask != null && ask >= cfg.minPrice && ask <= cfg.lockMaxAsk;
        const locked = p >= cfg.lockMinProb;
        const isGap = locked && tradeable;
        if (isGap) gaps++;
        return { bucket, p, ask, locked, isGap };
      });

    for (const r of rows) {
      const askStr = r.ask != null ? `${(r.ask * 100).toFixed(0)}¢` : "  — ";
      let flag = "";
      if (r.isGap) {
        const roi = ((1 / (r.ask as number) - 1) * 100).toFixed(0);
        flag = `  ⭐ LOCK GAP  (buy ${(r.ask! * 100).toFixed(0)}¢ → ~${roi}% ROI if it holds)`;
      } else if (r.locked) {
        // Lock detected but no edge: either already ~100¢ or no real ask resting.
        flag = "  🔒 locked (no tradeable gap)";
      }
      console.log(
        `   ${r.bucket.label.padEnd(14)} ` +
          `lock ${(r.p * 100).toFixed(1).padStart(5)}%  ask ${askStr.padStart(5)}${flag}`,
      );
    }
  }

  console.log(
    `\n${gaps > 0 ? "⭐" : "—"} ${gaps} settlement-lock gap(s) ` +
      `(lock ≥ ${(cfg.lockMinProb * 100).toFixed(0)}%, ask ≤ ${(cfg.lockMaxAsk * 100).toFixed(0)}¢).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[Weather] obs scan failed:", err?.message ?? err);
  process.exit(1);
});
