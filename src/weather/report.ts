import { WeatherSignal, WeatherTradeRecord } from "../types";

interface ReportOpts {
  markdown: boolean;
  lastScanAt?: number;
  enabled?: boolean;
  maxEvents?: number;
  allWeatherTrades?: any[];
  weatherPnL?: {
    totalPnl: number;
    totalInvested: number;
    byTargetDate: Record<string, any>;
  };
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

  // Weather-specific stats with P&L (independent from bot's copy-trading P&L)
  if (opts.allWeatherTrades && opts.allWeatherTrades.length > 0) {
    const placed = opts.allWeatherTrades.filter(
      (t: any) => t.status === "PLACED" || t.status === "DRY_RUN",
    );
    const totalInvested = placed.reduce(
      (sum: number, t: any) => sum + t.sizeUsdc,
      0,
    );
    const placedCount = placed.length;
    const skipped = opts.allWeatherTrades.filter(
      (t: any) => t.status === "SKIPPED",
    ).length;
    const failed = opts.allWeatherTrades.filter(
      (t: any) => t.status === "FAILED",
    ).length;

    // Overall PNL section
    let pnlLine = "";
    if (opts.weatherPnL && placedCount > 0) {
      const { totalPnl } = opts.weatherPnL;
      const returnPct =
        totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
      const arrow = totalPnl >= 0 ? "▲" : "▼";
      const emoji = totalPnl >= 0 ? "📈" : "📉";
      pnlLine =
        `\n${emoji} ${b("P&L:")} ${arrow} ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} ` +
        `(${totalPnl >= 0 ? "+" : ""}${returnPct.toFixed(1)}%)`;
    }

    lines.push(
      `\n${b("Weather trades summary:")}` +
        ` | Placed: ${placedCount} | Skipped: ${skipped} | Failed: ${failed}` +
        ` | Invested: $${totalInvested.toFixed(2)}${pnlLine}`,
    );

    // Placement activity is grouped by trade date and should stay static.
    const byDate = new Map<string, any[]>();
    for (const trade of opts.allWeatherTrades) {
      const date = new Date(trade.ts).toISOString().slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(trade);
    }

    if (byDate.size > 0) {
      lines.push(`\n${b("Daily weather activity:")}`);
      for (const [date, trades] of Array.from(byDate.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        const dayPlaced = trades.filter(
          (t) => t.status === "PLACED" || t.status === "DRY_RUN",
        );
        const dayInvested = dayPlaced.reduce((sum, t) => sum + t.sizeUsdc, 0);
        const daySkipped = trades.filter((t) => t.status === "SKIPPED").length;
        const dayFailed = trades.filter((t) => t.status === "FAILED").length;

        lines.push(
          `  ${date}: ${dayPlaced.length} placed | $${dayInvested.toFixed(2)} invested | ` +
            `${daySkipped} skipped | ${dayFailed} failed`,
        );
      }
    }

    const targetDateRows = Object.entries(opts.weatherPnL?.byTargetDate ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([, dayData]) => dayData?.pricedTrades > 0);

    if (targetDateRows.length > 0) {
      lines.push(`\n${b("Weather mark-to-market by target date:")}`);
      for (const [date, dayData] of targetDateRows) {
        const dayPnl = dayData.pnl;
        const dayReturnPct =
          dayData.invested > 0 ? (dayPnl / dayData.invested) * 100 : 0;
        const dayArrow = dayPnl >= 0 ? "▲" : "▼";
        lines.push(
          `  ${date}: ${dayArrow} ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)} ` +
            `(${dayPnl >= 0 ? "+" : ""}${dayReturnPct.toFixed(1)}%) | ` +
            `$${dayData.invested.toFixed(2)} invested | ${dayData.pricedTrades}/${dayData.totalTrades} priced`,
        );
      }
    }

    lines.push(
      `\n_Stats persist across bot restarts in \`data/weather.json\`._`,
    );
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
      const reason =
        s.bestRejectionReason ?? "no bucket above the edge threshold";
      lines.push(`— no trade: ${reason}`);
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
