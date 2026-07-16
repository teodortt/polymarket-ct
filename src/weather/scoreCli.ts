import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { setupProxy, verifyProxy } from "../proxy";
import { WeatherTradeRecord } from "../types";
import {
  ReliabilityBin,
  ScoreMetrics,
  ScoreReport,
  scoreTrades,
} from "./scoring";

// Module 6 — Backtesting & Monitoring (read-only, no orders).
//
// Scores the bot's recorded predictions in data/weather.json against their
// resolved Gamma outcomes and prints Brier score, reliability, hit rate and
// realized P&L overall and by forecast horizon, plus a calibration-health
// verdict. Writes data/weatherScore.json (consumed by the opt-in kill switch).
//
//   npm run weather:score
//
// Only BUY entries with a recorded model probability are scored; markets that
// have not resolved yet are skipped and counted.

const DATA_DIR = path.join(process.cwd(), "data");
const STATE_PATH = path.join(DATA_DIR, "weather.json");
const SCORE_PATH = path.join(DATA_DIR, "weatherScore.json");

function loadTrades(): WeatherTradeRecord[] {
  if (!fs.existsSync(STATE_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return Array.isArray(parsed?.trades) ? parsed.trades : [];
  } catch {
    return [];
  }
}

function fmtMetrics(label: string, m: ScoreMetrics): string {
  const sign = m.realizedPnl >= 0 ? "+" : "";
  const roiSign = m.roi >= 0 ? "+" : "";
  const beat =
    m.modelBrier <= m.marketBrier ? "✅ beats market" : "⚠️ worse than market";
  return (
    `${label.padEnd(10)} n=${String(m.n).padStart(3)}  ` +
    `hit ${(m.hitRate * 100).toFixed(0).padStart(3)}%  ` +
    `Brier ${m.modelBrier.toFixed(3)} (mkt ${m.marketBrier.toFixed(3)} ${beat})  ` +
    `logloss ${m.logLoss.toFixed(3)}  ` +
    `P&L ${sign}$${m.realizedPnl.toFixed(2)} (${roiSign}${(m.roi * 100).toFixed(1)}% of $${m.invested.toFixed(0)})`
  );
}

function reliabilityChart(bins: ReliabilityBin[]): string {
  if (bins.length === 0) return "   (no scored trades)";
  const lines = [
    "   predicted → observed (n)   [perfect calibration: ≈ equal]",
  ];
  for (const b of bins) {
    const pred = `${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%`;
    const obs = `${(b.observedFreq * 100).toFixed(0)}%`;
    const barLen = Math.round(b.observedFreq * 20);
    const bar = "█".repeat(barLen) + "·".repeat(20 - barLen);
    lines.push(
      `   ${pred.padEnd(9)} pred ${(b.meanPredicted * 100).toFixed(0).padStart(3)}% ` +
        `→ obs ${obs.padStart(4)}  ${bar}  (n=${b.count})`,
    );
  }
  return lines.join("\n");
}

function healthIcon(status: ScoreReport["health"]["status"]): string {
  return status === "healthy" ? "🟢" : status === "degraded" ? "🔴" : "⚪";
}

async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  console.log(
    "📊 Weather prediction scoring (read-only — no orders)\n" +
      "   Scores recorded model probabilities against resolved outcomes.\n",
  );

  const trades = loadTrades();
  if (trades.length === 0) {
    console.log(
      "No weather trades recorded yet in data/weather.json — run the engine " +
        "(or `npm run weather:scan` place path) first to accumulate predictions.",
    );
    process.exit(0);
  }

  const report = await scoreTrades(trades, {
    minScored: config.weather.calibrationMinScored,
    maxLossRoi: config.weather.calibrationMaxLossRoi,
    onProgress: (done, total) => {
      process.stdout.write(`\r   resolving outcomes… ${done}/${total}`);
      if (done === total) process.stdout.write("\n\n");
    },
  });

  if (report.overall.n === 0) {
    console.log(
      `No resolved trades to score yet ` +
        `(${report.unresolved} still awaiting settlement).`,
    );
    writeReport(report);
    process.exit(0);
  }

  console.log(
    "── Overall & by forecast horizon ──────────────────────────────",
  );
  console.log(fmtMetrics("OVERALL", report.overall));
  for (const [lead, m] of Object.entries(report.byLead)) {
    console.log(fmtMetrics(`lead ${lead}d`, m));
  }

  console.log(
    "\n── Reliability (are the probabilities honest?) ────────────────",
  );
  console.log(reliabilityChart(report.reliability));

  console.log(
    "\n── Calibration health ─────────────────────────────────────────",
  );
  console.log(
    `${healthIcon(report.health.status)} ${report.health.status.toUpperCase()} ` +
      `(${report.health.scoredTrades} scored, ${report.unresolved} unresolved)`,
  );
  for (const r of report.health.reasons) console.log(`   • ${r}`);
  if (report.health.status === "degraded") {
    console.log(
      "   ↳ Set WEATHER_CALIBRATION_KILL_SWITCH=true to pause live trading while degraded.",
    );
  }

  writeReport(report);
  process.exit(0);
}

function writeReport(report: ScoreReport) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SCORE_PATH, JSON.stringify(report, null, 2));
  console.log(
    `\n💾 Wrote ${path.relative(process.cwd(), SCORE_PATH)} ` +
      `(read by the opt-in calibration kill switch).`,
  );
}

main().catch((err) => {
  console.error("[Weather] scoring failed:", err?.message ?? err);
  process.exit(1);
});
