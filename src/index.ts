import { config } from "./config";
import { setupProxy, verifyProxy } from "./proxy";
import { TelegramBot } from "./telegram";
import { CopyTrader } from "./watcher";
import { initTrader } from "./trader";
import { WeatherEngine } from "./weather/engine";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launchTelegramOrThrow(tg: TelegramBot) {
  const maxAttempts = 6;
  const retryMs = 5000;
  let lastErr: unknown;

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await tg.launch();
      console.log(`[Telegram] polling active (attempt ${i}/${maxAttempts})`);
      return;
    } catch (err) {
      lastErr = err;
      const msg = (err as any)?.message ?? String(err);
      console.error(
        `[Telegram] launch failed (attempt ${i}/${maxAttempts}): ${msg}`,
      );
      if (i < maxAttempts) await sleep(retryMs);
    }
  }

  throw new Error(
    `Telegram launch failed after ${maxAttempts} attempts: ${String((lastErr as any)?.message ?? lastErr)}`,
  );
}

async function main() {
  // Apply WARP SOCKS5 proxy before any network calls
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
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

  // 3. Launch Telegram bot AFTER register() is called.
  // Fail fast if polling can't start, so PM2 restarts instead of running
  // in a "watcher alive, Telegram deaf" state.
  await launchTelegramOrThrow(tg);

  // Give Telegram a moment to connect before polling starts
  await new Promise((r) => setTimeout(r, 1500));

  // 4. Weather prediction + auto-trading engine (independent loop).
  // It stays alive in standby when disabled, so Telegram can enable it later
  // without requiring a process restart.
  const weather = new WeatherEngine(tg, {
    getOrders: async () => {
      try {
        const { getOpenOrders } = await import("./trader");
        return await getOpenOrders();
      } catch {
        return [];
      }
    },
  });
  tg.setWeatherReportProvider(() => weather.getReport());
  tg.setWeatherEngine(weather);
  weather
    .start()
    .catch((err: Error) =>
      console.error("[Weather] engine error:", err.message),
    );

  process.on("SIGINT", async () => {
    console.log("\n\n[Main] Shutting down...");
    bot.stop();
    weather.stop();
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
