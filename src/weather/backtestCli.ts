import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { setupProxy, verifyProxy } from "../proxy";
import { knownCities, resolveCity } from "./geocode";
import {
  BACKTEST_MAX_LEAD,
  BacktestStore,
  buildCityEntry,
  CityBacktestEntry,
  fetchLeadErrorSamples,
  geoKey,
  loadBacktestStore,
} from "./backtest";

// Read-only forecast-skill backtest. For each city it measures the daily-max
// forecast ERROR distribution per lead day (forecast vs the model's own latest
// analysis) and writes the result to data/weatherBacktest.json, which the live
// engine reads as a per-(city, lead) σ floor so the predictive distribution can
// never be narrower than the empirically observed forecast error.
//
//   npm run weather:backtest [lookbackDays] [city,city,...]
//
// Places NO orders. The only thing it writes is the backtest data file. Running
// it repeatedly accumulates samples (deduped by date) rather than overwriting.

const DATA_DIR = path.join(process.cwd(), "data");
const BACKTEST_PATH = path.join(DATA_DIR, "weatherBacktest.json");
const SAMPLE_CAP = 120; // keep up to ~4 months of scored days per (city, lead)
const C_TO_F = 1.8;

function cToF(c: number): number {
  return c * C_TO_F;
}

async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  const cfg = config.weather;

  const argLookback = parseInt(process.argv[2] || "", 10);
  const lookbackDays = Number.isFinite(argLookback) ? argLookback : 60;
  const argCities = (process.argv[3] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const cityList =
    argCities.length > 0
      ? argCities
      : cfg.cities.length > 0
        ? cfg.cities
        : knownCities();

  console.log(
    `🧪 Weather forecast-skill backtest (read-only — no orders)\n` +
      `   lookback ${lookbackDays}d • ${cityList.length} cities • ` +
      `error = forecast − analysis (model self-consistency, °C)\n`,
  );

  const prior = loadBacktestStore(BACKTEST_PATH);
  const store: BacktestStore = {
    generatedAt: Date.now(),
    lookbackDays,
    cities: prior?.cities ? { ...prior.cities } : {},
  };

  const entries: CityBacktestEntry[] = [];
  for (const city of cityList) {
    const geo = await resolveCity(city);
    if (!geo) {
      console.log(`• ${city.padEnd(16)} — no coordinates, skip`);
      continue;
    }
    const fresh = await fetchLeadErrorSamples(geo, lookbackDays);
    if (!fresh) {
      console.log(`• ${geo.name.padEnd(16)} — fetch failed, skip`);
      continue;
    }
    const key = geoKey(geo);
    const entry = buildCityEntry(geo, fresh, prior?.cities?.[key], SAMPLE_CAP);
    store.cities[key] = entry;
    entries.push(entry);

    const l1 = entry.leads["1"];
    const l3 = entry.leads["3"];
    console.log(
      `• ${geo.name.padEnd(22)} days ${String(entry.days).padStart(3)}  ` +
        (l1
          ? `lead1 σ ${l1.sigmaC.toFixed(2)}°C (${cToF(l1.sigmaC).toFixed(1)}°F)`
          : "lead1 σ   n/a") +
        "  " +
        (l3
          ? `lead3 σ ${l3.sigmaC.toFixed(2)}°C (${cToF(l3.sigmaC).toFixed(1)}°F)`
          : "lead3 σ   n/a"),
    );
    await sleep(200); // be polite to the API
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKTEST_PATH, JSON.stringify(store, null, 2));

  printAggregate(entries, cfg.kdeBandwidthF, cfg.kdeLeadPerDayF);

  console.log(
    `\n💾 Wrote ${path.relative(process.cwd(), BACKTEST_PATH)} ` +
      `(${Object.keys(store.cities).length} cities). ` +
      `The engine reads it as a σ floor when WEATHER_BACKTEST_SIGMA_FLOOR=true.`,
  );
  process.exit(0);
}

// Aggregate the measured error σ across cities per lead and contrast it with the
// production KDE kernel σ (kdeBandwidthF + lead·kdeLeadPerDayF) so overconfidence
// is obvious at a glance.
function printAggregate(
  entries: CityBacktestEntry[],
  kdeBandwidthF: number,
  kdeLeadPerDayF: number,
) {
  if (entries.length === 0) return;
  console.log(
    `\n── Aggregate error vs production KDE σ (all cities, °F) ─────────────`,
  );
  console.log(
    `lead   n      bias    MAE    measured σ    model KDE σ    verdict`,
  );
  for (let l = 1; l <= BACKTEST_MAX_LEAD; l++) {
    const sigmas: number[] = [];
    const biases: number[] = [];
    const maes: number[] = [];
    let n = 0;
    for (const e of entries) {
      const s = e.leads[String(l)];
      if (!s) continue;
      sigmas.push(s.sigmaC);
      biases.push(s.biasC);
      maes.push(s.maeC);
      n += s.n;
    }
    if (sigmas.length === 0) continue;
    const measF = cToF(avg(sigmas));
    const modelF = kdeBandwidthF + l * kdeLeadPerDayF;
    const ratio = measF / modelF;
    const verdict =
      ratio > 1.25
        ? `⚠️  model ${ratio.toFixed(1)}× too narrow`
        : ratio < 0.8
          ? `model wider than needed`
          : `~ok`;
    console.log(
      `${String(l).padStart(2)}   ${String(n).padStart(4)}   ` +
        `${cToF(avg(biases)).toFixed(2).padStart(5)}  ` +
        `${cToF(avg(maes)).toFixed(2).padStart(5)}  ` +
        `${measF.toFixed(2).padStart(8)}°F  ` +
        `${modelF.toFixed(2).padStart(8)}°F   ${verdict}`,
    );
  }
  console.log(
    `\nNote: σ is forecast-vs-analysis only — it excludes the grid→station gap,\n` +
      `so it is a conservative LOWER bound. The engine uses it as a floor that\n` +
      `widens (never narrows) the forecast; per-city station bias stays with the\n` +
      `obs-grounded calibrator.`,
  );
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[Weather] backtest failed:", err?.message ?? err);
  process.exit(1);
});
