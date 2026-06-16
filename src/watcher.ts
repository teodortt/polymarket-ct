import { getTradesForWallet, getMarketInfo } from "./polymarketApi";
import { copyTradeWithSize, getOpenOrders, cancelOrdersByIds } from "./trader";
import { config } from "./config";
import { Trade, CopiedTrade } from "./types";
import { PnLTracker } from "./pnl";
import { TelegramBot } from "./telegram";
import { WalletConfigStore } from "./walletConfig";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");
// Hard cap on persisted history to avoid unbounded growth
const HISTORY_MAX = 2000;

class WalletWatcher {
  readonly wallet: string;
  lastTs: number;
  seen: Set<string> = new Set();
  fetched = 0; // total trades returned by API across polls
  newCount = 0; // total NEW trades (post-seed) detected
  lastPollAt = 0;
  seeded = false;

  constructor(wallet: string) {
    this.wallet = wallet;
    // Will be properly set by seed(); placeholder until then.
    this.lastTs = Math.floor(Date.now() / 1000) - 60;
  }

  async seed() {
    const trades = await getTradesForWallet(this.wallet);
    for (const t of trades) {
      this.seen.add(t.id);
      if (t.timestamp > this.lastTs) this.lastTs = t.timestamp;
    }
    this.seeded = true;
    console.log(
      `[Watcher] ${this.wallet.slice(0, 10)}… seeded ${this.seen.size} trades.`,
    );
  }

  async fetchNew(): Promise<Trade[]> {
    this.lastPollAt = Date.now();
    const trades = await getTradesForWallet(this.wallet, this.lastTs);
    this.fetched += trades.length;
    const newTrades = trades.filter((t) => !this.seen.has(t.id));
    newTrades.sort((a, b) => a.timestamp - b.timestamp);
    for (const t of newTrades) {
      this.seen.add(t.id);
      if (t.timestamp > this.lastTs) this.lastTs = t.timestamp;
    }
    this.newCount += newTrades.length;
    return newTrades;
  }
}

export class CopyTrader {
  private watchers: Map<string, WalletWatcher> = new Map();
  public cfgStore: WalletConfigStore; // public — referenced by TelegramBot
  private running = false;
  private history: CopiedTrade[] = [];
  private pnl: PnLTracker = new PnLTracker();
  private pnlCounter = 0;
  private tg: TelegramBot;

  constructor(targetWallets: string[], tg: TelegramBot) {
    this.tg = tg;
    this.cfgStore = new WalletConfigStore();

    // 1. Add env-provided wallets (no-op if already persisted)
    for (const w of targetWallets) this.cfgStore.add(w);

    // 2. Set up a watcher for every persisted wallet (env + previously saved)
    for (const cfg of this.cfgStore.getAll()) {
      this.watchers.set(
        cfg.wallet.toLowerCase(),
        new WalletWatcher(cfg.wallet),
      );
    }

    // 3. Restore history from disk
    this.loadHistory();

    // Register callbacks IMMEDIATELY — before bot.launch() is even called
    tg.register({
      addWallet: (w, label) => this.addWallet(w, label),
      removeWallet: (w) => this.removeWallet(w),
      walletExposure: (w) => this.walletExposure(w),
      cancelOrdersForWallet: (w) => this.cancelOrdersForWallet(w),
      forceCopyLast: (w) => this.forceCopyLast(w),
      getHistory: () => this.history,
      getPnL: () => this.pnl,
      setDryRun: (v) => {
        config.dryRun = v;
      },
      walletCfgs: this.cfgStore, // pass reference directly — always defined
      getOrders: () => getOpenOrders(),
      getDebug: () => this.getDebug(),
      clearHistory: () => this.clearHistory(),
    });
  }

  private loadHistory() {
    try {
      if (!fs.existsSync(HISTORY_PATH)) return;
      const arr = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
      if (Array.isArray(arr)) {
        this.history = arr;
        // Replay DRY_RUN trades into PnL so /pnl survives restart
        for (const h of arr) {
          if (h.status === "DRY_RUN" && h.originalTrade) {
            const t = h.originalTrade;
            this.pnl.recordTrade(
              t.tokenId,
              t.market,
              t.outcome,
              t.side,
              h.copySize ?? t.size,
              t.price,
              h.sourceWallet,
              this.cfgStore.get(h.sourceWallet ?? "")?.label,
            );
          }
        }
        console.log(
          `[Watcher] Restored ${arr.length} historical trade(s) from disk.`,
        );
      }
    } catch (err: any) {
      console.error("[Watcher] Failed to load history:", err.message);
    }
  }

  private saveHistory() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      // Trim to most recent N to bound file size
      const slice = this.history.slice(-HISTORY_MAX);
      fs.writeFileSync(HISTORY_PATH, JSON.stringify(slice, null, 2));
    } catch (err: any) {
      console.error("[Watcher] Failed to save history:", err.message);
    }
  }

  /**
   * Clears the in-memory copy history, per-day P&L records, tracked positions
   * and the dry-run cashflow counter, then persists the empty history to disk.
   * Followed wallets and wallet configs are intentionally preserved.
   *
   * After this runs, /pnl, /daily, equity and total counters all start from
   * zero again — both in dry-run (equity returns to the configured start
   * balance) and in live mode (on-chain USDC is untouched, but the bot's
   * internal positions view is cleared).
   */
  clearHistory(): {
    clearedHistory: number;
    clearedDaily: number;
    clearedPositions: number;
  } {
    const clearedHistory = this.history.length;
    this.history = [];
    this.saveHistory();
    const reset = this.pnl.resetAll();
    console.log(
      `[Watcher] 🧹 Reset: cleared ${clearedHistory} history entries, ` +
        `${reset.clearedDaily} daily records, ${reset.clearedPositions} positions ` +
        `(cashflow $${reset.clearedCashFlow.toFixed(2)} → 0).`,
    );
    return {
      clearedHistory,
      clearedDaily: reset.clearedDaily,
      clearedPositions: reset.clearedPositions,
    };
  }

  getDebug() {
    return {
      running: this.running,
      dryRun: config.dryRun,
      orderType: config.orderType,
      minTradeUsdc: config.minTradeUsdc,
      pollIntervalMs: config.pollIntervalMs,
      historySize: this.history.length,
      watchers: [...this.watchers.values()].map((w) => ({
        wallet: w.wallet,
        seeded: w.seeded,
        seenCount: w.seen.size,
        lastTs: w.lastTs,
        lastTsAgoSec:
          w.lastTs > 0 ? Math.floor(Date.now() / 1000 - w.lastTs) : -1,
        lastPollAgoSec:
          w.lastPollAt > 0
            ? Math.floor((Date.now() - w.lastPollAt) / 1000)
            : -1,
        fetched: w.fetched,
        newDetected: w.newCount,
      })),
    };
  }

  async addWallet(
    wallet: string,
    label?: string,
  ): Promise<{ ok: boolean; msg: string }> {
    const key = wallet.toLowerCase();
    if (this.watchers.has(key))
      return { ok: false, msg: `Wallet already followed: \`${wallet}\`` };
    const watcher = new WalletWatcher(wallet);
    await watcher.seed();
    this.watchers.set(key, watcher);
    this.cfgStore.add(wallet, { label });
    console.log(`[Watcher] ➕ ${wallet}`);
    return {
      ok: true,
      msg: `Added: \`${wallet}\`${label ? ` (${label})` : ""}`,
    };
  }

  removeWallet(wallet: string): { ok: boolean; msg: string } {
    const key = wallet.toLowerCase();
    if (!this.watchers.has(key))
      return { ok: false, msg: `Not found: \`${wallet}\`` };
    this.watchers.delete(key);
    this.cfgStore.remove(wallet);
    console.log(`[Watcher] ➖ ${wallet}`);
    return { ok: true, msg: `Removed: \`${wallet}\`` };
  }

  /**
   * Summary of what was copied from this wallet so far (for the
   * "remove wallet" confirmation UI in Telegram).
   */
  walletExposure(wallet: string): {
    placedOrderIds: string[];
    copiedTrades: number;
  } {
    const key = wallet.toLowerCase();
    const mine = this.history.filter(
      (h) => h.sourceWallet?.toLowerCase() === key,
    );
    const placedOrderIds = mine
      .filter((h) => h.status === "PLACED" && h.orderId)
      .map((h) => h.orderId as string);
    return { placedOrderIds, copiedTrades: mine.length };
  }

  /**
   * Cancels open orders that the bot placed in response to trades from this
   * wallet. Only the orders still listed by the CLOB as open are cancelled.
   */
  async cancelOrdersForWallet(
    wallet: string,
  ): Promise<{ ok: boolean; cancelled: number; reason?: string }> {
    const { placedOrderIds } = this.walletExposure(wallet);
    if (placedOrderIds.length === 0) return { ok: true, cancelled: 0 };
    if (config.dryRun) return { ok: true, cancelled: 0, reason: "dry_run" };
    // Filter to those still open
    const openOrders = await getOpenOrders();
    const openIds = new Set(openOrders.map((o) => String(o.id)));
    const stillOpen = placedOrderIds.filter((id) => openIds.has(id));
    if (stillOpen.length === 0) return { ok: true, cancelled: 0 };
    return cancelOrdersByIds(stillOpen);
  }

  async start() {
    this.running = true;
    const count = this.watchers.size;
    console.log(
      `\n🚀 Polymarket CopyBot started | wallets: ${count} | dry: ${config.dryRun}\n`,
    );

    if (count > 0) {
      // Only seed watchers that weren't seeded yet (e.g. ones added at runtime
      // via addWallet() were already seeded there).
      const toSeed = [...this.watchers.values()].filter((w) => !w.seeded);
      if (toSeed.length > 0) {
        await Promise.all(toSeed.map((w) => w.seed()));
      }
      console.log("[Watcher] All wallets seeded. Watching...\n");
    } else {
      console.log("[Watcher] No wallets. Add via Telegram /add 0x...\n");
    }

    await this.tg.send(
      `🚀 *CopyBot started*\nWallets: ${count} | Dry: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}\n/menu`,
    );

    while (this.running) {
      await this.poll();
      this.pnlCounter++;
      if (config.dryRun && this.pnlCounter % 6 === 0) {
        await this.pnl.refreshPrices();
        this.pnl.printSummary();
      }
      await sleep(config.pollIntervalMs);
    }
  }

  stop() {
    this.running = false;
  }

  private async poll() {
    if (this.watchers.size === 0) {
      process.stdout.write("·");
      return;
    }

    const results = await Promise.all(
      [...this.watchers.values()].map(async (w) => ({
        wallet: w.wallet,
        trades: await w.fetchNew().catch(() => [] as Trade[]),
      })),
    );

    const allNew = results.flatMap((r) =>
      r.trades.map((t) => ({ ...t, _src: r.wallet })),
    );

    if (allNew.length === 0) {
      process.stdout.write(".");
      return;
    }
    console.log(`\n[Watcher] 🔔 ${allNew.length} new trade(s)`);

    for (const trade of allNew) {
      const src = (trade as any)._src as string;
      const walletCfg = this.cfgStore.get(src);

      if (walletCfg && !walletCfg.enabled) {
        console.log(`[Watcher] ⏸ Skipping paused: ${src.slice(0, 10)}…`);
        continue;
      }

      const copySize = this.cfgStore.calcSize(src, trade.size);
      console.log(
        `[Watcher] [${src.slice(0, 10)}…] ${trade.side} ${trade.size.toFixed(4)} USDC @ ${trade.price} → copy $${copySize.toFixed(2)}`,
      );

      const result = await copyTradeWithSize(trade, copySize);
      result.sourceWallet = src;
      // Stash the actual size we tried to copy (for history replay after restart)
      (result as any).copySize = copySize;
      if (result.status !== "PLACED") {
        console.log(
          `[Watcher] ${result.status} ${src.slice(0, 10)}…: ${result.reason || "no reason"}`,
        );
      }
      this.history.push(result);
      this.saveHistory();

      const marketInfo = await getMarketInfo(trade.tokenId, trade.market);
      const question = marketInfo?.question ?? "";

      await this.tg.notifyNewTrade(
        src,
        walletCfg?.label,
        trade.side,
        copySize,
        trade.price,
        question,
        result.status,
        result.reason,
        result.orderId,
      );

      // Track in PnL when we actually "took" the trade (DRY_RUN simulation
      // or real PLACED order). SKIPPED/FAILED are not held positions.
      const tracked =
        (config.dryRun && result.status === "DRY_RUN") ||
        result.status === "PLACED";
      if (tracked) {
        this.pnl.recordTrade(
          trade.tokenId,
          question,
          trade.outcome,
          trade.side,
          copySize,
          trade.price,
          src,
          walletCfg?.label,
        );
        if (config.dryRun) {
          await this.pnl.refreshPrices();
          this.pnl.printSummary();
        }
      }
    }
  }

  getPnL() {
    return this.pnl;
  }
  getHistory() {
    return this.history;
  }

  /**
   * Returns the most recent N trades from the data-api for a wallet — raw,
   * unfiltered by `seen`. Useful for diagnosing "the bot doesn't see anything".
   */
  async peekTrades(wallet: string, n = 5): Promise<Trade[]> {
    const trades = await getTradesForWallet(wallet);
    return trades.slice(0, n);
  }

  /**
   * Manually trigger a copy of the wallet's most recent trade. Goes through
   * the same `copyTradeWithSize` path as a real poll — respects DRY_RUN,
   * sizing, and notifications. Marks the trade as seen so the next poll
   * doesn't re-copy it.
   */
  async forceCopyLast(wallet: string): Promise<{ ok: boolean; msg: string }> {
    const key = wallet.toLowerCase();
    const watcher = this.watchers.get(key);
    if (!watcher) return { ok: false, msg: `Wallet not watched: ${wallet}` };

    const trades = await getTradesForWallet(wallet);
    if (trades.length === 0)
      return { ok: false, msg: "No trades found from API" };

    // Most recent first (API order)
    const trade = trades[0];
    const cfg = this.cfgStore.get(wallet);
    const copySize = this.cfgStore.calcSize(wallet, trade.size);

    console.log(
      `[ForceCopy] ${wallet.slice(0, 10)}… ${trade.side} ${trade.size} @ ${trade.price} → copy $${copySize.toFixed(2)} (dry=${config.dryRun})`,
    );

    const result = await copyTradeWithSize(trade, copySize);
    result.sourceWallet = wallet;
    (result as any).copySize = copySize;
    this.history.push(result);
    this.saveHistory();
    watcher.seen.add(trade.id);

    const marketInfo = await getMarketInfo(trade.tokenId, trade.market);
    const question = marketInfo?.question ?? "";
    await this.tg.notifyNewTrade(
      wallet,
      cfg?.label,
      trade.side,
      copySize,
      trade.price,
      question,
      result.status,
      result.reason,
      result.orderId,
    );

    return {
      ok: true,
      msg: `${result.status}${result.reason ? " — " + result.reason : ""}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
