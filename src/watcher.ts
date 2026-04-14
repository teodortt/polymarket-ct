import { getTradesForWallet, getMarketInfo } from "./polymarketApi";
import { copyTradeWithSize } from "./trader";
import { config } from "./config";
import { Trade, CopiedTrade } from "./types";
import { PnLTracker } from "./pnl";
import { TelegramBot } from "./telegram";
import { WalletConfigStore } from "./walletConfig";

class WalletWatcher {
  readonly wallet: string;
  private lastTs: number;
  private seen: Set<string> = new Set();

  constructor(wallet: string) {
    this.wallet = wallet;
    this.lastTs = Math.floor(Date.now() / 1000) - 60;
  }

  async seed() {
    const trades = await getTradesForWallet(this.wallet);
    for (const t of trades) {
      this.seen.add(t.id);
      if (t.timestamp > this.lastTs) this.lastTs = t.timestamp;
    }
    console.log(
      `[Watcher] ${this.wallet.slice(0, 10)}… seeded ${this.seen.size} trades.`,
    );
  }

  async fetchNew(): Promise<Trade[]> {
    const trades = await getTradesForWallet(this.wallet, this.lastTs);
    const newTrades = trades.filter((t) => !this.seen.has(t.id));
    newTrades.sort((a, b) => a.timestamp - b.timestamp);
    for (const t of newTrades) {
      this.seen.add(t.id);
      if (t.timestamp > this.lastTs) this.lastTs = t.timestamp;
    }
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

    for (const w of targetWallets) {
      this.cfgStore.add(w);
      this.watchers.set(w.toLowerCase(), new WalletWatcher(w));
    }

    // Register callbacks IMMEDIATELY — before bot.launch() is even called
    tg.register({
      addWallet: (w, label) => this.addWallet(w, label),
      removeWallet: (w) => this.removeWallet(w),
      getHistory: () => this.history,
      getPnL: () => this.pnl,
      setDryRun: (v) => {
        config.dryRun = v;
      },
      walletCfgs: this.cfgStore, // pass reference directly — always defined
    });
  }

  async addWallet(
    wallet: string,
    label?: string,
  ): Promise<{ ok: boolean; msg: string }> {
    const key = wallet.toLowerCase();
    if (this.watchers.has(key))
      return { ok: false, msg: `Wallet вече се следва: \`${wallet}\`` };
    const watcher = new WalletWatcher(wallet);
    await watcher.seed();
    this.watchers.set(key, watcher);
    this.cfgStore.add(wallet, { label });
    console.log(`[Watcher] ➕ ${wallet}`);
    return {
      ok: true,
      msg: `Добавен: \`${wallet}\`${label ? ` (${label})` : ""}`,
    };
  }

  removeWallet(wallet: string): { ok: boolean; msg: string } {
    const key = wallet.toLowerCase();
    if (!this.watchers.has(key))
      return { ok: false, msg: `Не е намерен: \`${wallet}\`` };
    this.watchers.delete(key);
    this.cfgStore.remove(wallet);
    console.log(`[Watcher] ➖ ${wallet}`);
    return { ok: true, msg: `Премахнат: \`${wallet}\`` };
  }

  async start() {
    this.running = true;
    const count = this.watchers.size;
    console.log(
      `\n🚀 Polymarket CopyBot started | wallets: ${count} | dry: ${config.dryRun}\n`,
    );

    if (count > 0) {
      await Promise.all([...this.watchers.values()].map((w) => w.seed()));
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
      this.history.push(result);

      const marketInfo = await getMarketInfo(trade.tokenId);
      const question = marketInfo?.question ?? "";

      await this.tg.notifyNewTrade(
        src,
        walletCfg?.label,
        trade.side,
        copySize,
        trade.price,
        question,
        result.status,
        result.orderId,
      );

      if (config.dryRun && result.status === "DRY_RUN") {
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
        await this.pnl.refreshPrices();
        this.pnl.printSummary();
      }
    }
  }

  getPnL() {
    return this.pnl;
  }
  getHistory() {
    return this.history;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
