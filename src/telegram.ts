import { Telegraf, Context, Markup } from "telegraf";
import type { Message } from "telegraf/types";
import { config } from "./config";
import { PnLTracker } from "./pnl";
import { CopiedTrade, WalletConfig } from "./types";
import { WalletConfigStore } from "./walletConfig";

type AddWalletFn = (
  wallet: string,
  label?: string,
) => Promise<{ ok: boolean; msg: string }>;
type RemoveWalletFn = (wallet: string) => { ok: boolean; msg: string };
type GetHistoryFn = () => CopiedTrade[];
type GetPnLFn = () => PnLTracker;
type SetDryRunFn = (val: boolean) => void;
type GetOrdersFn = () => Promise<any[]>;

type Step = {
  type: "set_wallet_field";
  wallet: string;
  field: "multiplier" | "maxusdc" | "copyusdc" | "percent" | "label";
};

export class TelegramBot {
  private bot: Telegraf;
  private allowedChatId: string;
  private steps: Map<number, Step> = new Map();

  private addWallet!: AddWalletFn;
  private removeWallet!: RemoveWalletFn;
  private getHistory!: GetHistoryFn;
  private getPnL!: GetPnLFn;
  private setDryRun!: SetDryRunFn;
  private getOrders!: GetOrdersFn;
  private walletCfgs!: WalletConfigStore;

  constructor() {
    this.bot = new Telegraf(config.telegramBotToken);
    this.allowedChatId = config.telegramChatId;
    this.setupCommands();
  }

  register(callbacks: {
    addWallet: AddWalletFn;
    removeWallet: RemoveWalletFn;
    getHistory: GetHistoryFn;
    getPnL: GetPnLFn;
    setDryRun: SetDryRunFn;
    getOrders: GetOrdersFn;
    walletCfgs: WalletConfigStore;
  }) {
    Object.assign(this, callbacks);
  }

  private allowed(ctx: Context): boolean {
    const id = String(ctx.chat?.id ?? "");
    if (id !== this.allowedChatId) {
      ctx.reply("⛔ Unauthorized").catch(() => {});
      return false;
    }
    return true;
  }

  private uid(ctx: Context): number {
    return ctx.from?.id ?? 0;
  }

  // Helper — reply to any context type safely
  private async replyTo(ctx: Context, text: string, extra?: object) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await this.bot.telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...(extra ?? {}),
    } as any);
  }

  // Helper — edit message if in callback context, else send new
  private async editOrReply(ctx: Context, text: string, extra?: object) {
    const fullExtra = { parse_mode: "Markdown" as const, ...(extra ?? {}) };
    if (
      "editMessageText" in ctx &&
      typeof (ctx as any).editMessageText === "function"
    ) {
      try {
        await (ctx as any).editMessageText(text, fullExtra);
        return;
      } catch {
        /* fall through */
      }
    }
    await this.replyTo(ctx, text, fullExtra);
  }

  private refreshBtn(action: string) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Refresh", action)],
    ]);
  }

  private setupCommands() {
    const b = this.bot;

    // /start & /menu
    b.command(["start", "menu"], (ctx) => {
      if (!this.allowed(ctx)) return;
      this.steps.delete(this.uid(ctx));
      ctx.reply("🤖 *Polymarket CopyBot*\n\nИзбери действие:", {
        parse_mode: "Markdown",
        ...Markup.keyboard([
          ["📋 Wallets", "➕ Add wallet", "➖ Remove wallet"],
          ["📊 P&L", "📜 History", "⚙️ Settings"],
          ["ℹ️ Status", "❓ Help"],
        ]).resize(),
      });
    });

    // Wallets list
    b.command("wallets", (ctx) => this.handleWallets(ctx));
    b.hears("📋 Wallets", (ctx) => this.handleWallets(ctx));

    // Add wallet
    b.command("add", (ctx) => {
      const parts = ctx.message.text.split(" ");
      const wallet = parts[1];
      const label = parts.slice(2).join(" ") || undefined;
      this.handleAdd(ctx, wallet, label);
    });
    b.hears("➕ Add wallet", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.reply("Изпрати:\n`/add 0xWALLET` или\n`/add 0xWALLET Whale #1`", {
        parse_mode: "Markdown",
      });
    });

    // Remove wallet
    b.command("remove", (ctx) => {
      this.handleRemove(ctx, ctx.message.text.split(" ")[1]);
    });
    b.hears("➖ Remove wallet", (ctx) => {
      if (!this.allowed(ctx)) return;
      const cfgs = this.walletCfgs.getAll();
      if (cfgs.length === 0) return ctx.reply("Няма wallets за премахване.");
      const buttons = cfgs.map((c) =>
        Markup.button.callback(
          `${c.label ? c.label + " " : ""}${c.wallet.slice(0, 10)}…`,
          `remove:${c.wallet}`,
        ),
      );
      ctx.reply(
        "Избери wallet за премахване:",
        Markup.inlineKeyboard(buttons, { columns: 1 }),
      );
    });

    // /wset 0xWALLET field value
    b.command("wset", (ctx) => {
      const parts = ctx.message.text.split(" ");
      this.handleWalletSet(
        ctx,
        parts[1],
        parts[2] as "multiplier" | "maxusdc" | "copyusdc" | "percent" | "label",
        parts.slice(3).join(" "),
      );
    });

    // Inline: open wallet config panel
    b.action(/^cfg:(.+)$/, (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.showWalletConfig(ctx, ctx.match[1]);
    });

    // Inline: edit a wallet field
    b.action(/^cfgset:(.+):(.+)$/, (ctx) => {
      if (!this.allowed(ctx)) return;
      const wallet = ctx.match[1];
      const field = ctx.match[2] as
        | "multiplier"
        | "maxusdc"
        | "copyusdc"
        | "percent"
        | "label"
        | "toggle";
      ctx.answerCbQuery().catch(() => {});

      if (field === "toggle") {
        const cfg = this.walletCfgs.get(wallet);
        if (cfg) {
          this.walletCfgs.update(wallet, { enabled: !cfg.enabled });
          this.showWalletConfig(ctx, wallet);
        }
        return;
      }

      this.steps.set(this.uid(ctx), {
        type: "set_wallet_field",
        wallet,
        field,
      });
      const labels: Record<string, string> = {
        multiplier: "Size multiplier (напр. 0.5 или 2)",
        maxusdc: "Max USDC на trade (напр. 100)",
        copyusdc: "Фиксиран USDC (0 = изключено)",
        percent: "% от trader размера (1–100, 0 = изключено)",
        label: "Label (напр. Whale #1)",
      };
      this.replyTo(ctx, `✏️ Въведи стойност за *${labels[field]}*:`);
    });

    // Inline: remove confirm
    b.action(/^remove:(.+)$/, async (ctx) => {
      if (!this.allowed(ctx)) return;
      const res = this.removeWallet(ctx.match[1]);
      ctx.answerCbQuery(res.ok ? "Премахнат" : "Грешка").catch(() => {});
      this.replyTo(ctx, res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}`);
    });

    // P&L
    b.command("pnl", (ctx) => this.handlePnl(ctx));
    b.hears("📊 P&L", (ctx) => this.handlePnl(ctx));

    // Daily P&L per wallet
    b.command("daily", (ctx) => this.handleDaily(ctx, false));
    b.command("dailyall", (ctx) => this.handleDaily(ctx, true));

    // History
    b.command("history", (ctx) => {
      const n = parseInt(ctx.message.text.split(" ")[1] || "10");
      this.handleHistory(ctx, n);
    });
    b.hears("📜 History", (ctx) => this.handleHistory(ctx, 10));

    // Orders
    b.command("orders", (ctx) => this.handleOrders(ctx));
    b.hears("📂 Orders", (ctx) => this.handleOrders(ctx));

    // Status
    b.command("status", (ctx) => this.handleStatus(ctx));
    b.hears("ℹ️ Status", (ctx) => this.handleStatus(ctx));

    // Settings
    b.command("settings", (ctx) => this.handleSettings(ctx));
    b.hears("⚙️ Settings", (ctx) => this.handleSettings(ctx));

    // Dry run toggle
    b.command("dryrun", (ctx) => {
      if (!this.allowed(ctx)) return;
      const arg = ctx.message.text.split(" ")[1]?.toLowerCase();
      if (arg === "on") {
        this.setDryRun(true);
        ctx.reply("🔵 Dry run *ON*", { parse_mode: "Markdown" });
      } else if (arg === "off") {
        this.setDryRun(false);
        ctx.reply("🔴 Dry run *OFF* — РЕАЛНИ ордери!", {
          parse_mode: "Markdown",
        });
      } else ctx.reply("Употреба: /dryrun on|off");
    });

    // Refresh callbacks
    b.action("refresh:pnl", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handlePnl(ctx);
    });
    b.action("refresh:status", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleStatus(ctx);
    });
    b.action("refresh:orders", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleOrders(ctx);
    });
    b.action("refresh:history", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleHistory(ctx, 10);
    });
    b.action("refresh:daily", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleDaily(ctx, false);
    });

    // Help
    b.command("help", (ctx) => this.handleHelp(ctx));
    b.hears("❓ Help", (ctx) => this.handleHelp(ctx));

    // Free text — handle pending steps
    b.on("text", (ctx) => {
      if (!this.allowed(ctx)) return;
      const step = this.steps.get(this.uid(ctx));
      if (!step) return;
      this.steps.delete(this.uid(ctx));
      if (step.type === "set_wallet_field") {
        this.handleWalletSet(
          ctx,
          step.wallet,
          step.field,
          ctx.message.text.trim(),
        );
      }
    });
  }

  // ─── Wallet list ─────────────────────────────────────────────────────────────
  private handleWallets(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const cfgs = this.walletCfgs.getAll();
    if (cfgs.length === 0)
      return ctx.reply("📋 Няма следвани wallets.\n/add 0xADDRESS");
    const buttons = cfgs.map((c) =>
      Markup.button.callback(
        `${c.enabled ? "🟢" : "⏸"} ${c.label || c.wallet.slice(0, 12) + "…"}`,
        `cfg:${c.wallet}`,
      ),
    );
    ctx.reply(`📋 *Wallets (${cfgs.length}):*\n\nНатисни за настройки:`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons, { columns: 1 }),
    });
  }

  // ─── Wallet config panel ─────────────────────────────────────────────────────
  private showWalletConfig(ctx: Context, wallet: string) {
    const cfg = this.walletCfgs.get(wallet);
    if (!cfg) {
      this.replyTo(ctx, "❌ Wallet не е намерен.");
      return;
    }

    const label = cfg.label ? `*${cfg.label}*\n` : "";
    const text =
      `⚙️ ${label}\`${wallet}\`\n\n` +
      `Status: ${cfg.enabled ? "🟢 Active" : "⏸ Paused"}\n` +
      `Multiplier: \`${cfg.sizeMultiplier}x\`\n` +
      `Max/trade: \`$${cfg.maxTradeUsdc}\`\n` +
      (() => {
        let modeStr = "";
        if (cfg.copySizeUsdc > 0) modeStr = `🔒 Fixed: $${cfg.copySizeUsdc}`;
        else if (cfg.sizePercent > 0)
          modeStr = `📐 Percent: ${cfg.sizePercent}%`;
        else modeStr = `✖️ Multiplier: ${cfg.sizeMultiplier}x`;
        return (
          `Active sizing: \`${modeStr}\`\n` +
          `Max/trade: \`$${cfg.maxTradeUsdc}\`\n` +
          `Label: \`${cfg.label || "—"}\``
        );
      })();

    const buttons = [
      [
        Markup.button.callback(
          cfg.enabled ? "⏸ Pause" : "▶️ Enable",
          `cfgset:${wallet}:toggle`,
        ),
      ],
      [
        Markup.button.callback("✏️ Multiplier", `cfgset:${wallet}:multiplier`),
        Markup.button.callback("✏️ Max USDC", `cfgset:${wallet}:maxusdc`),
      ],
      [
        Markup.button.callback("✏️ % of trade", `cfgset:${wallet}:percent`),
        Markup.button.callback("✏️ Fixed size", `cfgset:${wallet}:copyusdc`),
      ],
      [Markup.button.callback("✏️ Label", `cfgset:${wallet}:label`)],
      [Markup.button.callback("🗑 Remove", `remove:${wallet}`)],
    ];

    const extra = {
      parse_mode: "Markdown" as const,
      ...Markup.inlineKeyboard(buttons),
    };

    // Try to edit existing message (callback context), else send new
    if (
      "editMessageText" in ctx &&
      typeof (ctx as any).editMessageText === "function"
    ) {
      (ctx as any)
        .editMessageText(text, extra)
        .catch(() => this.replyTo(ctx, text, extra));
    } else {
      this.replyTo(ctx, text, extra);
    }
  }

  // ─── Add ─────────────────────────────────────────────────────────────────────
  private async handleAdd(ctx: Context, wallet?: string, label?: string) {
    if (!this.allowed(ctx)) return;
    if (!wallet || !wallet.startsWith("0x") || wallet.length < 20) {
      return ctx.reply("❌ Невалиден адрес.\n`/add 0xWALLET [Label]`", {
        parse_mode: "Markdown",
      });
    }
    const res = await this.addWallet(wallet, label);
    await ctx.reply(res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}`, {
      parse_mode: "Markdown",
    });
    if (res.ok) this.showWalletConfig(ctx, wallet);
  }

  // ─── Remove ──────────────────────────────────────────────────────────────────
  private handleRemove(ctx: Context, wallet?: string) {
    if (!this.allowed(ctx)) return;
    if (!wallet || !wallet.startsWith("0x"))
      return ctx.reply("Употреба: /remove 0xWALLET");
    const res = this.removeWallet(wallet);
    ctx.reply(res.ok ? `✅ ${res.msg}` : `❌ ${res.msg}`, {
      parse_mode: "Markdown",
    });
  }

  // ─── Per-wallet field set ─────────────────────────────────────────────────────
  private handleWalletSet(
    ctx: Context,
    wallet: string,
    field: "multiplier" | "maxusdc" | "copyusdc" | "percent" | "label",
    value: string,
  ) {
    if (!this.allowed(ctx)) return;
    if (!wallet || !this.walletCfgs.has(wallet)) {
      return this.replyTo(ctx, `❌ Wallet не е намерен: \`${wallet}\``);
    }

    let patch: Partial<WalletConfig> = {};
    let display = "";

    if (field === "label") {
      patch = { label: value };
      display = `Label = "${value}"`;
    } else {
      const num = parseFloat(value);
      if (isNaN(num) || num < 0)
        return this.replyTo(ctx, "❌ Невалидна стойност.");
      if (field === "multiplier") {
        patch = { sizeMultiplier: num, sizePercent: 0, copySizeUsdc: 0 }; // clear others
        display = `Multiplier = ${num}x (Fixed/% изчистени)`;
      } else if (field === "maxusdc") {
        patch = { maxTradeUsdc: num };
        display = `Max USDC = $${num}`;
      } else if (field === "copyusdc") {
        patch = { copySizeUsdc: num, sizePercent: 0 }; // clear percent
        display =
          num > 0
            ? `Fixed size = $${num} (% mode изчистен)`
            : "Fixed size изключен";
      } else if (field === "percent") {
        if (num < 0 || num > 100)
          return this.replyTo(ctx, "❌ Въведи число от 0 до 100.");
        patch = { sizePercent: num, copySizeUsdc: 0 }; // clear fixed size
        display =
          num > 0
            ? `${num}% от trader размера (Fixed size изчистен)`
            : "% mode изключен";
      }
    }

    const updated = this.walletCfgs.update(wallet, patch);
    if (!updated) return this.replyTo(ctx, "❌ Update failed.");

    this.replyTo(
      ctx,
      `✅ *${updated.label || wallet.slice(0, 12) + "…"}*: ${display}`,
    ).then(() => this.showWalletConfig(ctx, wallet));
  }

  // ─── P&L ─────────────────────────────────────────────────────────────────────
  private async handlePnl(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const pnl = this.getPnL();
    await pnl.refreshPrices();
    const positions = pnl.getPositions();
    if (positions.length === 0) return ctx.reply("📊 Няма активни позиции.");

    let msg = `📊 *P&L Summary*\n\n`;
    let totalInvested = 0,
      totalPnlVal = 0;

    for (const pos of positions) {
      const pnlVal = pos.unrealizedPnl ?? 0;
      const pnlPct = pos.unrealizedPnlPct ?? 0;
      const arrow = pnlVal >= 0 ? "▲" : "▼";
      const q = (pos.question || pos.tokenId).slice(0, 40);
      const wallets = pos.sourceWallets
        .map((w) => w.slice(0, 10) + "…")
        .join(", ");
      msg += `*${q}*\n`;
      msg += `  ${wallets}\n`;
      msg += `  ${pos.side} avg $${pos.avgPrice.toFixed(4)} → $${(pos.currentPrice ?? 0).toFixed(4)}\n`;
      msg += `  $${pos.totalSizeUsdc.toFixed(2)} | ${arrow} ${pnlVal >= 0 ? "+" : ""}$${pnlVal.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)\n\n`;
      totalInvested += pos.totalSizeUsdc;
      totalPnlVal += pnlVal;
    }
    const pct = totalInvested > 0 ? (totalPnlVal / totalInvested) * 100 : 0;
    msg += `─────────────────\n*TOTAL*: $${totalInvested.toFixed(2)} | ${totalPnlVal >= 0 ? "▲ +" : "▼ "}$${Math.abs(totalPnlVal).toFixed(4)} (${totalPnlVal >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
    this.editOrReply(ctx, msg, this.refreshBtn("refresh:pnl"));
  }

  // ─── Daily P&L per wallet ───────────────────────────────────────────────────
  private async handleDaily(ctx: Context, allDays: boolean) {
    if (!this.allowed(ctx)) return;
    const pnl = this.getPnL();
    await pnl.refreshPrices();
    const records = pnl.getDailyByWallet(allDays);

    if (records.length === 0) {
      return ctx.reply(
        allDays ? "📅 Няма записани дни." : "📅 Няма trades за днес.",
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const title = allDays
      ? "📅 *Daily P&L (all days)*"
      : `📅 *Daily P&L — ${today}*`;
    let msg = title + "\n\n";

    const byDate = new Map<string, typeof records>();
    for (const r of records) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r);
    }

    for (const [date, recs] of byDate) {
      if (allDays) msg += `*${date}*\n`;
      let dayTotal = 0;

      for (const r of recs) {
        const arrow = r.pnl >= 0 ? "▲" : "▼";
        const pct = r.invested > 0 ? (r.pnl / r.invested) * 100 : 0;
        const name = r.walletLabel || r.wallet.slice(0, 14) + "…";
        msg += `  ${r.pnl >= 0 ? "🟢" : "🔴"} *${name}*\n`;
        msg += `    Invested: $${r.invested.toFixed(2)} | Trades: ${r.trades}\n`;
        msg += `    P&L: ${arrow} ${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(4)} (${r.pnl >= 0 ? "+" : ""}${pct.toFixed(1)}%)\n\n`;
        dayTotal += r.pnl;
      }

      if (recs.length > 1) {
        msg += `  ─────\n`;
        msg += `  Day total: ${dayTotal >= 0 ? "▲ +" : "▼ "}$${Math.abs(dayTotal).toFixed(4)}\n\n`;
      }
    }

    msg += `_/daily — само днес | /dailyall — всички дни_`;
    this.editOrReply(ctx, msg, this.refreshBtn("refresh:daily"));
  }

  // ─── History ──────────────────────────────────────────────────────────────────
  private handleHistory(ctx: Context, n: number) {
    if (!this.allowed(ctx)) return;
    const history = this.getHistory();
    if (history.length === 0) return ctx.reply("📜 Няма история.");
    const icons: Record<string, string> = {
      PLACED: "✅",
      FAILED: "❌",
      SKIPPED: "⏭️",
      DRY_RUN: "🔵",
    };
    const last = history.slice(-n).reverse();
    let msg = `📜 *Последни ${last.length} trade(s):*\n\n`;
    for (const t of last) {
      const trade = t.originalTrade;
      const time = new Date(t.timestamp).toLocaleTimeString("bg-BG");
      msg += `${icons[t.status] || "?"} *${t.status}* — ${time}\n`;
      msg += `  ${trade.side} $${trade.size.toFixed(2)} @ ${trade.price}\n`;
      if (t.orderId) msg += `  \`${t.orderId}\`\n`;
      if (t.reason) msg += `  _${t.reason}_\n`;
      msg += "\n";
    }
    this.editOrReply(ctx, msg, this.refreshBtn("refresh:history"));
  }

  // ─── Orders ──────────────────────────────────────────────────────────────────
  private async handleOrders(ctx: Context) {
    if (!this.allowed(ctx)) return;
    await ctx.reply("⏳ Зареждам активни поръчки…", { parse_mode: "Markdown" });
    const orders = await this.getOrders();
    if (orders.length === 0) return ctx.reply("📂 Няма активни поръчки.");

    const sides: Record<string, string> = { BUY: "🟢 BUY", SELL: "🔴 SELL" };
    let msg = `📂 *Активни поръчки (${orders.length}):*\n\n`;
    for (const o of orders) {
      const side = sides[o.side?.toUpperCase()] ?? o.side;
      const price = parseFloat(o.price ?? 0).toFixed(4);
      const remaining = parseFloat(
        o.size_remaining ?? o.original_size ?? 0,
      ).toFixed(2);
      const matched = parseFloat(o.size_matched ?? 0).toFixed(2);
      const outcome = o.outcome ? ` (${o.outcome})` : "";
      const asset = (o.asset_id ?? o.tokenId ?? "").slice(0, 12);
      msg += `${side}${outcome} | \`${asset}…\`\n`;
      msg += `  Price: *${price}* | Rem: $${remaining} | Filled: $${matched}\n`;
      msg += `  \`${o.id ?? "—"}\`\n\n`;
    }
    this.editOrReply(ctx, msg, this.refreshBtn("refresh:orders"));
  }

  // ─── Status ───────────────────────────────────────────────────────────────────
  private handleStatus(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const cfgs = this.walletCfgs.getAll();
    const history = this.getHistory();
    const placed = history.filter((h) => h.status === "PLACED").length;
    const failed = history.filter((h) => h.status === "FAILED").length;
    const wList =
      cfgs.length > 0
        ? cfgs
            .map(
              (c) =>
                `  ${c.enabled ? "🟢" : "⏸"} ${c.label || c.wallet.slice(0, 12) + "…"} ×${c.sizeMultiplier} max$${c.maxTradeUsdc}`,
            )
            .join("\n")
        : "  (няма)";

    ctx.reply(
      `ℹ️ *Bot Status*\n\n` +
        `🟢 Running | Dry: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}\n` +
        `Poll: ${config.pollIntervalMs / 1000}s\n\n` +
        `*Wallets (${cfgs.length}):*\n${wList}\n\n` +
        `✅ ${placed} | ❌ ${failed} | 📦 ${history.length}`,
      { parse_mode: "Markdown", ...this.refreshBtn("refresh:status") },
    );
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────
  private handleSettings(ctx: Context) {
    if (!this.allowed(ctx)) return;
    ctx.reply(
      `⚙️ *Global Settings*\n\n` +
        `Dry run: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}\n` +
        `Poll: \`${config.pollIntervalMs / 1000}s\`\n\n` +
        `Per-wallet: /wallets → избери wallet\n\n` +
        `/dryrun on|off`,
      { parse_mode: "Markdown" },
    );
  }

  // ─── Help ─────────────────────────────────────────────────────────────────────
  private handleHelp(ctx: Context) {
    if (!this.allowed(ctx)) return;
    ctx.reply(
      `*Команди:*\n\n` +
        `/wallets — list + per-wallet настройки\n` +
        `/add 0x... [Label] — добави wallet\n` +
        `/remove 0x... — премахни wallet\n\n` +
        `*Per-wallet:*\n` +
        `/wset 0x... multiplier 0.5\n` +
        `/wset 0x... maxusdc 50\n` +
        `/wset 0x... copyusdc 10\n` +
        `/wset 0x... percent 50\n` +
        `/wset 0x... label "Whale #1"\n\n` +
        `/pnl | /history [n] | /status\n` +
        `/orders — активни поръчки\n` +
        `/dryrun on|off | /settings`,
      { parse_mode: "Markdown" },
    );
  }

  // ─── Push notifications ───────────────────────────────────────────────────────
  async notifyNewTrade(
    sourceWallet: string,
    label: string | undefined,
    side: string,
    size: number,
    price: number,
    question: string,
    status: string,
    orderId?: string,
  ) {
    const icons: Record<string, string> = {
      PLACED: "✅",
      FAILED: "❌",
      SKIPPED: "⏭️",
      DRY_RUN: "🔵",
    };
    const src = label ? `*${label}*` : `\`${sourceWallet.slice(0, 14)}…\``;
    const msg =
      `${icons[status] || "?"} *Trade Copied*\n\n` +
      `${question.slice(0, 50)}\n` +
      `*${side}* $${size.toFixed(2)} @ ${price} | ${src}\n` +
      `Status: *${status}*` +
      (orderId ? `\n\`${orderId}\`` : "");
    await this.send(msg);
  }

  async notifyError(msg: string) {
    await this.send(`⚠️ *Error*\n\n${msg}`);
  }

  async send(text: string) {
    try {
      await this.bot.telegram.sendMessage(this.allowedChatId, text, {
        parse_mode: "Markdown",
      });
    } catch (err: any) {
      console.error("[Telegram] Send failed:", err.message);
    }
  }

  async launch() {
    await this.bot.launch();
    console.log("[Telegram] Bot started ✅");
  }
  stop() {
    this.bot.stop();
  }
}
