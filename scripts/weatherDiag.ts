/**
 * Weather trade-path diagnostic (read-only, places NO orders).
 *
 * The read-only `npm run weather:scan` never enters the trade decision path,
 * so it hides every `maybeTrade`-level blocker (lead/cutoff/open-position/size).
 * This script runs the AUTHENTIC forecast pipeline via the engine's public
 * `scanOnce({place:false})` (so per-city bias + σ-floor are applied exactly as
 * in production), then mirrors each `maybeTrade` gate to report, per event, the
 * single reason it would or would not fire a trade right now.
 *
 *   npx ts-node scripts/weatherDiag.ts
 */
import { config } from "../src/config";
import { setupProxy, verifyProxy } from "../src/proxy";
import { WeatherEngine } from "../src/weather/engine";
import { getLiveUsdcBalance } from "../src/trader";
import { WeatherSignal } from "../src/types";

function localClockFromLon(lon: number): { date: string; hour: number } {
  const offsetMs = (lon / 15) * 3_600_000;
  const localNow = new Date(Date.now() + offsetMs);
  return {
    date: localNow.toISOString().slice(0, 10),
    hour: localNow.getUTCHours() + localNow.getUTCMinutes() / 60,
  };
}

// Mirror of WeatherEngine.maybeTrade gates (sizing approximated with bankroll).
function tradeVerdict(
  s: WeatherSignal,
  cfg: typeof config.weather,
  bankroll: number,
  openEventKeys: Set<string>,
  cityBiasSamples: number,
): { fires: boolean; reason: string; notional?: number } {
  const best = s.best;
  if (!best || best.buyPrice == null) {
    return {
      fires: false,
      reason: `predictor: ${s.bestRejectionReason ?? "no actionable bucket"}`,
    };
  }
  if (
    cfg.minCityBiasSamplesToTrade > 0 &&
    cityBiasSamples < cfg.minCityBiasSamplesToTrade
  ) {
    return {
      fires: false,
      reason: `calibration samples ${cityBiasSamples} < min ${cfg.minCityBiasSamplesToTrade}`,
    };
  }
  if (s.forecast.leadDays < cfg.minLeadDays) {
    return {
      fires: false,
      reason: `lead ${s.forecast.leadDays}d < minLeadDays ${cfg.minLeadDays}`,
    };
  }
  if (s.forecast.leadDays === 0 && cfg.sameDayCutoffHour < 24) {
    const { date, hour } = localClockFromLon(s.geo.lon);
    const past =
      date > s.event.targetDate ||
      (date === s.event.targetDate && hour >= cfg.sameDayCutoffHour);
    if (past) {
      return {
        fires: false,
        reason: `same-day past cutoff (local ~${hour.toFixed(1)}h ≥ ${cfg.sameDayCutoffHour}h)`,
      };
    }
  }
  const key = `${s.event.city.trim().toLowerCase()}|${s.event.targetDate}`;
  if (openEventKeys.has(key)) {
    return { fires: false, reason: "already has open position for city+date" };
  }
  const frac = best.kellyFraction * cfg.kellyFraction;
  let notional = frac * bankroll;
  notional = Math.min(
    notional,
    cfg.maxTradeUsdc,
    bankroll * cfg.maxBankrollFractionPerEvent,
    best.bucket.liquidity * cfg.maxLiquidityFraction,
  );
  notional = Math.floor(notional * 100) / 100;
  if (notional < cfg.minTradeUsdc) {
    return {
      fires: false,
      reason: `notional $${notional.toFixed(2)} < minTrade $${cfg.minTradeUsdc}`,
      notional,
    };
  }
  return { fires: true, reason: "WOULD FIRE", notional };
}

async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  const cfg = config.weather;
  console.log(
    "🔎 Weather trade-path diagnostic (read-only — NO orders placed)\n",
  );
  console.log(
    `Config: enabled=${cfg.enabled} dryRun=${config.dryRun} minEdge=${cfg.minEdge} ` +
      `minPrice=${cfg.minPrice} maxPrice=${cfg.maxPrice} minLiq=$${cfg.minLiquidityUsdc} ` +
      `minLeadDays=${cfg.minLeadDays} sameDayCutoffHour=${cfg.sameDayCutoffHour} ` +
      `lookaheadDays=${cfg.lookaheadDays} kde=${cfg.kdeBandwidthF} maxTrades/scan=${cfg.maxTradesPerScan}\n`,
  );

  // Execution mode + (live) balance — in LIVE mode an empty USDC wallet blocks
  // every order regardless of edge, so surface it up front.
  let bankroll =
    cfg.bankrollUsdc > 0 ? cfg.bankrollUsdc : config.dryRunStartUsdc;
  if (config.dryRun) {
    console.log(
      `Execution: DRY_RUN (virtual bankroll $${bankroll.toFixed(2)})`,
    );
  } else {
    const live = await getLiveUsdcBalance();
    const minNeeded = Math.max(config.minTradeUsdc, cfg.minTradeUsdc);
    if (live) {
      bankroll = cfg.bankrollUsdc > 0 ? cfg.bankrollUsdc : live.balance;
      const warn =
        live.balance < minNeeded
          ? `  ⚠️ BELOW min trade $${minNeeded} — NO live order can fill!`
          : "";
      console.log(
        `Execution: LIVE | funder ${live.address} | USDC $${live.balance.toFixed(2)}${warn}`,
      );
    } else {
      console.log(
        `Execution: LIVE | ⚠️ could not read USDC balance (auth/funder/proxy?) — orders may fail`,
      );
    }
  }
  console.log("");

  const engine = new WeatherEngine();
  const openEventKeys = new Set(
    engine
      .getOpenPositions()
      .map((p) => `${p.city.trim().toLowerCase()}|${p.targetDate}`),
  );
  const cityBiasSamples = new Map<string, number>();
  for (const p of engine.getCalibrationSummary().byCity) {
    cityBiasSamples.set(p.city.trim().toLowerCase(), p.samples);
  }

  const signals = await engine.scanOnce({ place: false });
  console.log(
    `\nDiscovered ${signals.length} event(s). Open positions: ${openEventKeys.size}\n`,
  );

  let wouldFire = 0;
  const rows = signals
    .map((s) => {
      const v = tradeVerdict(
        s,
        cfg,
        bankroll,
        openEventKeys,
        cityBiasSamples.get(s.event.city.trim().toLowerCase()) ?? 0,
      );
      if (v.fires) wouldFire++;
      const mode = s.buckets[0];
      return {
        fires: v.fires,
        line:
          `${v.fires ? "✅" : "—"} ${s.event.city.padEnd(16)} ${s.event.targetDate} ` +
          `lead${s.forecast.leadDays} | mode ${mode?.bucket.label ?? "?"} ` +
          `p=${((mode?.modelProb ?? 0) * 100).toFixed(0)}% ask=${mode?.buyPrice != null ? (mode.buyPrice * 100).toFixed(1) + "¢" : "—"} ` +
          `edge=${mode?.edge != null && mode.edge > -1 ? (mode.edge * 100).toFixed(1) + "%" : "—"} ` +
          `liq=$${(mode?.bucket.liquidity ?? 0).toFixed(0)} → ${v.reason}`,
      };
    })
    .sort((a, b) => Number(b.fires) - Number(a.fires));

  for (const r of rows) console.log(r.line);

  // Aggregate the blocking reasons so the dominant failure mode is obvious.
  const reasonCounts = new Map<string, number>();
  for (const s of signals) {
    const v = tradeVerdict(
      s,
      cfg,
      bankroll,
      openEventKeys,
      cityBiasSamples.get(s.event.city.trim().toLowerCase()) ?? 0,
    );
    const bucketed = v.fires
      ? "WOULD FIRE"
      : v.reason
          .replace(/\$[0-9.]+/g, "$X")
          .replace(/[0-9.]+¢/g, "X¢")
          .replace(/[0-9.]+%/g, "X%")
          .replace(/local ~[0-9.]+h/g, "local ~Xh")
          .replace(/lead \d+d/g, "lead Nd");
    reasonCounts.set(bucketed, (reasonCounts.get(bucketed) ?? 0) + 1);
  }
  console.log("\n── Blocker summary ──");
  [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, n]) =>
      console.log(`  ${String(n).padStart(3)}  ${reason}`),
    );
  console.log(
    `\nWOULD FIRE this scan: ${wouldFire} (cap ${cfg.maxTradesPerScan}/scan, ${cfg.maxTradesPerDay}/day)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[diag] failed:", err?.stack ?? err?.message ?? err);
  process.exit(1);
});
