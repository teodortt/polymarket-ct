import { WeatherSignal, WeatherTradeRecord } from "../types";

interface ReportOpts {
  markdown: boolean;
  lastScanAt?: number;
  enabled?: boolean;
  maxEvents?: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function ago(ts?: number): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Render the latest predictions + recent trades. Shared by the Telegram
 * `/weather` command (markdown) and the CLI scan tool (plain text).
 */
export function formatReport(
  signals: WeatherSignal[],
  trades: WeatherTradeRecord[],
  opts: ReportOpts,
): string {
  const b = (t: string) => (opts.markdown ? `*${t}*` : t);
  const maxEvents = opts.maxEvents ?? 6;
  const lines: string[] = [];

  lines.push(`🌦 ${b("Weather predictions")} (scan ${ago(opts.lastScanAt)})`);
  if (opts.enabled === false) {
    lines.push("_module disabled — set WEATHER_ENABLED=true_");
  }

  if (signals.length === 0) {
    lines.push("\nNo active temperature markets in the lookahead window.");
  }

  for (const s of signals.slice(0, maxEvents)) {
    const f = s.forecast;
    const u = `°${f.unit}`;
    const top = s.buckets[0];
    const mktTop = s.buckets.reduce((a, c) =>
      c.marketProb > a.marketProb ? c : a,
    );

    lines.push(
      `\n${b(s.event.city)} — ${s.event.targetDate}  _(lead ${f.leadDays}d · ${f.members} members)_`,
    );
    lines.push(
      `μ ${f.mean.toFixed(1)}${u} · p50 ${f.p50.toFixed(0)}${u} · p10–p90 ${f.p10.toFixed(0)}–${f.p90.toFixed(0)}${u}`,
    );
    if (f.det != null) {
      lines.push(
        `det ${f.det.toFixed(1)}${u} · ens ${f.ensembleMean.toFixed(1)}${u} · σ ${f.sigma.toFixed(1)}${u}`,
      );
    }
    lines.push(
      `Model top: ${top.bucket.label} ${pct(top.modelProb)}  |  Market top: ${mktTop.bucket.label} ${pct(mktTop.marketProb)}`,
    );
    if (s.best && s.best.buyPrice != null) {
      lines.push(
        `✅ Edge: ${b(s.best.bucket.label)} — model ${pct(s.best.modelProb)} vs ask ${pct(s.best.buyPrice)} = ${b("+" + pct(s.best.edge))} (Kelly ${pct(s.best.kellyFraction)})`,
      );
    } else {
      lines.push(`— no bucket above the edge threshold`);
    }
  }

  if (signals.length > maxEvents) {
    lines.push(`\n_…and ${signals.length - maxEvents} more event(s)._`);
  }

  if (trades.length > 0) {
    lines.push(`\n${b("Recent weather trades:")}`);
    for (const t of trades) {
      const icon =
        t.status === "PLACED"
          ? "✅"
          : t.status === "DRY_RUN"
            ? "🔵"
            : t.status === "SKIPPED"
              ? "⏭️"
              : "❌";
      const when = new Date(t.ts).toISOString().slice(5, 16).replace("T", " ");
      lines.push(
        `${icon} ${when} ${t.city} ${t.targetDate} ${t.bucketLabel} ` +
          `$${t.sizeUsdc.toFixed(2)} @ ${t.price} (+${pct(t.edge)})`,
      );
    }
  }

  return lines.join("\n");
}
