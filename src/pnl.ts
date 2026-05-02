import axios from "axios";

const CLOB_API = "https://clob.polymarket.com";

export interface Position {
  tokenId: string;
  question: string;
  outcome: string;
  side: "BUY" | "SELL";
  totalSizeUsdc: number; // net invested (BUY adds, SELL reduces)
  totalShares: number; // net shares held
  avgPrice: number;
  realizedPnl: number; // P&L locked-in by SELLs
  currentPrice?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  trades: number;
  sourceWallets: string[];
}

// One daily record per wallet per day
export interface DailyRecord {
  date: string; // "2026-04-14"
  wallet: string;
  walletLabel?: string;
  invested: number;
  pnl: number;
  trades: number;
}

export class PnLTracker {
  private positions: Map<string, Position> = new Map();
  // key = "YYYY-MM-DD::wallet"
  private dailyRecords: Map<string, DailyRecord> = new Map();
  // Short-lived cache so pagination / rapid refreshes don't re-fetch every
  // single position price serially. The first call within the TTL window
  // does the real network work; subsequent calls reuse the result.
  private lastRefreshAt = 0;
  private inFlightRefresh: Promise<void> | null = null;
  // Cache prices for a few minutes — pagination and casual re-opens reuse
  // them instantly. Users can force a fresh fetch via the 🔄 Refresh button.
  private static readonly REFRESH_TTL_MS = 3 * 60_000;
  // Net signed cashflow from simulated trades (BUY = -copySize, SELL = +copySize).
  // Combined with a configurable starting balance this gives a "wallet balance"
  // view in dry-run mode. Live trading reads on-chain USDC balance instead.
  private dryRunCashFlow = 0;

  recordTrade(
    tokenId: string,
    question: string,
    outcome: string,
    side: "BUY" | "SELL",
    sizeUsdc: number,
    price: number,
    sourceWallet?: string,
    walletLabel?: string,
  ) {
    const shares = price > 0 ? sizeUsdc / price : 0;

    // Track simulated cash flow for dry-run "balance" view.
    // BUY drains cash; SELL refunds proceeds. Real-trade balances come
    // from on-chain USDC instead of this counter.
    this.dryRunCashFlow += side === "BUY" ? -sizeUsdc : sizeUsdc;

    // ── position tracker ──────────────────────────────────────────────────────
    const existing = this.positions.get(tokenId);
    if (!existing) {
      // First trade for this token. A SELL with no prior position is treated
      // as a short entry (rare for copy-trading, but stay consistent).
      this.positions.set(tokenId, {
        tokenId,
        question,
        outcome,
        side,
        totalSizeUsdc: sizeUsdc,
        totalShares: side === "BUY" ? shares : -shares,
        avgPrice: price,
        realizedPnl: 0,
        trades: 1,
        sourceWallets: sourceWallet ? [sourceWallet] : [],
      });
    } else if (side === "BUY") {
      // Add to position — recompute weighted avg only over the long side
      const newShares = existing.totalShares + shares;
      if (existing.totalShares > 0 && newShares > 0) {
        existing.avgPrice =
          (existing.avgPrice * existing.totalShares + price * shares) /
          newShares;
      } else if (existing.totalShares <= 0 && newShares > 0) {
        // Flipped from short/flat to long — reset avg to current price
        existing.avgPrice = price;
      }
      existing.totalSizeUsdc += sizeUsdc;
      existing.totalShares = newShares;
      existing.trades++;
      if (sourceWallet && !existing.sourceWallets.includes(sourceWallet)) {
        existing.sourceWallets.push(sourceWallet);
      }
    } else {
      // SELL — realize P&L on the closed portion, reduce share count
      const closing = Math.min(shares, Math.max(existing.totalShares, 0));
      if (closing > 0) {
        existing.realizedPnl += (price - existing.avgPrice) * closing;
        // Reduce invested proportionally (cost basis of sold shares)
        existing.totalSizeUsdc = Math.max(
          0,
          existing.totalSizeUsdc - existing.avgPrice * closing,
        );
      }
      existing.totalShares -= shares;
      existing.trades++;
      if (sourceWallet && !existing.sourceWallets.includes(sourceWallet)) {
        existing.sourceWallets.push(sourceWallet);
      }
    }

    // ── daily tracker per wallet ──────────────────────────────────────────────
    if (sourceWallet) {
      const today = new Date().toISOString().slice(0, 10);
      const key = `${today}::${sourceWallet.toLowerCase()}`;
      const rec = this.dailyRecords.get(key);
      if (!rec) {
        this.dailyRecords.set(key, {
          date: today,
          wallet: sourceWallet,
          walletLabel: walletLabel,
          invested: sizeUsdc,
          pnl: 0, // updated after price refresh
          trades: 1,
        });
      } else {
        rec.invested += sizeUsdc;
        rec.trades++;
        if (walletLabel) rec.walletLabel = walletLabel;
      }
    }
  }

  async refreshPrices(force = false): Promise<void> {
    // Serve from cache if still warm — keeps pagination instant.
    if (
      !force &&
      this.lastRefreshAt &&
      Date.now() - this.lastRefreshAt < PnLTracker.REFRESH_TTL_MS
    ) {
      return;
    }
    // Coalesce concurrent callers onto the same in-flight request.
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = this.doRefresh().finally(() => {
      this.lastRefreshAt = Date.now();
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async doRefresh(): Promise<void> {
    // Fetch all position prices in parallel — previously this was a serial
    // loop of 5s-timeout HTTP calls, so 6 positions could take ~30s worst
    // case and made the P&L button / pagination feel frozen.
    const positions = Array.from(this.positions.values());
    await Promise.allSettled(
      positions.map(async (pos) => {
        try {
          const res = await axios.get(`${CLOB_API}/price`, {
            params: { token_id: pos.tokenId, side: "BUY" },
            timeout: 3000,
          });
          const currentPrice = parseFloat(res.data?.price ?? "0");
          if (currentPrice > 0) {
            pos.currentPrice = currentPrice;
            // Unrealized P&L only on remaining long shares
            const openShares = Math.max(pos.totalShares, 0);
            pos.unrealizedPnl =
              (currentPrice - pos.avgPrice) * openShares + pos.realizedPnl;
            pos.unrealizedPnlPct =
              pos.totalSizeUsdc > 0
                ? (pos.unrealizedPnl / pos.totalSizeUsdc) * 100
                : 0;
          }
        } catch {
          /* skip */
        }
      }),
    );

    // Re-aggregate daily PnL per wallet from positions
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, rec] of this.dailyRecords) {
      if (!key.startsWith(today)) continue; // only update today's records
      const walletKey = rec.wallet.toLowerCase();
      let walletPnl = 0;
      for (const pos of this.positions.values()) {
        if (pos.sourceWallets.map((w) => w.toLowerCase()).includes(walletKey)) {
          walletPnl += pos.unrealizedPnl ?? 0;
        }
      }
      rec.pnl = walletPnl;
    }
  }

  // Returns daily records for today (or all days if allDays=true)
  getDailyByWallet(allDays = false): DailyRecord[] {
    const today = new Date().toISOString().slice(0, 10);
    return Array.from(this.dailyRecords.values())
      .filter((r) => allDays || r.date === today)
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.wallet.localeCompare(b.wallet),
      );
  }

  printSummary() {
    if (this.positions.size === 0) {
      console.log("\n[P&L] No positions yet.");
      return;
    }
    console.log("\n" + "═".repeat(72));
    console.log("  📊  P&L SUMMARY");
    console.log("═".repeat(72));
    let totalInvested = 0,
      totalPnl = 0;
    for (const pos of this.positions.values()) {
      const pnl = pos.unrealizedPnl ?? 0;
      const pnlPct = pos.unrealizedPnlPct ?? 0;
      const arrow = pnl >= 0 ? "▲" : "▼";
      const q = (pos.question || pos.tokenId).slice(0, 44);
      const wallets = pos.sourceWallets
        .map((w) => w.slice(0, 10) + "…")
        .join(", ");
      console.log(`\n  Market  : ${q}`);
      console.log(
        `  Source  : ${wallets || "—"} | ${pos.outcome || "?"} | ${pos.side}`,
      );
      console.log(
        `  Entry   : avg $${pos.avgPrice.toFixed(4)} × ${pos.totalShares.toFixed(2)} shares`,
      );
      console.log(
        `  Now     : $${(pos.currentPrice ?? 0).toFixed(4)} | Invested: $${pos.totalSizeUsdc.toFixed(2)}`,
      );
      console.log(
        `  P&L     : ${arrow} ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(4)} (${pnl >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%) [${pos.trades} trade(s)]`,
      );
      totalInvested += pos.totalSizeUsdc;
      totalPnl += pnl;
    }
    const pct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
    console.log("\n" + "─".repeat(72));
    console.log(
      `  TOTAL   : $${totalInvested.toFixed(2)} | ${totalPnl >= 0 ? "▲ +" : "▼ -"}$${Math.abs(totalPnl).toFixed(4)} (${totalPnl >= 0 ? "+" : ""}${pct.toFixed(1)}%)`,
    );
    console.log("═".repeat(72) + "\n");
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
  getTotalPnl(): number {
    return this.getPositions().reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
  }

  // Clear all per-day per-wallet records. Positions and dryRunCashFlow are
  // intentionally preserved so a "history reset" doesn't wipe live exposure.
  clearDailyRecords(): number {
    const n = this.dailyRecords.size;
    this.dailyRecords.clear();
    return n;
  }

  // Full wipe — positions, daily records, simulated cashflow. Used by /reset
  // so equity/total counters start from zero again (in dry-run, equity falls
  // back to startCash; in live mode the on-chain balance is unaffected, but
  // the bot's internal P&L/positions view is cleared).
  resetAll(): {
    clearedPositions: number;
    clearedDaily: number;
    clearedCashFlow: number;
  } {
    const clearedPositions = this.positions.size;
    const clearedDaily = this.dailyRecords.size;
    const clearedCashFlow = this.dryRunCashFlow;
    this.positions.clear();
    this.dailyRecords.clear();
    this.dryRunCashFlow = 0;
    this.lastRefreshAt = 0;
    return { clearedPositions, clearedDaily, clearedCashFlow };
  }

  // ── Dry-run virtual balance ─────────────────────────────────────────────────
  // cash       = startCash + net cashflow (BUY -, SELL +)
  // holdings   = current market value of still-open long shares
  // equity     = cash + holdings (what your wallet would be worth right now)
  getDryRunBalance(startCash: number): {
    startCash: number;
    cash: number;
    holdingsValue: number;
    equity: number;
    pnl: number;
    pnlPct: number;
  } {
    const cash = startCash + this.dryRunCashFlow;
    let holdingsValue = 0;
    for (const pos of this.positions.values()) {
      const openShares = Math.max(pos.totalShares, 0);
      if (openShares > 0 && pos.currentPrice && pos.currentPrice > 0) {
        holdingsValue += openShares * pos.currentPrice;
      }
    }
    const equity = cash + holdingsValue;
    const pnl = equity - startCash;
    const pnlPct = startCash > 0 ? (pnl / startCash) * 100 : 0;
    return { startCash, cash, holdingsValue, equity, pnl, pnlPct };
  }
}
