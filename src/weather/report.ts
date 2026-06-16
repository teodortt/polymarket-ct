import { WeatherSignal, WeatherTradeRecord } from "../types";
import type { DailyRecord } from "../pnl";

interface ReportOpts {
  markdown: boolean;
  lastScanAt?: number;
  enabled?: boolean;
  maxEvents?: number;
  pnl?: any;
  orders?: any[];
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

  // Add P&L summary section if available
  if (opts.pnl) {
    const positions = opts.pnl.getPositions();

    if (positions.length > 0) {
      let totalPnl = 0;
      let totalInvested = 0;
      let openPositions = 0;

      for (const pos of positions) {
        totalPnl += pos.totalPnl ?? pos.unrealizedPnl ?? pos.realizedPnl;
        totalInvested += pos.totalSizeUsdc;
        if (pos.totalShares > 0) openPositions++;
      }

      const pnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
      const arrow = totalPnl >= 0 ? "▲" : "▼";
      const emoji = totalPnl >= 0 ? "📈" : "📉";

      lines.push(
        `\n${b("Overall P&L:")} ${emoji} ${arrow} ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} ` +
          `(${totalPnl >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n` +
          `Invested: $${totalInvested.toFixed(2)} | Positions: ${openPositions}/${positions.length} open`,
      );

      // Daily P&L grouped by date across all wallets.
      const dailyRecords = opts.pnl.getDailyByWallet(true);
      if (dailyRecords && dailyRecords.length > 0) {
        const byDate = new Map<string, DailyRecord[]>();
        for (const record of dailyRecords) {
          const current = byDate.get(record.date);
          if (current) current.push(record);
          else byDate.set(record.date, [record]);
        }

        lines.push(`\n${b("Daily P&L:")}`);
        for (const [date, records] of Array.from(byDate.entries()).sort(
          (a, b) => a[0].localeCompare(b[0]),
        )) {
          const dayPnl = records.reduce(
            (sum: number, r: DailyRecord) => sum + r.pnl,
            0,
          );
          const dayInvested = records.reduce(
            (sum: number, r: DailyRecord) => sum + r.invested,
            0,
          );
          const dayTrades = records.reduce(
            (sum: number, r: DailyRecord) => sum + r.trades,
            0,
          );
          const dayPct = dayInvested > 0 ? (dayPnl / dayInvested) * 100 : 0;
          const dayArrow = dayPnl >= 0 ? "▲" : "▼";

          lines.push(
            `  ${date} ${dayArrow} ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)} ` +
              `(${dayPnl >= 0 ? "+" : ""}${dayPct.toFixed(1)}%) | ` +
              `Invested $${dayInvested.toFixed(2)} | Trades ${dayTrades}`,
          );
        }
      }
    }
  }

  // Add open orders section if available
  if (opts.orders && opts.orders.length > 0) {
    lines.push(`\n${b("Open orders:")} ${opts.orders.length}`);

    for (const order of opts.orders) {
      const side = order.side?.toUpperCase() === "BUY" ? "🟢 BUY" : "🔴 SELL";
      const price = parseFloat(order.price ?? 0).toFixed(4);
      const remaining = parseFloat(
        order.size_remaining ?? order.original_size ?? 0,
      ).toFixed(2);

      const market = order.market || order.question || order.outcome || "order";
      const id = order.id ? ` | ${String(order.id).slice(0, 12)}…` : "";

      lines.push(`  ${side} ${market} | $${remaining} @ ${price}${id}`);
    }
  }

  if (opts.enabled === false) {
    lines.push(
      "\n⏸ *Weather module is OFF*\n" +
        "Enable it with `/weather on` or set `WEATHER_ENABLED=true` in env.\n" +
        "The engine will start scanning every 20 minutes once enabled.",
    );
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
        const when = new Date(t.ts)
          .toISOString()
          .slice(5, 16)
          .replace("T", " ");
        lines.push(
          `${icon} ${when} ${t.city} ${t.targetDate} ${t.bucketLabel} ` +
            `$${t.sizeUsdc.toFixed(2)} @ ${t.price}`,
        );
      }
    }
    return lines.join("\n");
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
