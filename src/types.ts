export interface Trade {
  id: string;
  market: string;
  outcome: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  transactionHash: string;
  maker_address: string;
  taker_address: string;
  type: "MAKER" | "TAKER";
}

export interface MarketInfo {
  conditionId: string;
  tokenId: string;
  outcome: string;
  question: string;
  tickSize: string;
  negRisk: boolean;
}

export interface CopiedTrade {
  originalTrade: Trade;
  orderId?: string;
  status: "PLACED" | "FAILED" | "SKIPPED" | "DRY_RUN";
  reason?: string;
  timestamp: number;
}

export interface WalletConfig {
  wallet: string;
  label?: string;
  enabled: boolean;
  sizeMultiplier: number; // e.g. 1.0 = 100%, 0.5 = 50%
  sizePercent: number; // 0–100: % of trader's size. 0 = disabled (use multiplier)
  maxTradeUsdc: number;
  copySizeUsdc: number; // fixed USDC amount. 0 = disabled
}
