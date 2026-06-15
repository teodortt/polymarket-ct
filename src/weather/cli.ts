import { config } from "../config";
import { setupProxy, verifyProxy } from "../proxy";
import { WeatherEngine } from "./engine";
import { formatReport } from "./report";

// Read-only weather scan: discovers temperature markets, builds the ensemble
// forecast for each, and prints the model-vs-market edge — WITHOUT placing any
// orders. Handy for validating the prediction logic before going live.
//   npm run weather:scan
async function main() {
  if (config.proxyUrl) {
    await setupProxy(config.proxyUrl);
    await verifyProxy();
  }
  console.log("🌦 Weather scan (read-only — no orders will be placed)\n");

  const engine = new WeatherEngine();
  const signals = await engine.scanOnce({ place: false });

  console.log(
    "\n" +
      formatReport(signals, engine.recentTrades(10), {
        markdown: false,
        lastScanAt: Date.now(),
      }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[Weather] scan failed:", err?.message ?? err);
  process.exit(1);
});
