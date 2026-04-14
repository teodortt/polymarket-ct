import { config } from "./config";
import { setupProxy } from "./proxy";
import { TelegramBot } from "./telegram";
import { CopyTrader } from "./watcher";
import { initTrader } from "./trader";

async function main() {
  // Apply WARP SOCKS5 proxy before any network calls
  if (config.proxyUrl) setupProxy(config.proxyUrl);
  console.log("=".repeat(50));
  console.log("   Polymarket CopyBot + Telegram");
  console.log("=".repeat(50));

  if (config.dryRun) {
    console.log("\n⚠️  DRY RUN MODE — no real orders.\n");
  } else {
    console.log("\n🔴 LIVE MODE — real orders!\n");
    await initTrader();
  }

  // 1. Create TelegramBot instance
  const tg = new TelegramBot();

  // 2. Create CopyTrader — calls tg.register() internally (BEFORE launch)
  const bot = new CopyTrader(config.targetWallets, tg);

  // 3. Launch Telegram bot AFTER register() is called
  // In Telegraf v4, launch() blocks until the bot stops — do NOT await
  tg.launch().catch((err: Error) =>
    console.error("[Telegram] Launch error:", err.message),
  );

  // Give Telegram a moment to connect before polling starts
  await new Promise((r) => setTimeout(r, 1500));

  process.on("SIGINT", async () => {
    console.log("\n\n[Main] Shutting down...");
    bot.stop();
    await tg.send("🛑 CopyBot stopped.");
    tg.stop();
    const history = bot.getHistory();
    const byStatus = history.reduce(
      (acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    console.log(`\n📊 Session: ${history.length} trades`);
    Object.entries(byStatus).forEach(([k, v]) => console.log(`   ${k}: ${v}`));
    process.exit(0);
  });

  await bot.start();
}

main().catch((err) => {
  console.error("[Fatal]", err.message);
  process.exit(1);
});
