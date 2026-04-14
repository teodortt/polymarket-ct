import * as dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function parseTargetWallets(): string[] {
  const multi = process.env.TARGET_WALLETS;
  if (multi)
    return multi
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean);
  const single = process.env.TARGET_WALLET;
  if (single) return [single.trim()];
  return []; // allowed — can be added later via Telegram
}

export const config = {
  host: "https://clob.polymarket.com",
  chainId: 137,

  privateKey: required("PRIVATE_KEY"),
  funderAddress: process.env.FUNDER_ADDRESS || "",
  signatureType: parseInt(process.env.SIGNATURE_TYPE || "0") as 0 | 1 | 2,

  targetWallets: parseTargetWallets(),

  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "10000"),
  copySizeUsdc: parseFloat(process.env.COPY_SIZE_USDC || "0"),
  sizeMultiplier: parseFloat(process.env.SIZE_MULTIPLIER || "1.0"),
  maxTradeUsdc: parseFloat(process.env.MAX_TRADE_USDC || "100"),
  dryRun: process.env.DRY_RUN !== "false",

  // Optional SOCKS5/HTTP proxy (e.g. Cloudflare WARP: socks5://127.0.0.1:40000)
  proxyUrl: process.env.PROXY_URL || "",

  // Telegram
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),
};
