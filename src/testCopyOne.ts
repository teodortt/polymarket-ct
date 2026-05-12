import { getTradesForWallet } from "./polymarketApi";
import { copyTradeWithSize } from "./trader";

function usage(): never {
  console.log(
    "Usage: npm run test:copy-one -- <sourceWallet> [copyUsdc]\n" +
      "Example: npm run test:copy-one -- 0xabc...def 3\n" +
      "Notes:\n" +
      "- By default it copies the latest trade size from that wallet.\n" +
      "- DRY_RUN is true unless you set DRY_RUN=false in .env.",
  );
  process.exit(1);
}

function isPositiveNumber(v: string | undefined): boolean {
  if (!v) return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

async function main() {
  const [, , sourceWalletArg, copyUsdcArg] = process.argv;
  const sourceWallet = sourceWalletArg || process.env.SOURCE_WALLET || "";

  if (!sourceWallet || sourceWallet.length < 10) usage();

  console.log(`[Test] Fetching trades for ${sourceWallet} ...`);
  const trades = await getTradesForWallet(sourceWallet);
  if (trades.length === 0) {
    console.error("[Test] No trades found for this wallet.");
    process.exit(1);
  }

  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp);
  const trade = sorted[0];

  const copySize = isPositiveNumber(copyUsdcArg)
    ? Number(copyUsdcArg)
    : trade.size;

  console.log("[Test] Selected latest trade:");
  console.log(
    `  ${trade.side} token=${trade.tokenId} market=${trade.market} ` +
      `price=${trade.price} originalSize=${trade.size}`,
  );
  console.log(`[Test] Copy size: $${copySize.toFixed(2)}`);

  const result = await copyTradeWithSize(trade, copySize);

  console.log("[Test] Result:", {
    status: result.status,
    orderId: result.orderId,
    reason: result.reason,
  });

  if (result.status === "FAILED") process.exit(1);
}

main().catch((err: any) => {
  console.error("[Test] Fatal:", err?.message || err);
  process.exit(1);
});
