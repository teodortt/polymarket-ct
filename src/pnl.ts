import axios from "axios";

const CLOB_API = "https://clob.polymarket.com";

export interface Position {
  tokenId: string;
  question: string;
  outcome: string;
  side: "BUY" | "SELL";
  totalSizeUsdc: number;
  totalShares: number;
  avgPrice: number;
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

    // ── position tracker ──────────────────────────────────────────────────────
    const existing = this.positions.get(tokenId);
    if (!existing) {
      this.positions.set(tokenId, {
        tokenId,
        question,
        outcome,
        side,
        totalSizeUsdc: sizeUsdc,
        totalShares: shares,
        avgPrice: price,
        trades: 1,
        sourceWallets: sourceWallet ? [sourceWallet] : [],
      });
    } else {
      const newShares = existing.totalShares + shares;
      existing.avgPrice =
        newShares > 0
          ? (existing.avgPrice * existing.totalShares + price * shares) /
            newShares
          : price;
      existing.totalSizeUsdc += sizeUsdc;
      existing.totalShares = newShares;
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

  async refreshPrices(): Promise<void> {
    // Refresh unrealized PnL per position
    for (const pos of this.positions.values()) {
      try {
        const res = await axios.get(`${CLOB_API}/price`, {
          params: { token_id: pos.tokenId, side: "BUY" },
          timeout: 5000,
        });
        const currentPrice = parseFloat(res.data?.price ?? "0");
        if (currentPrice > 0) {
          pos.currentPrice = currentPrice;
          pos.unrealizedPnl =
            pos.side === "BUY"
              ? (currentPrice - pos.avgPrice) * pos.totalShares
              : (pos.avgPrice - currentPrice) * pos.totalShares;
          pos.unrealizedPnlPct =
            pos.totalSizeUsdc > 0
              ? (pos.unrealizedPnl / pos.totalSizeUsdc) * 100
              : 0;
        }
      } catch {
        /* skip */
      }
    }

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
}
