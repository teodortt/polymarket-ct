import { Telegraf, Context, Markup } from "telegraf";
import type { Message } from "telegraf/types";
import { execFile, spawn, exec } from "node:child_process";
import * as path from "node:path";
import { config } from "./config";
import { PnLTracker } from "./pnl";
import { CopiedTrade, WalletConfig, WeatherConfig } from "./types";
import { WalletConfigStore } from "./walletConfig";
import { getLiveUsdcBalance } from "./trader";

// ── Admin shell whitelist ────────────────────────────────────────────────────
// Only these exact (file, args) tuples can ever be executed. No shell, no
// user-supplied arguments — completely free of command-injection surface.
const PM2_APP = "polymarket-copybot";
const APP_DIR = path.resolve(__dirname, "..");

type AdminStep = { file: string; args: string[]; detached?: boolean };

type AdminCmd = {
  label: string;
  file: string;
  args: string[];
  // If true, spawn detached so the child survives this process being killed
  // (needed for `pm2 reload/restart` of THIS app — pm2 sends SIGKILL to the
  // whole process group, which would otherwise take out the pm2 CLI child too
  // and surface as `[exit ?] Command failed` in Telegram).
  detached?: boolean;
  // Optional follow-up commands executed sequentially (e.g. deploy chain).
  then?: AdminStep[];
  timeoutMs?: number;
};

const ADMIN_COMMANDS: Record<string, AdminCmd> = {
  pull: { label: "git pull", file: "git", args: ["pull", "--ff-only"] },
  gitstatus: { label: "git status", file: "git", args: ["status", "-sb"] },
  gitlog: {
    label: "git log -5",
    file: "git",
    args: ["log", "--oneline", "-n", "5"],
  },
  reload: {
    label: `pm2 reload ${PM2_APP}`,
    file: "pm2",
    args: ["reload", PM2_APP, "--update-env"],
    detached: true,
  },
  restart: {
    label: `pm2 restart ${PM2_APP}`,
    file: "pm2",
    args: ["restart", PM2_APP, "--update-env"],
    detached: true,
  },
  stopapp: {
    label: `pm2 stop ${PM2_APP}`,
    file: "pm2",
    args: ["stop", PM2_APP],
  },
  startapp: {
    label: `pm2 start ${PM2_APP}`,
    file: "pm2",
    args: ["start", PM2_APP],
  },
  pm2list: { label: "pm2 list", file: "pm2", args: ["list"] },
  applogs: {
    label: "pm2 logs (last 50)",
    file: "pm2",
    args: ["logs", PM2_APP, "--nostream", "--lines", "50"],
  },
  apperrors: {
    label: "pm2 logs --err (last 50)",
    file: "pm2",
    args: ["logs", PM2_APP, "--nostream", "--err", "--lines", "50"],
  },
  uptime: { label: "uptime", file: "uptime", args: [] },
  disk: { label: "df -h", file: "df", args: ["-h"] },
  deploy: {
    label: "git pull && npm install && pm2 reload",
    file: "git",
    args: ["pull", "--ff-only"],
    then: [
      { file: "npm", args: ["install", "--no-audit", "--no-fund"] },
      // Final step must be detached — pm2 reload will SIGKILL this very
      // process, which would otherwise kill the pm2 CLI child too.
      {
        file: "pm2",
        args: ["reload", PM2_APP, "--update-env"],
        detached: true,
      },
    ],
    timeoutMs: 180_000,
  },
};

// Detect Telegram "can't parse entities" errors so we can transparently
// retry the same message as plain text. Without this, a single unbalanced
// underscore in a wallet label or trade reason kills the whole handler
// and the bot process — pm2 then restarts it, looking like a duplicate
// instance to the user.
function isParseError(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? err.response?.error_code;
  const desc: string =
    err.description || err.response?.description || err.message || "";
  return (
    code === 400 &&
    /parse entities|find end of the entity|unsupported start tag|byte offset/i.test(
      desc,
    )
  );
}

function isTooLongError(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? err.response?.error_code;
  const desc: string =
    err.description || err.response?.description || err.message || "";
  return code === 400 && /message is too long/i.test(desc);
}

// Telegram's hard limit is 4096 characters per message. Use a small safety
// margin so we never round up into the error.
const TG_MAX = 4000;
// Per-page character budget for paginated lists. Leaves room for header,
// footer, and inline keyboard rendering.
const PAGE_BUDGET = 3500;
// Hard cap on the number of pages produced for any paginated list. Keeps
// /pnl and /history responsive even after thousands of trades; older entries
// past the cap are dropped from the view (history.json on disk is bounded
// separately).
const MAX_PAGES = 100;

// Group an array of pre-formatted item strings into pages where each page's
// joined length stays within the char budget. Items longer than the budget
// are placed alone on their own page (worst case, they'll still be split by
// the safety net in sendChunk). When the resulting page count exceeds
// `maxPages`, only the first `maxPages` pages are kept and a truncation
// notice is appended to the final page.
function paginateItems(
  items: string[],
  budget = PAGE_BUDGET,
  maxPages = MAX_PAGES,
): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const it of items) {
    const len = it.length + 1; // +1 for joiner newline
    if (cur.length > 0 && curLen + len > budget) {
      pages.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(it);
    curLen += len;
  }
  if (cur.length > 0) pages.push(cur);
  if (pages.length === 0) pages.push([]);
  if (pages.length > maxPages) {
    const kept = pages.slice(0, maxPages);
    const droppedPages = pages.length - maxPages;
    const droppedItems = pages
      .slice(maxPages)
      .reduce((s, p) => s + p.length, 0);
    kept[kept.length - 1].push(
      `_…(+${droppedItems} older item(s) across ${droppedPages} page(s) truncated)_`,
    );
    return kept;
  }
  return pages;
}

// Split a long message into <= TG_MAX-char chunks, breaking on line
// boundaries when possible so Markdown formatting (bold/italic/code blocks)
// stays balanced within each chunk.
function splitMessage(text: string, max = TG_MAX): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    // Single line longer than max — hard-split it.
    if (line.length > max) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += max) {
        out.push(line.slice(i, i + max));
      }
      continue;
    }
    if (buf.length + line.length + 1 > max) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function parseBool(val: string): boolean | undefined {
  const v = val.trim().toLowerCase();
  if (["1", "true", "on", "yes", "y", "enable", "enabled"].includes(v)) {
    return true;
  }
  if (["0", "false", "off", "no", "n", "disable", "disabled"].includes(v)) {
    return false;
  }
  return undefined;
}

function runOne(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: APP_DIR,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        // No shell — args are passed verbatim, never interpreted.
        shell: false,
        env: process.env,
      },
      (err, stdout, stderr) => {
        const out = `${stdout || ""}${stderr ? "\n" + stderr : ""}`.trim();
        if (err) {
          resolve({
            ok: false,
            out: `${out}\n[exit ${(err as any).code ?? "?"}] ${err.message}`.trim(),
          });
        } else {
          resolve({ ok: true, out: out || "(no output)" });
        }
      },
    );
  });
}

// Fire-and-forget: spawn the child in its own session so it isn't killed when
// our process group gets a SIGKILL (e.g. `pm2 reload` of this very app).
function runDetached(
  file: string,
  args: string[],
): { ok: boolean; out: string } {
  try {
    const child = spawn(file, args, {
      cwd: APP_DIR,
      env: process.env,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
    return {
      ok: true,
      out: `(spawned detached, pid=${child.pid ?? "?"} — not waiting for output)`,
    };
  } catch (err: any) {
    return { ok: false, out: `[spawn failed] ${err?.message ?? String(err)}` };
  }
}

async function runAdminCmd(cmd: AdminCmd): Promise<string> {
  const timeoutMs = cmd.timeoutMs ?? 60_000;
  const steps: AdminStep[] = [
    { file: cmd.file, args: cmd.args, detached: cmd.detached },
    ...(cmd.then ?? []),
  ];
  const chunks: string[] = [];
  for (const s of steps) {
    const res = s.detached
      ? runDetached(s.file, s.args)
      : await runOne(s.file, s.args, timeoutMs);
    chunks.push(`$ ${s.file} ${s.args.join(" ")}\n${res.out}`);
    if (!res.ok) break; // stop the chain on first failure
  }
  return chunks.join("\n\n");
}

type AddWalletFn = (
  wallet: string,
  label?: string,
) => Promise<{ ok: boolean; msg: string }>;
type RemoveWalletFn = (wallet: string) => { ok: boolean; msg: string };
type WalletExposureFn = (wallet: string) => {
  placedOrderIds: string[];
  copiedTrades: number;
};
type CancelOrdersForWalletFn = (
  wallet: string,
) => Promise<{ ok: boolean; cancelled: number; reason?: string }>;
type ForceCopyLastFn = (
  wallet: string,
) => Promise<{ ok: boolean; msg: string }>;
type GetHistoryFn = () => CopiedTrade[];
type GetPnLFn = () => PnLTracker;
type SetDryRunFn = (val: boolean) => void;
type GetOrdersFn = () => Promise<any[]>;
type GetDebugFn = () => any;
type ClearHistoryFn = () => {
  clearedHistory: number;
  clearedDaily: number;
  clearedPositions: number;
};

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
  private walletExposure!: WalletExposureFn;
  private cancelOrdersForWallet!: CancelOrdersForWalletFn;
  private forceCopyLast!: ForceCopyLastFn;
  private getHistory!: GetHistoryFn;
  private getPnL!: GetPnLFn;
  private setDryRun!: SetDryRunFn;
  private getOrders!: GetOrdersFn;
  private getDebug!: GetDebugFn;
  private clearHistory!: ClearHistoryFn;
  private walletCfgs!: WalletConfigStore;
  // Optional provider for the weather module's report (injected from index.ts
  // when WEATHER_ENABLED). Left undefined keeps /weather a graceful no-op.
  private weatherReport?: () => string | Promise<string>;
  // Optional reference to the weather engine (for exit commands).
  private weatherEngine?: {
    getOpenPositions(): any[];
    maybeExitPosition(pos: any): Promise<void>;
  };

  constructor() {
    this.bot = new Telegraf(config.telegramBotToken);
    this.allowedChatId = config.telegramChatId;
    // Catch-all so a single bad update never crashes the polling loop.
    // Without this, an unhandled error in a handler exits the process and
    // pm2 restarts it — looking like a duplicate "CopyBot started" event.
    this.bot.catch((err: any, ctx) => {
      const desc = err?.description || err?.message || String(err);
      console.error(`[Telegram] handler error on ${ctx.updateType}: ${desc}`);
      if (err?.stack) console.error(err.stack);
    });
    this.setupCommands();
  }

  register(callbacks: {
    addWallet: AddWalletFn;
    removeWallet: RemoveWalletFn;
    walletExposure: WalletExposureFn;
    cancelOrdersForWallet: CancelOrdersForWalletFn;
    forceCopyLast: ForceCopyLastFn;
    getHistory: GetHistoryFn;
    getPnL: GetPnLFn;
    setDryRun: SetDryRunFn;
    getOrders: GetOrdersFn;
    getDebug: GetDebugFn;
    clearHistory: ClearHistoryFn;
    walletCfgs: WalletConfigStore;
  }) {
    Object.assign(this, callbacks);
  }

  // Inject the weather module's report renderer (optional subsystem).
  setWeatherReportProvider(fn: () => string | Promise<string>) {
    this.weatherReport = fn;
  }

  // Inject the weather engine (for exit commands).
  setWeatherEngine(engine: {
    getOpenPositions(): any[];
    maybeExitPosition(pos: any): Promise<void>;
  }) {
    this.weatherEngine = engine;
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
    const opts = { parse_mode: "Markdown" as const, ...(extra ?? {}) };
    const chunks = splitMessage(text);
    // Inline keyboards / reply markup belong only on the LAST chunk so the
    // "refresh" / action buttons appear at the bottom of the conversation.
    const lastIdx = chunks.length - 1;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === lastIdx;
      const chunkOpts: any = isLast
        ? { ...opts }
        : { parse_mode: opts.parse_mode };
      await this.sendChunk(chatId, chunks[i], chunkOpts);
    }
  }

  // Send a single (already-sized) chunk with Markdown → plain-text fallback.
  private async sendChunk(
    chatId: number,
    text: string,
    opts: { parse_mode?: "Markdown"; reply_markup?: any },
  ) {
    try {
      await this.bot.telegram.sendMessage(chatId, text, opts as any);
    } catch (err: any) {
      if (isParseError(err)) {
        console.warn(
          `[Telegram] Markdown parse failed, retrying plain: ${err.description || err.message}`,
        );
        const { parse_mode, ...rest } = opts as any;
        void parse_mode;
        try {
          await this.bot.telegram.sendMessage(chatId, text, rest);
          return;
        } catch (err2: any) {
          console.error(
            "[Telegram] Plain-text fallback also failed:",
            err2.message,
          );
          return;
        }
      }
      if (isTooLongError(err)) {
        // Defensive: shouldn't happen because we already split, but if it
        // does (e.g. multibyte length differences), split harder and recurse.
        console.warn(
          `[Telegram] message too long after split, re-splitting smaller`,
        );
        const halves = splitMessage(text, Math.floor(TG_MAX / 2));
        for (const h of halves) await this.sendChunk(chatId, h, opts);
        return;
      }
      console.error("[Telegram] sendMessage failed:", err.message);
    }
  }

  // Helper — edit message if in callback context, else send new.
  // Silently swallows "message is not modified" so refresh never duplicates.
  private async editOrReply(ctx: Context, text: string, extra?: object) {
    const fullExtra = { parse_mode: "Markdown" as const, ...(extra ?? {}) };
    const isCallback =
      "callbackQuery" in ctx && (ctx as any).callbackQuery != null;
    // editMessageText can't span multiple messages — if the new content is
    // too large to fit in one message, fall through to a fresh reply that
    // gets properly chunked by replyTo().
    if (isCallback && text.length <= TG_MAX) {
      try {
        await (ctx as any).editMessageText(text, fullExtra);
        return;
      } catch (err: any) {
        const msg = String(err?.description || err?.message || "");
        // Identical content — nothing to do, keep the existing message.
        if (msg.includes("message is not modified")) return;
        // Markdown parse error — retry edit as plain text.
        if (isParseError(err)) {
          console.warn(
            `[Telegram] editMessageText Markdown failed, retrying plain: ${msg}`,
          );
          const { parse_mode, ...rest } = fullExtra as any;
          void parse_mode;
          try {
            await (ctx as any).editMessageText(text, rest);
            return;
          } catch {
            /* fall through to fresh reply below */
          }
        }
        // Otherwise fall through and post a fresh message.
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
      ctx.reply("🤖 *Polymarket CopyBot*\n\nChoose an action:", {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("📋 Wallets", "menu:wallets"),
            Markup.button.callback("➕ Add", "menu:add"),
            Markup.button.callback("➖ Remove", "menu:remove"),
          ],
          [
            Markup.button.callback("📊 P&L", "menu:pnl"),
            Markup.button.callback("📜 History", "menu:history"),
            Markup.button.callback("📂 Orders", "menu:orders"),
          ],
          [
            Markup.button.callback("⚙️ Settings", "menu:settings"),
            Markup.button.callback("ℹ️ Status", "menu:status"),
            Markup.button.callback("❓ Help", "menu:help"),
          ],
          [Markup.button.callback("🌦 Weather", "menu:weather")],
        ]),
      });
    });

    // Inline menu actions
    b.action(/^menu:(.+)$/, async (ctx) => {
      if (!this.allowed(ctx)) return ctx.answerCbQuery();
      await ctx.answerCbQuery();
      const key = (ctx.match as RegExpMatchArray)[1];
      switch (key) {
        case "wallets":
          return this.handleWallets(ctx);
        case "add":
          return ctx.reply(
            "Send:\n`/add 0xWALLET` or\n`/add 0xWALLET Whale #1`",
            { parse_mode: "Markdown" },
          );
        case "remove": {
          const cfgs = this.walletCfgs.getAll();
          if (cfgs.length === 0) return ctx.reply("No wallets to remove.");
          const buttons = cfgs.map((c) =>
            Markup.button.callback(
              `${c.label ? c.label + " " : ""}${c.wallet.slice(0, 10)}…`,
              `remove:${c.wallet}`,
            ),
          );
          return ctx.reply(
            "Choose a wallet to remove:",
            Markup.inlineKeyboard(buttons, { columns: 1 }),
          );
        }
        case "pnl":
          return this.handlePnl(ctx, 0);
        case "history":
          return this.handleHistory(ctx, undefined, 0);
        case "orders":
          return this.handleOrders(ctx);
        case "settings":
          return this.handleSettings(ctx);
        case "status":
          return this.handleStatus(ctx);
        case "help":
          return this.handleHelp(ctx);
        case "weather":
          return this.handleWeather(ctx);
      }
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
      ctx.reply("Send:\n`/add 0xWALLET` or\n`/add 0xWALLET Whale #1`", {
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
      if (cfgs.length === 0) return ctx.reply("No wallets to remove.");
      const buttons = cfgs.map((c) =>
        Markup.button.callback(
          `${c.label ? c.label + " " : ""}${c.wallet.slice(0, 10)}…`,
          `remove:${c.wallet}`,
        ),
      );
      ctx.reply(
        "Choose a wallet to remove:",
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
        multiplier: "Size multiplier (e.g. 0.5 or 2)",
        maxusdc: "Max USDC per trade (e.g. 100)",
        copyusdc: "Fixed USDC (0 = disabled)",
        percent: "% of trader size (1–100, 0 = disabled)",
        label: "Label (e.g. Whale #1)",
      };
      this.replyTo(ctx, `✏️ Enter value for *${labels[field]}*:`);
    });

    // Inline: remove → show confirmation panel
    b.action(/^remove:(.+)$/, async (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.showRemoveConfirm(ctx, ctx.match[1]);
    });

    // Inline: confirm — just stop following (keep open orders / positions)
    b.action(/^rmkeep:(.+)$/, async (ctx) => {
      if (!this.allowed(ctx)) return;
      const wallet = ctx.match[1];
      const res = this.removeWallet(wallet);
      ctx.answerCbQuery(res.ok ? "Removed" : "Error").catch(() => {});
      this.editOrReply(
        ctx,
        res.ok
          ? `✅ ${res.msg}\n\n_Open positions/orders left untouched._`
          : `❌ ${res.msg}`,
      );
    });

    // Inline: confirm — stop following AND cancel any open orders we placed for it
    b.action(/^rmcancel:(.+)$/, async (ctx) => {
      if (!this.allowed(ctx)) return;
      const wallet = ctx.match[1];
      ctx.answerCbQuery("Cancel + remove…").catch(() => {});
      const cancelRes = await this.cancelOrdersForWallet(wallet);
      const rmRes = this.removeWallet(wallet);
      const lines = [
        rmRes.ok ? `✅ ${rmRes.msg}` : `❌ ${rmRes.msg}`,
        cancelRes.ok
          ? `🗑 Cancelled orders: *${cancelRes.cancelled}*`
          : `⚠️ Cancel failed: _${cancelRes.reason ?? "?"}_`,
        `_Already-filled positions remain in your account._`,
      ];
      this.editOrReply(ctx, lines.join("\n"));
    });

    // Inline: cancel the remove action — return to wallet config panel
    b.action(/^rmabort:(.+)$/, (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery("Cancelled").catch(() => {});
      this.showWalletConfig(ctx, ctx.match[1]);
    });

    // P&L
    b.command("pnl", (ctx) => this.handlePnl(ctx, 0));
    b.hears("📊 P&L", (ctx) => this.handlePnl(ctx, 0));

    // Daily P&L per wallet
    b.command("daily", (ctx) => this.handleDaily(ctx, false));
    b.command("dailyall", (ctx) => this.handleDaily(ctx, true));

    // History — `/history` shows everything paginated; `/history N` limits
    // to the most recent N items (still paginated if N is large).
    b.command("history", (ctx) => {
      const arg = ctx.message.text.split(" ")[1];
      const n = arg ? parseInt(arg) : undefined;
      this.handleHistory(ctx, n, 0);
    });
    b.hears("📜 History", (ctx) => this.handleHistory(ctx, undefined, 0));

    // Orders
    b.command("orders", (ctx) => this.handleOrders(ctx));
    b.hears("📂 Orders", (ctx) => this.handleOrders(ctx));

    // Status
    b.command("status", (ctx) => this.handleStatus(ctx));
    b.hears("ℹ️ Status", (ctx) => this.handleStatus(ctx));

    // Manual retry: force-copy the wallet's latest trade through the same
    // live pipeline (sizing, dry-run/live routing, notifications).
    b.command("retry", async (ctx) => {
      if (!this.allowed(ctx)) return;
      const wallet = ctx.message.text.split(" ")[1]?.trim();
      if (!wallet) {
        return ctx.reply("Usage: /retry 0xWALLET");
      }
      const res = await this.forceCopyLast(wallet);
      const icon = res.ok ? "✅" : "❌";
      return this.replyTo(
        ctx,
        `${icon} /retry ${wallet.slice(0, 10)}…\n${res.msg}`,
      );
    });

    // Weather predictions + signals
    b.command("weather", (ctx) => {
      if (!this.allowed(ctx)) return;
      const arg = ctx.message.text.split(" ")[1]?.trim();
      if (arg) {
        const enabled = parseBool(arg);
        if (enabled !== undefined) {
          config.weather.enabled = enabled;
          this.replyTo(
            ctx,
            `✅ WEATHER_ENABLED set to *${enabled}*\n\nUse /weathercfg to inspect current runtime values.`,
          );
          return;
        }
      }
      this.handleWeather(ctx);
    });
    b.command("weathercfg", (ctx) => {
      if (!this.allowed(ctx)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length === 1) {
        this.replyTo(ctx, this.weatherConfigSummary());
        return;
      }
      if (parts.length < 3) {
        this.replyTo(
          ctx,
          "Usage:\n/weathercfg\n/weathercfg WEATHER_ENABLED true\n/weathercfg WEATHER_MIN_PRICE 0.03",
        );
        return;
      }
      const key = parts[1];
      const value = parts.slice(2).join(" ");
      const res = this.applyWeatherConfig(key, value);
      if (!res.ok) {
        this.replyTo(ctx, `❌ ${res.msg}`);
        return;
      }
      this.replyTo(ctx, `✅ ${res.msg}`);
    });
    b.hears("🌦 Weather", (ctx) => this.handleWeather(ctx));
    b.action("refresh:weather", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleWeather(ctx);
    });

    // Exit commands
    b.command("exit", (ctx) => {
      if (!this.allowed(ctx)) return;
      const arg = ctx.message.text.split(" ")[1]?.trim();
      if (arg) {
        const enabled = parseBool(arg);
        if (enabled !== undefined) {
          config.weather.exitEnabled = enabled;
          this.replyTo(ctx, `✅ WEATHER_EXIT_ENABLED set to *${enabled}*`);
          return;
        }
      }
      this.replyTo(ctx, "Usage: /exit on|off");
    });

    b.command("exitall", (ctx) => {
      if (!this.allowed(ctx)) return;
      if (!this.weatherEngine) {
        this.replyTo(ctx, "❌ Weather engine not initialized.");
        return;
      }
      const positions = this.weatherEngine.getOpenPositions();
      if (positions.length === 0) {
        this.replyTo(ctx, "ℹ️ No open positions to close.");
        return;
      }
      this.replyTo(ctx, `⏳ Liquidating ${positions.length} position(s)...`);
      (async () => {
        let closed = 0;
        for (const pos of positions) {
          try {
            await this.weatherEngine!.maybeExitPosition(pos);
            closed++;
          } catch (err: any) {
            console.error(`Failed to exit ${pos.tokenId}:`, err?.message);
          }
        }
        this.replyTo(
          ctx,
          `✅ Closed ${closed}/${positions.length} position(s).`,
        );
      })().catch((err) => {
        this.replyTo(ctx, `❌ Exit failed: ${err?.message ?? err}`);
      });
    });

    b.command("exitcfg", (ctx) => {
      if (!this.allowed(ctx)) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      if (parts.length === 1) {
        this.replyTo(ctx, this.exitConfigSummary());
        return;
      }
      if (parts.length < 3) {
        this.replyTo(
          ctx,
          "Usage:\n/exitcfg\n/exitcfg WEATHER_EXIT_ENABLED true\n/exitcfg WEATHER_EXIT_PROFIT_TARGET 0.60\n/exitcfg WEATHER_EXIT_TREND_DROP_FROM_PEAK 0.08",
        );
        return;
      }
      const key = parts[1];
      const value = parts.slice(2).join(" ");
      const res = this.applyExitConfig(key, value);
      if (!res.ok) {
        this.replyTo(ctx, `❌ ${res.msg}`);
        return;
      }
      this.replyTo(ctx, `✅ ${res.msg}`);
    });

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
        ctx.reply("🔴 Dry run *OFF* — REAL ORDERS!", {
          parse_mode: "Markdown",
        });
      } else ctx.reply("Usage: /dryrun on|off");
    });

    // Refresh callbacks
    b.action("refresh:pnl", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handlePnl(ctx, 0, true);
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
      this.handleHistory(ctx, undefined, 0);
    });
    b.action("refresh:daily", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleDaily(ctx, false, true);
    });
    b.action("refresh:debug", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleDebug(ctx);
    });

    // Pagination callbacks: pg:<kind>:<pageIndex>
    b.action(/^pg:(history|pnl):(\d+)$/, (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      const kind = ctx.match[1];
      const page = parseInt(ctx.match[2], 10) || 0;
      if (kind === "history") this.handleHistory(ctx, undefined, page);
      else if (kind === "pnl") this.handlePnl(ctx, page);
    });

    // No-op for disabled pagination buttons (page indicator, edge arrows).
    b.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

    // Debug — watcher state, useful when "nothing is happening"
    b.command("debug", (ctx) => this.handleDebug(ctx));

    // ── Reset history (keeps wallets + live positions) ──────────────────────
    b.command("reset", (ctx) => this.handleResetPrompt(ctx));
    b.action("reset:confirm", async (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery("Clearing…").catch(() => {});
      const res = this.clearHistory();
      this.editOrReply(
        ctx,
        `🧹 *Reset complete.*\n\n` +
          `• History entries cleared: *${res.clearedHistory}*\n` +
          `• Daily P&L records cleared: *${res.clearedDaily}*\n\n` +
          `_Wallets and live positions were kept. ` +
          `Positions in memory remain until the next restart._`,
      );
    });
    b.action("reset:abort", (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery("Cancelled").catch(() => {});
      this.editOrReply(ctx, "↩️ Reset cancelled.");
    });

    // ── Admin shell commands (whitelisted) ───────────────────────────────────
    for (const key of Object.keys(ADMIN_COMMANDS)) {
      b.command(key, (ctx) => this.handleAdmin(ctx, key));
    }
    b.command("admin", (ctx) => this.handleAdminMenu(ctx));
    b.action(/^admin:(.+)$/, (ctx) => {
      if (!this.allowed(ctx)) return;
      ctx.answerCbQuery().catch(() => {});
      this.handleAdmin(ctx, ctx.match[1]);
    });

    // ── Shell command execution (unrestricted) ──────────────────────────────────
    b.command("shell", (ctx) => this.handleShell(ctx));

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
      return ctx.reply("📋 No followed wallets.\n/add 0xADDRESS");
    const buttons = cfgs.map((c) => {
      const p = this.walletPnlSummary(c.wallet);
      const pnlTag =
        p.positions > 0
          ? ` ${p.totalPnl >= 0 ? "📈" : "📉"}${p.totalPnl >= 0 ? "+" : ""}$${p.totalPnl.toFixed(2)}`
          : "";
      return Markup.button.callback(
        `${c.enabled ? "🟢" : "⏸"} ${c.label || c.wallet.slice(0, 12) + "…"}${pnlTag}`,
        `cfg:${c.wallet}`,
      );
    });
    ctx.reply(`📋 *Wallets (${cfgs.length}):*\n\nTap to configure:`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons, { columns: 1 }),
    });
  }

  // Aggregate PnL across all positions sourced (even partly) from this wallet.
  // totalPnl is preferred; when prices haven't been refreshed yet, fall back
  // to legacy unrealizedPnl and then realizedPnl.
  private walletPnlSummary(wallet: string): {
    totalPnl: number;
    invested: number;
    positions: number;
    openPositions: number;
  } {
    const key = wallet.toLowerCase();
    let totalPnl = 0;
    let invested = 0;
    let positions = 0;
    let openPositions = 0;
    for (const pos of this.getPnL().getPositions()) {
      const sourceSet = new Set(pos.sourceWallets.map((w) => w.toLowerCase()));
      if (!sourceSet.has(key)) continue;
      positions++;
      if (pos.totalShares > 0) openPositions++;
      totalPnl += pos.totalPnl ?? pos.unrealizedPnl ?? pos.realizedPnl;
      invested += pos.totalSizeUsdc;
    }
    return { totalPnl, invested, positions, openPositions };
  }

  // ─── Wallet config panel ─────────────────────────────────────────────────────
  private showWalletConfig(ctx: Context, wallet: string) {
    const cfg = this.walletCfgs.get(wallet);
    if (!cfg) {
      this.replyTo(ctx, "❌ Wallet not found.");
      return;
    }

    const label = cfg.label ? `*${cfg.label}*\n` : "";
    const p = this.walletPnlSummary(wallet);
    const pnlLine =
      p.positions > 0
        ? `P&L: ${p.totalPnl >= 0 ? "📈 +" : "📉 "}$${p.totalPnl.toFixed(2)} ` +
          `_(invested $${p.invested.toFixed(2)} • ${p.openPositions}/${p.positions} open)_\n`
        : `P&L: _no copied trades yet_\n`;
    const text =
      `⚙️ ${label}\`${wallet}\`\n\n` +
      pnlLine +
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
      [
        Markup.button.url(
          "🔗 Open in Polymarket",
          `https://polymarket.com/profile/${wallet}`,
        ),
      ],
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
      return ctx.reply("❌ Invalid address.\n`/add 0xWALLET [Label]`", {
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
      return ctx.reply("Usage: /remove 0xWALLET");
    if (!this.walletCfgs.has(wallet))
      return ctx.reply(`❌ Wallet not followed: \`${wallet}\``, {
        parse_mode: "Markdown",
      });
    this.showRemoveConfirm(ctx, wallet);
  }

  // Confirmation panel — shows what will happen and offers options
  private showRemoveConfirm(ctx: Context, wallet: string) {
    const cfg = this.walletCfgs.get(wallet);
    const exposure = this.walletExposure(wallet);
    const label = cfg?.label ? `*${cfg.label}* — ` : "";
    const pnl = this.getPnL();
    const positions = pnl
      .getPositions()
      .filter((p) =>
        p.sourceWallets
          .map((w) => w.toLowerCase())
          .includes(wallet.toLowerCase()),
      );

    const text =
      `⚠️ *Remove wallet*\n\n` +
      `${label}\`${wallet}\`\n\n` +
      `• Copied trades: *${exposure.copiedTrades}*\n` +
      `• Tracked positions: *${positions.length}*\n` +
      `• Open orders placed by bot: *${exposure.placedOrderIds.length}*\n\n` +
      `*What do you want to do?*\n` +
      `_• "Just stop" → future trades won't be copied; all current orders/positions stay._\n` +
      `_• "Stop & Cancel orders" → also cancels open orders from this wallet (does not sell already-bought shares)._`;

    const buttons = [
      [Markup.button.callback("🛑 Just stop following", `rmkeep:${wallet}`)],
      [
        Markup.button.callback(
          `🗑 Stop & Cancel ${exposure.placedOrderIds.length} order(s)`,
          `rmcancel:${wallet}`,
        ),
      ],
      [Markup.button.callback("↩️ Cancel", `rmabort:${wallet}`)],
    ];

    this.editOrReply(ctx, text, Markup.inlineKeyboard(buttons));
  }

  // ─── Per-wallet field set ─────────────────────────────────────────────────────
  private handleWalletSet(
    ctx: Context,
    wallet: string,
    field: "multiplier" | "maxusdc" | "copyusdc" | "percent" | "label",
    value: string,
  ) {
    if (!this.allowed(ctx)) return;
    const validFields = [
      "multiplier",
      "maxusdc",
      "copyusdc",
      "percent",
      "label",
    ];
    if (!validFields.includes(field)) {
      return this.replyTo(
        ctx,
        `❌ Invalid field: \`${field}\`\nAllowed: ${validFields.join(", ")}`,
      );
    }
    if (!wallet || !this.walletCfgs.has(wallet)) {
      return this.replyTo(ctx, `❌ Wallet not found: \`${wallet}\``);
    }

    let patch: Partial<WalletConfig> = {};
    let display = "";

    if (field === "label") {
      patch = { label: value };
      display = `Label = "${value}"`;
    } else {
      const num = parseFloat(value);
      if (isNaN(num) || num < 0) return this.replyTo(ctx, "❌ Invalid value.");
      if (field === "multiplier") {
        patch = { sizeMultiplier: num, sizePercent: 0, copySizeUsdc: 0 }; // clear others
        display = `Multiplier = ${num}x (Fixed/% cleared)`;
      } else if (field === "maxusdc") {
        patch = { maxTradeUsdc: num };
        display = `Max USDC = $${num}`;
      } else if (field === "copyusdc") {
        patch = { copySizeUsdc: num, sizePercent: 0 }; // clear percent
        display =
          num > 0
            ? `Fixed size = $${num} (% mode cleared)`
            : "Fixed size disabled";
      } else if (field === "percent") {
        if (num < 0 || num > 100)
          return this.replyTo(ctx, "❌ Enter a number between 0 and 100.");
        patch = { sizePercent: num, copySizeUsdc: 0 }; // clear fixed size
        display =
          num > 0
            ? `${num}% of trader size (Fixed size cleared)`
            : "% mode disabled";
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
  private async handlePnl(ctx: Context, page = 0, forceRefresh = false) {
    if (!this.allowed(ctx)) return;
    const pnl = this.getPnL();
    // Pagination reuses cached prices (instant); only initial open / explicit
    // Refresh forces a network round-trip.
    await pnl.refreshPrices(forceRefresh);
    const positions = pnl.getPositions();
    if (positions.length === 0) {
      // Even with no positions show the balance so the user can see what
      // they're starting from (dry-run) or what's on-chain (live).
      let bLine = "";
      if (config.dryRun) {
        const b = pnl.getDryRunBalance(config.dryRunStartUsdc);
        bLine = `\n\n💰 Cash: *$${b.cash.toFixed(2)}* / Start $${b.startCash.toFixed(2)}`;
      } else {
        const live = await getLiveUsdcBalance();
        if (live) bLine = `\n\n💰 USDC: *$${live.balance.toFixed(2)}*`;
      }
      return this.editOrReply(
        ctx,
        "📊 No active positions." + bLine,
        this.refreshBtn("refresh:pnl"),
      );
    }

    // Build per-position formatted blocks + running totals.
    // Newest positions first so the freshest activity shows on page 1.
    const orderedPositions = [...positions].reverse();
    const items: string[] = [];
    let totalInvested = 0,
      totalPnlVal = 0;
    for (const pos of orderedPositions) {
      const pnlVal = pos.totalPnl ?? pos.unrealizedPnl ?? 0;
      const pnlPct = pos.totalPnlPct ?? pos.unrealizedPnlPct ?? 0;
      const arrow = pnlVal >= 0 ? "▲" : "▼";
      const q = (pos.question || pos.tokenId).slice(0, 40);
      const wallets = pos.sourceWallets
        .map((w) => w.slice(0, 10) + "…")
        .join(", ");
      items.push(
        `*${q}*\n` +
          `  ${wallets}\n` +
          `  ${pos.side} avg $${pos.avgPrice.toFixed(4)} → $${(pos.currentPrice ?? 0).toFixed(4)}\n` +
          `  $${pos.totalSizeUsdc.toFixed(2)} | ${arrow} ${pnlVal >= 0 ? "+" : ""}$${pnlVal.toFixed(4)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
      );
      totalInvested += pos.totalSizeUsdc;
      totalPnlVal += pnlVal;
    }
    const pct = totalInvested > 0 ? (totalPnlVal / totalInvested) * 100 : 0;
    // Balance line shown alongside totals on the last page only.
    let balanceLine = "";
    if (config.dryRun) {
      const b = pnl.getDryRunBalance(config.dryRunStartUsdc);
      const arrow = b.pnl >= 0 ? "▲" : "▼";
      balanceLine = `\n💰 Equity: *$${b.equity.toFixed(2)}* (cash $${b.cash.toFixed(2)} + holdings $${b.holdingsValue.toFixed(2)}) ${arrow} ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(2)}`;
    } else {
      const live = await getLiveUsdcBalance();
      if (live)
        balanceLine = `\n💰 USDC available: *$${live.balance.toFixed(2)}*`;
    }
    const totalLine = `─────────────────\n*TOTAL*: $${totalInvested.toFixed(2)} | ${totalPnlVal >= 0 ? "▲ +" : "▼ "}$${Math.abs(totalPnlVal).toFixed(4)} (${totalPnlVal >= 0 ? "+" : ""}${pct.toFixed(1)}%)${balanceLine}`;

    const pages = paginateItems(items);
    const safePage = Math.max(0, Math.min(page, pages.length - 1));
    const header = `📊 *P&L Summary* — page ${safePage + 1}/${pages.length}\n\n`;
    // TOTAL belongs only on the first page so the headline number is the
    // first thing the user sees; subsequent pages are just position details.
    const footer = safePage === 0 ? `\n\n${totalLine}` : "";
    const body = pages[safePage].join("\n\n");
    const msg = header + body + footer;
    this.editOrReply(
      ctx,
      msg,
      this.pageNav("pnl", safePage, pages.length, "refresh:pnl"),
    );
  }

  // ─── Daily P&L per wallet ───────────────────────────────────────────────────
  private async handleDaily(
    ctx: Context,
    allDays: boolean,
    forceRefresh = false,
  ) {
    if (!this.allowed(ctx)) return;
    const pnl = this.getPnL();
    await pnl.refreshPrices(forceRefresh);
    const records = pnl.getDailyByWallet(allDays);

    if (records.length === 0) {
      return this.editOrReply(
        ctx,
        allDays ? "📅 No recorded days." : "📅 No trades for today.",
        this.refreshBtn("refresh:daily"),
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

    msg += `_/daily — today only | /dailyall — all days_`;
    this.editOrReply(ctx, msg, this.refreshBtn("refresh:daily"));
  }

  // ─── History ──────────────────────────────────────────────────────────────────
  private handleHistory(ctx: Context, n: number | undefined, page = 0) {
    if (!this.allowed(ctx)) return;
    const history = this.getHistory();
    if (history.length === 0)
      return this.editOrReply(
        ctx,
        "📜 No history.",
        this.refreshBtn("refresh:history"),
      );
    const icons: Record<string, string> = {
      PLACED: "✅",
      FAILED: "❌",
      SKIPPED: "⏭️",
      DRY_RUN: "🔵",
    };
    // If n is supplied, take only the most recent n; otherwise show full
    // history. Always reverse so newest is first.
    const subset = n ? history.slice(-n) : history.slice();
    subset.reverse();

    const items: string[] = subset.map((t) => {
      const trade = t.originalTrade;
      const time = new Date(t.timestamp).toLocaleTimeString("bg-BG");
      let block = `${icons[t.status] || "?"} *${t.status}* — ${time}\n`;
      block += `  ${trade.side} $${trade.size.toFixed(2)} @ ${trade.price}`;
      if (t.orderId) block += `\n  \`${t.orderId}\``;
      if (t.reason) block += `\n  _${t.reason}_`;
      return block;
    });

    const pages = paginateItems(items);
    const safePage = Math.max(0, Math.min(page, pages.length - 1));
    const totalLabel = n ? `last ${subset.length}` : `all ${subset.length}`;
    const header = `📜 *History (${totalLabel})* — page ${safePage + 1}/${pages.length}\n\n`;
    const msg = header + pages[safePage].join("\n\n");
    this.editOrReply(
      ctx,
      msg,
      this.pageNav("history", safePage, pages.length, "refresh:history"),
    );
  }

  // Build a pagination keyboard: ◀ Prev | N/M | Next ▶ | 🔄 Refresh
  private pageNav(
    kind: string,
    page: number,
    total: number,
    refreshAction: string,
  ) {
    const row: any[] = [];
    if (total > 1) {
      row.push(
        Markup.button.callback(
          page > 0 ? "◀" : "·",
          page > 0 ? `pg:${kind}:${page - 1}` : "noop",
        ),
      );
      row.push(Markup.button.callback(`${page + 1}/${total}`, "noop"));
      row.push(
        Markup.button.callback(
          page < total - 1 ? "▶" : "·",
          page < total - 1 ? `pg:${kind}:${page + 1}` : "noop",
        ),
      );
    }
    const refreshRow = [Markup.button.callback("🔄 Refresh", refreshAction)];
    return Markup.inlineKeyboard(total > 1 ? [row, refreshRow] : [refreshRow]);
  }

  // ─── Orders ──────────────────────────────────────────────────────────────────
  private async handleOrders(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const isCallback =
      "callbackQuery" in ctx && (ctx as any).callbackQuery != null;
    // Only show the "loading" hint on the first invocation, not on refresh
    // (refresh edits the existing message in place).
    if (!isCallback) {
      await ctx.reply("⏳ Loading active orders…", {
        parse_mode: "Markdown",
      });
    }
    const orders = await this.getOrders();
    if (orders.length === 0) {
      return this.editOrReply(
        ctx,
        "📂 No active orders.",
        this.refreshBtn("refresh:orders"),
      );
    }

    const sides: Record<string, string> = { BUY: "🟢 BUY", SELL: "🔴 SELL" };
    let msg = `📂 *Active orders (${orders.length}):*\n\n`;
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
  private async handleStatus(ctx: Context) {
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
        : "  (none)";

    // Wallet-balance block — virtual in dry-run, on-chain USDC in live mode.
    let balanceBlock = "";
    if (config.dryRun) {
      // Reuse cached prices so opening Status is instant.
      await this.getPnL().refreshPrices();
      const b = this.getPnL().getDryRunBalance(config.dryRunStartUsdc);
      const arrow = b.pnl >= 0 ? "▲" : "▼";
      balanceBlock =
        `\n💰 *Virtual balance* (dry-run)\n` +
        `  Start: $${b.startCash.toFixed(2)} | Cash: $${b.cash.toFixed(2)} | Holdings: $${b.holdingsValue.toFixed(2)}\n` +
        `  Equity: *$${b.equity.toFixed(2)}* ${arrow} ${b.pnl >= 0 ? "+" : ""}$${b.pnl.toFixed(2)} (${b.pnl >= 0 ? "+" : ""}${b.pnlPct.toFixed(1)}%)\n`;
    } else {
      const live = await getLiveUsdcBalance();
      if (live) {
        balanceBlock =
          `\n💰 *Polymarket collateral (USDC)*\n` +
          `  \`${live.address.slice(0, 10)}…${live.address.slice(-4)}\`\n` +
          `  Available: *$${live.balance.toFixed(2)}*\n`;
      } else {
        balanceBlock = `\n💰 *Polymarket collateral (USDC)*: _unavailable_\n`;
      }
    }

    this.editOrReply(
      ctx,
      `ℹ️ *Bot Status*\n\n` +
        `🟢 Running | Dry: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}\n` +
        `Poll: ${config.pollIntervalMs / 1000}s\n` +
        balanceBlock +
        `\n*Wallets (${cfgs.length}):*\n${wList}\n\n` +
        `✅ ${placed} | ❌ ${failed} | 📦 ${history.length}`,
      this.refreshBtn("refresh:status"),
    );
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────
  private handleSettings(ctx: Context) {
    if (!this.allowed(ctx)) return;
    ctx.reply(
      `⚙️ *Global Settings*\n\n` +
        `Dry run: ${config.dryRun ? "🔵 ON" : "🔴 OFF"}\n` +
        `Weather: ${config.weather.enabled ? "🟢 ON" : "⏸ OFF"}\n` +
        `Order type: \`${config.orderType}\`\n` +
        `Poll: \`${config.pollIntervalMs / 1000}s\`\n` +
        `Min trade: \`$${config.minTradeUsdc}\`\n\n` +
        `Per-wallet: /wallets → pick wallet\n\n` +
        `/dryrun on|off | /weather on|off | /weathercfg | /debug`,
      { parse_mode: "Markdown" },
    );
  }

  // ─── Debug ────────────────────────────────────────────────────────────────────
  private handleDebug(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const d = this.getDebug();
    const fmtAgo = (s: number) =>
      s < 0
        ? "—"
        : s < 60
          ? `${s}s`
          : s < 3600
            ? `${Math.floor(s / 60)}m`
            : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;

    let msg =
      `🛠 *Debug*\n\n` +
      `Running: ${d.running ? "🟢" : "🔴"} | Dry: ${d.dryRun ? "🔵 ON" : "🔴 OFF"}\n` +
      `OrderType: \`${d.orderType}\` | Min: \`$${d.minTradeUsdc}\` | Poll: \`${d.pollIntervalMs / 1000}s\`\n` +
      `History: ${d.historySize}\n\n` +
      `*Watchers (${d.watchers.length}):*\n`;

    if (d.watchers.length === 0) {
      msg += "_(no wallets)_";
    } else {
      for (const w of d.watchers) {
        const label =
          this.walletCfgs.get(w.wallet)?.label || w.wallet.slice(0, 12) + "…";
        msg +=
          `\n*${label}*\n` +
          `  seeded: ${w.seeded ? "✅" : "❌"} | seen: ${w.seenCount}\n` +
          `  last trade: ${fmtAgo(w.lastTsAgoSec)} ago | last poll: ${fmtAgo(w.lastPollAgoSec)} ago\n` +
          `  fetched: ${w.fetched} | new: ${w.newDetected}\n`;
      }
    }

    if (
      d.watchers.every((w: any) => w.newDetected === 0) &&
      d.watchers.length > 0
    ) {
      msg +=
        `\n_💡 No wallet has made a new trade since the bot started. ` +
        `If you expect activity — check them manually on polymarket.com._`;
    }

    this.editOrReply(ctx, msg, this.refreshBtn("refresh:debug"));
  }

  // ─── Reset prompt ─────────────────────────────────────────────────────────
  private handleResetPrompt(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const historyCount = this.getHistory().length;
    const dailyCount = this.getPnL().getDailyByWallet(true).length;
    const positions = this.getPnL().getPositions().length;
    const wallets = this.walletCfgs.getAll().length;
    const text =
      `🧹 *Reset bot data?*\n\n` +
      `This will clear:\n` +
      `• Copy history: *${historyCount}* entr(ies)\n` +
      `• Daily P&L records: *${dailyCount}*\n` +
      `• Tracked positions: *${positions}*\n` +
      `• Equity / totals / dry-run cashflow → reset to start\n\n` +
      `Kept untouched:\n` +
      `• Followed wallets: *${wallets}* (use /remove to delete)\n` +
      `• On-chain orders & balances on Polymarket (live mode)\n\n` +
      `_Works in both dry-run and live mode — only the bot's internal_\n` +
      `_view is cleared._`;
    const buttons = [
      [Markup.button.callback("✅ Yes, clear history", "reset:confirm")],
      [Markup.button.callback("↩️ Cancel", "reset:abort")],
    ];
    this.replyTo(ctx, text, Markup.inlineKeyboard(buttons));
  }

  // ─── Weather predictions ──────────────────────────────────────────────────────
  private async handleWeather(ctx: Context) {
    if (!this.allowed(ctx)) return;
    if (!this.weatherReport) {
      return this.editOrReply(
        ctx,
        "🌦 *Weather module disabled.*\n\n" +
          "Enable it with `/weather on` or set `WEATHER_ENABLED=true` in env.",
      );
    }
    try {
      const text = await this.weatherReport();
      this.editOrReply(ctx, text, this.refreshBtn("refresh:weather"));
    } catch (err: any) {
      this.editOrReply(ctx, `❌ Weather report failed: ${err?.message ?? err}`);
    }
  }

  private weatherConfigSummary(): string {
    const w = config.weather;
    return (
      `🌦 *Weather config*\n\n` +
      `WEATHER_ENABLED=\`${w.enabled}\`\n` +
      `WEATHER_MIN_EDGE=\`${w.minEdge}\`\n` +
      `WEATHER_MIN_PRICE=\`${w.minPrice}\`\n` +
      `WEATHER_MAX_PRICE=\`${w.maxPrice}\`\n` +
      `WEATHER_MIN_LIQUIDITY_USDC=\`${w.minLiquidityUsdc}\`\n` +
      `WEATHER_MAX_LIQUIDITY_FRACTION=\`${w.maxLiquidityFraction}\`\n` +
      `WEATHER_MIN_LEAD_DAYS=\`${w.minLeadDays}\`\n` +
      `WEATHER_SPREAD_INFLATION=\`${w.spreadInflation}\`\n` +
      `WEATHER_KDE_BANDWIDTH_F=\`${w.kdeBandwidthF}\`\n` +
      `WEATHER_KDE_LEAD_PER_DAY_F=\`${w.kdeLeadPerDayF}\`\n` +
      `WEATHER_SCAN_INTERVAL_MS=\`${w.scanIntervalMs}\`\n` +
      `WEATHER_MAX_TRADES_PER_SCAN=\`${w.maxTradesPerScan}\`\n` +
      `WEATHER_MAX_TRADES_PER_DAY=\`${w.maxTradesPerDay}\`\n` +
      `WEATHER_MODELS=\`${w.models}\`\n\n` +
      `_Runtime only: values are not persisted to .env automatically._\n` +
      `Usage:\n` +
      `/weather on|off\n` +
      `/weathercfg WEATHER_MIN_PRICE 0.03`
    );
  }

  private applyWeatherConfig(
    keyRaw: string,
    valueRaw: string,
  ): { ok: boolean; msg: string } {
    const key = keyRaw.trim().toUpperCase();
    const normalized = key.startsWith("WEATHER_") ? key.slice(8) : key;
    const w: WeatherConfig = config.weather;

    const parseNum = (): number | null => {
      const n = Number(valueRaw);
      return Number.isFinite(n) ? n : null;
    };
    const parseIntNum = (): number | null => {
      const n = Number(valueRaw);
      return Number.isInteger(n) ? n : null;
    };

    switch (normalized) {
      case "ENABLED": {
        const b = parseBool(valueRaw);
        if (b === undefined) {
          return {
            ok: false,
            msg: "Invalid boolean. Use true/false or on/off.",
          };
        }
        w.enabled = b;
        return { ok: true, msg: `WEATHER_ENABLED=${b}` };
      }
      case "MIN_EDGE": {
        const n = parseNum();
        if (n == null || n < 0 || n > 1) {
          return {
            ok: false,
            msg: "WEATHER_MIN_EDGE must be between 0 and 1.",
          };
        }
        w.minEdge = n;
        return { ok: true, msg: `WEATHER_MIN_EDGE=${n}` };
      }
      case "MIN_PRICE": {
        const n = parseNum();
        if (n == null || n < 0 || n > 1) {
          return {
            ok: false,
            msg: "WEATHER_MIN_PRICE must be between 0 and 1.",
          };
        }
        w.minPrice = n;
        return { ok: true, msg: `WEATHER_MIN_PRICE=${n}` };
      }
      case "MAX_PRICE": {
        const n = parseNum();
        if (n == null || n < 0 || n > 1) {
          return {
            ok: false,
            msg: "WEATHER_MAX_PRICE must be between 0 and 1.",
          };
        }
        w.maxPrice = n;
        return { ok: true, msg: `WEATHER_MAX_PRICE=${n}` };
      }
      case "MIN_LIQUIDITY_USDC": {
        const n = parseNum();
        if (n == null || n < 0) {
          return { ok: false, msg: "WEATHER_MIN_LIQUIDITY_USDC must be >= 0." };
        }
        w.minLiquidityUsdc = n;
        return { ok: true, msg: `WEATHER_MIN_LIQUIDITY_USDC=${n}` };
      }
      case "MAX_LIQUIDITY_FRACTION":
      case "MAX_LIQ_FRACTION": {
        const n = parseNum();
        if (n == null || n < 0 || n > 1) {
          return {
            ok: false,
            msg: "WEATHER_MAX_LIQUIDITY_FRACTION must be between 0 and 1.",
          };
        }
        w.maxLiquidityFraction = n;
        return { ok: true, msg: `WEATHER_MAX_LIQUIDITY_FRACTION=${n}` };
      }
      case "MIN_LEAD_DAYS": {
        const n = parseIntNum();
        if (n == null || n < 0) {
          return {
            ok: false,
            msg: "WEATHER_MIN_LEAD_DAYS must be an integer >= 0.",
          };
        }
        w.minLeadDays = n;
        return { ok: true, msg: `WEATHER_MIN_LEAD_DAYS=${n}` };
      }
      case "SPREAD_INFLATION": {
        const n = parseNum();
        if (n == null || n < 1) {
          return { ok: false, msg: "WEATHER_SPREAD_INFLATION must be >= 1." };
        }
        w.spreadInflation = n;
        return { ok: true, msg: `WEATHER_SPREAD_INFLATION=${n}` };
      }
      case "KDE_BANDWIDTH_F": {
        const n = parseNum();
        if (n == null || n < 0) {
          return { ok: false, msg: "WEATHER_KDE_BANDWIDTH_F must be >= 0." };
        }
        w.kdeBandwidthF = n;
        return { ok: true, msg: `WEATHER_KDE_BANDWIDTH_F=${n}` };
      }
      case "KDE_LEAD_PER_DAY_F": {
        const n = parseNum();
        if (n == null || n < 0) {
          return { ok: false, msg: "WEATHER_KDE_LEAD_PER_DAY_F must be >= 0." };
        }
        w.kdeLeadPerDayF = n;
        return { ok: true, msg: `WEATHER_KDE_LEAD_PER_DAY_F=${n}` };
      }
      case "SCAN_INTERVAL_MS": {
        const n = parseIntNum();
        if (n == null || n < 1000) {
          return {
            ok: false,
            msg: "WEATHER_SCAN_INTERVAL_MS must be an integer >= 1000.",
          };
        }
        w.scanIntervalMs = n;
        return { ok: true, msg: `WEATHER_SCAN_INTERVAL_MS=${n}` };
      }
      case "MAX_TRADES_PER_SCAN": {
        const n = parseIntNum();
        if (n == null || n < 0) {
          return {
            ok: false,
            msg: "WEATHER_MAX_TRADES_PER_SCAN must be an integer >= 0.",
          };
        }
        w.maxTradesPerScan = n;
        return { ok: true, msg: `WEATHER_MAX_TRADES_PER_SCAN=${n}` };
      }
      case "MAX_TRADES_PER_DAY": {
        const n = parseIntNum();
        if (n == null || n < 0) {
          return {
            ok: false,
            msg: "WEATHER_MAX_TRADES_PER_DAY must be an integer >= 0.",
          };
        }
        w.maxTradesPerDay = n;
        return { ok: true, msg: `WEATHER_MAX_TRADES_PER_DAY=${n}` };
      }
      case "MODELS": {
        const models = valueRaw
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
          .join(",");
        if (!models) {
          return { ok: false, msg: "WEATHER_MODELS cannot be empty." };
        }
        w.models = models;
        return { ok: true, msg: `WEATHER_MODELS=${models}` };
      }
      default:
        return {
          ok: false,
          msg: "Unsupported key. Use one of: WEATHER_ENABLED, WEATHER_MIN_EDGE, WEATHER_MIN_PRICE, WEATHER_MAX_PRICE, WEATHER_MIN_LIQUIDITY_USDC, WEATHER_MAX_LIQUIDITY_FRACTION, WEATHER_MIN_LEAD_DAYS, WEATHER_SPREAD_INFLATION, WEATHER_KDE_BANDWIDTH_F, WEATHER_KDE_LEAD_PER_DAY_F, WEATHER_SCAN_INTERVAL_MS, WEATHER_MAX_TRADES_PER_SCAN, WEATHER_MAX_TRADES_PER_DAY, WEATHER_MODELS.",
        };
    }
  }

  private exitConfigSummary(): string {
    const w = config.weather;
    return (
      `🚪 *Weather exit config*\n\n` +
      `WEATHER_EXIT_ENABLED=\`${w.exitEnabled}\`\n` +
      `WEATHER_EXIT_PROFIT_TARGET=\`${w.exitProfitTarget}\`\n` +
      `WEATHER_EXIT_STOP_LOSS=\`${w.exitStopLoss}\`\n` +
      `WEATHER_EXIT_MIN_HOURS_HELD=\`${w.exitMinHoursHeld}\`\n` +
      `WEATHER_EXIT_SCAN_INTERVAL_MS=\`${w.exitScanIntervalMs}\`\n\n` +
      `WEATHER_EXIT_TREND_ENABLED=\`${w.exitTrendEnabled}\`\n` +
      `WEATHER_EXIT_TREND_DROP_FROM_PEAK=\`${w.exitTrendDropFromPeak}\`\n` +
      `WEATHER_EXIT_TREND_MIN_PROFIT=\`${w.exitTrendMinProfit}\`\n\n` +
      `_Runtime only: values are not persisted to .env automatically._\n` +
      `Usage:\n` +
      `/exit on|off\n` +
      `/exitall — liquidate all positions NOW\n` +
      `/exitcfg WEATHER_EXIT_PROFIT_TARGET 0.75`
    );
  }

  private applyExitConfig(
    keyRaw: string,
    valueRaw: string,
  ): { ok: boolean; msg: string } {
    const key = keyRaw.trim().toUpperCase();
    const normalized = key.startsWith("WEATHER_") ? key.slice(8) : key;
    const w: WeatherConfig = config.weather;

    const parseNum = (): number | null => {
      const n = Number(valueRaw);
      return Number.isFinite(n) ? n : null;
    };
    const parseIntNum = (): number | null => {
      const n = Number(valueRaw);
      return Number.isInteger(n) ? n : null;
    };

    switch (normalized) {
      case "EXIT_ENABLED": {
        const b = parseBool(valueRaw);
        if (b === undefined) {
          return {
            ok: false,
            msg: "Invalid boolean. Use true/false or on/off.",
          };
        }
        w.exitEnabled = b;
        return { ok: true, msg: `WEATHER_EXIT_ENABLED=${b}` };
      }
      case "EXIT_PROFIT_TARGET": {
        const n = parseNum();
        if (n == null || n < 0 || n > 10) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_PROFIT_TARGET must be between 0 and 10 (as a fraction).",
          };
        }
        w.exitProfitTarget = n;
        return {
          ok: true,
          msg: `WEATHER_EXIT_PROFIT_TARGET=${(n * 100).toFixed(1)}%`,
        };
      }
      case "EXIT_STOP_LOSS": {
        const n = parseNum();
        if (n == null || n > 0 || n < -10) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_STOP_LOSS must be between -10 and 0 (as a fraction).",
          };
        }
        w.exitStopLoss = n;
        return {
          ok: true,
          msg: `WEATHER_EXIT_STOP_LOSS=${(n * 100).toFixed(1)}%`,
        };
      }
      case "EXIT_MIN_HOURS_HELD": {
        const n = parseNum();
        if (n == null || n < 0) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_MIN_HOURS_HELD must be >= 0.",
          };
        }
        w.exitMinHoursHeld = n;
        return { ok: true, msg: `WEATHER_EXIT_MIN_HOURS_HELD=${n}h` };
      }
      case "EXIT_SCAN_INTERVAL_MS": {
        const n = parseIntNum();
        if (n == null || n < 1000) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_SCAN_INTERVAL_MS must be an integer >= 1000.",
          };
        }
        w.exitScanIntervalMs = n;
        return { ok: true, msg: `WEATHER_EXIT_SCAN_INTERVAL_MS=${n}ms` };
      }
      case "EXIT_TREND_ENABLED": {
        const b = parseBool(valueRaw);
        if (b === undefined) {
          return {
            ok: false,
            msg: "Invalid boolean. Use true/false or on/off.",
          };
        }
        w.exitTrendEnabled = b;
        return { ok: true, msg: `WEATHER_EXIT_TREND_ENABLED=${b}` };
      }
      case "EXIT_TREND_DROP_FROM_PEAK": {
        const n = parseNum();
        if (n == null || n < 0 || n > 1) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_TREND_DROP_FROM_PEAK must be between 0 and 1 (as a fraction).",
          };
        }
        w.exitTrendDropFromPeak = n;
        return {
          ok: true,
          msg: `WEATHER_EXIT_TREND_DROP_FROM_PEAK=${(n * 100).toFixed(1)}%`,
        };
      }
      case "EXIT_TREND_MIN_PROFIT": {
        const n = parseNum();
        if (n == null || n < 0 || n > 10) {
          return {
            ok: false,
            msg: "WEATHER_EXIT_TREND_MIN_PROFIT must be between 0 and 10 (as a fraction).",
          };
        }
        w.exitTrendMinProfit = n;
        return {
          ok: true,
          msg: `WEATHER_EXIT_TREND_MIN_PROFIT=${(n * 100).toFixed(1)}%`,
        };
      }
      default:
        return {
          ok: false,
          msg: "Unsupported key. Use one of: EXIT_ENABLED, EXIT_PROFIT_TARGET, EXIT_STOP_LOSS, EXIT_MIN_HOURS_HELD, EXIT_SCAN_INTERVAL_MS, EXIT_TREND_ENABLED, EXIT_TREND_DROP_FROM_PEAK, EXIT_TREND_MIN_PROFIT.",
        };
    }
  }

  // ─── Help ─────────────────────────────────────────────────────────────────────
  private handleHelp(ctx: Context) {
    if (!this.allowed(ctx)) return;
    ctx.reply(
      `*Commands:*\n\n` +
        `/wallets — list + per-wallet settings\n` +
        `/add 0x... [Label] — add wallet\n` +
        `/remove 0x... — remove wallet\n\n` +
        `*Per-wallet:*\n` +
        `/wset 0x... multiplier 0.5\n` +
        `/wset 0x... maxusdc 50\n` +
        `/wset 0x... copyusdc 10\n` +
        `/wset 0x... percent 50\n` +
        `/wset 0x... label "Whale #1"\n\n` +
        `/pnl | /history [n] | /status\n` +
        `/retry 0x... — force copy latest trade once\n` +
        `/orders — active orders\n` +
        `/weather — report, or /weather on|off\n` +
        `/weathercfg [KEY VALUE] — show/set weather runtime config\n` +
        `/exit — auto-exit toggle\n` +
        `/exitall — liquidate all positions immediately\n` +
        `/exitcfg [KEY VALUE] — show/set exit config\n` +
        `/debug — watcher diagnostics\n` +
        `/reset — clear history (keeps wallets+positions)\n` +
        `/dryrun on|off | /settings\n\n` +
        `*Admin (server):*\n` +
        `/admin — button menu\n` +
        `/pull /reload /restart /deploy\n` +
        `/applogs /apperrors /pm2list\n` +
        `/gitstatus /gitlog /uptime /disk\n` +
        `/shell <command> — ⚠️ unrestricted shell`,
      { parse_mode: "Markdown" },
    );
  }

  // ─── Admin: whitelisted shell commands ───────────────────────────────────────
  private handleAdminMenu(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const buttons = Object.entries(ADMIN_COMMANDS).map(([key, cmd]) =>
      Markup.button.callback(cmd.label, `admin:${key}`),
    );
    ctx.reply("🛠 *Admin*\n\nChoose a command:", {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons, { columns: 1 }),
    });
  }

  private async handleAdmin(ctx: Context, key: string) {
    if (!this.allowed(ctx)) return;
    const cmd = ADMIN_COMMANDS[key];
    if (!cmd) {
      this.replyTo(ctx, `❌ Unknown command: \`${key}\``);
      return;
    }
    await this.replyTo(ctx, `⏳ Running: *${cmd.label}*`);
    const output = await runAdminCmd(cmd);
    // Telegram message limit is 4096 chars; keep room for the code fence.
    const MAX = 3800;
    const truncated =
      output.length > MAX
        ? output.slice(0, MAX) + `\n…(+${output.length - MAX} chars truncated)`
        : output;
    // Send as plain text (no Markdown) to avoid parsing issues with shell output.
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    await this.bot.telegram.sendMessage(chatId, "```\n" + truncated + "\n```", {
      parse_mode: "Markdown",
    } as any);
    // If this command (or any of its steps) restarts the bot itself, let the
    // user know — the next thing they'll see is the startup message from the
    // freshly-spawned process.
    const willRestart =
      cmd.detached || (cmd.then ?? []).some((s) => s.detached);
    if (willRestart) {
      await this.bot.telegram
        .sendMessage(
          chatId,
          "♻️ pm2 reload launched detached — the bot will restart shortly.",
        )
        .catch(() => {});
    }
  }

  // ─── Shell: unrestricted command execution ───────────────────────────────────
  private async handleShell(ctx: Context) {
    if (!this.allowed(ctx)) return;
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const commandText = text.replace(/^\/shell\s*/, "").trim();

    if (!commandText) {
      this.replyTo(
        ctx,
        `🔧 *Shell Command Executor*\n\n` +
          `Usage: \`/shell <command>\`\n\n` +
          `Examples:\n` +
          `\`/shell ls -la\`\n` +
          `\`/shell df -h\`\n` +
          `\`/shell ps aux | grep node\`\n\n` +
          `⚠️ *Warning:* Commands run with shell=true, unrestricted.`,
      );
      return;
    }

    await this.replyTo(ctx, `⏳ Executing: \`${commandText}\``);

    try {
      const output = await this.executeShellCommand(commandText);
      // Telegram message limit is 4096 chars; keep room for the code fence.
      const MAX = 3800;
      const truncated =
        output.length > MAX
          ? output.slice(0, MAX) +
            `\n…(+${output.length - MAX} chars truncated)`
          : output;

      const chatId = ctx.chat?.id;
      if (!chatId) return;

      await this.bot.telegram.sendMessage(
        chatId,
        "```\n" + (truncated || "(no output)") + "\n```",
        { parse_mode: "Markdown" } as any,
      );
    } catch (err: any) {
      this.replyTo(ctx, `❌ Error: ${err?.message ?? String(err)}`);
    }
  }

  private executeShellCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          cwd: APP_DIR,
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
          env: process.env,
        },
        (err: any, stdout: string, stderr: string) => {
          const output = `${stdout || ""}${stderr ? "\n" + stderr : ""}`.trim();
          if (err) {
            resolve(
              `${output}\n[exit ${err.code ?? "?"}] ${err.message}`.trim(),
            );
          } else {
            resolve(output || "(no output)");
          }
        },
      );
    });
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
    reason?: string,
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
      (reason ? `\n_${reason.slice(0, 300)}_` : "") +
      (orderId ? `\n\`${orderId}\`` : "");
    await this.send(msg);
  }

  async notifyError(msg: string) {
    await this.send(`⚠️ *Error*\n\n${msg}`);
  }

  async send(text: string) {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.sendChunk(Number(this.allowedChatId), chunk, {
        parse_mode: "Markdown",
      });
    }
  }

  async launch() {
    // Belt-and-suspenders: if a webhook was ever set on this bot token (manually
    // or by a previous deploy), getUpdates polling silently returns nothing and
    // the bot looks "alive" (outgoing notifications work) but never reacts to
    // /menu, /status, etc. Force-clear it before launching the polling loop.
    try {
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (err: any) {
      console.warn(
        `[Telegram] deleteWebhook failed (continuing): ${err?.message ?? err}`,
      );
    }

    // Register the slash-command list shown in Telegram's native "Menu" /
    // command-suggestion popup (the blue button next to the input field).
    // Without this the user has to remember every command verbatim.
    try {
      await this.bot.telegram.setMyCommands([
        { command: "menu", description: "Main menu" },
        { command: "wallets", description: "List & configure wallets" },
        { command: "add", description: "Add wallet: /add 0x... [Label]" },
        { command: "remove", description: "Remove wallet: /remove 0x..." },
        { command: "pnl", description: "P&L summary" },
        { command: "daily", description: "Today's P&L per wallet" },
        { command: "dailyall", description: "All-days P&L per wallet" },
        { command: "history", description: "Copy history" },
        { command: "orders", description: "Active orders" },
        { command: "status", description: "Bot status" },
        { command: "retry", description: "Force-copy latest trade once" },
        { command: "weather", description: "Weather report or on/off" },
        { command: "weathercfg", description: "Show/set weather config" },
        { command: "settings", description: "Global settings" },
        { command: "debug", description: "Watcher diagnostics" },
        { command: "dryrun", description: "Toggle dry-run: /dryrun on|off" },
        { command: "reset", description: "Reset history & P&L data" },
        { command: "admin", description: "Admin shell menu" },
        { command: "shell", description: "⚠️ Execute shell command" },
        { command: "help", description: "Show help" },
      ]);
      // Make the left-of-input button open the commands menu (instead of the
      // default "web app" button), so tapping it reveals the list above.
      await this.bot.telegram.setChatMenuButton({
        menuButton: { type: "commands" },
      });
    } catch (err: any) {
      console.warn(
        `[Telegram] setMyCommands/setChatMenuButton failed: ${err?.message ?? err}`,
      );
    }

    // dropPendingUpdates: discard everything queued on Telegram's servers
    // while the bot was offline. Without this, restarting the bot replays
    // every /reload, /restart, etc. that piled up — causing "ghost" command
    // executions on startup.
    await this.bot.launch({ dropPendingUpdates: true });
    console.log("[Telegram] Bot started ✅");
  }
  stop() {
    this.bot.stop();
  }
}
