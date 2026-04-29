import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config";
import { Trade, CopiedTrade, MarketInfo } from "./types";
import { getMarketInfo } from "./polymarketApi";

let client: ClobClient | null = null;

export async function initTrader(): Promise<ClobClient> {
  if (client) return client;

  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  });

  const tempClient = new ClobClient(
    config.host,
    config.chainId,
    signer,
    undefined,
    config.signatureType,
    config.funderAddress || account.address,
  );

  const apiCreds = await tempClient.createOrDeriveApiKey();

  client = new ClobClient(
    config.host,
    config.chainId,
    signer,
    apiCreds,
    config.signatureType,
    config.funderAddress || account.address,
  );

  console.log(`[Trader] Initialized. Wallet: ${account.address}`);
  return client;
}

export async function copyTradeWithSize(
  trade: Trade,
  copySize: number,
): Promise<CopiedTrade> {
  const result: CopiedTrade = {
    originalTrade: trade,
    status: "SKIPPED",
    timestamp: Date.now(),
  };

  if (copySize < config.minTradeUsdc) {
    result.reason = `Size too small: $${copySize.toFixed(2)} < $${config.minTradeUsdc}`;
    return result;
  }

  const marketInfo: MarketInfo | null = await getMarketInfo(
    trade.tokenId,
    trade.market,
  );
  if (!marketInfo) {
    result.status = "FAILED";
    result.reason = `Could not fetch market info for ${trade.tokenId}`;
    return result;
  }

  if (config.dryRun) {
    result.status = "DRY_RUN";
    result.reason = `DRY_RUN: ${trade.side} $${copySize.toFixed(2)} @ ${trade.price}`;
    return result;
  }

  try {
    const c = await initTrader();
    const tickSize = marketInfo.tickSize as "0.1" | "0.01" | "0.001" | "0.0001";
    const orderOpts = { tickSize, negRisk: marketInfo.negRisk };
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;

    let response: any;
    if (config.orderType === "FAK" || config.orderType === "FOK") {
      // Marketable order — must use createAndPostMarketOrder.
      // For BUY: amount = USDC. For SELL: amount = shares.
      const amount =
        side === Side.BUY
          ? copySize
          : trade.price > 0
            ? copySize / trade.price
            : 0;
      response = await c.createAndPostMarketOrder(
        {
          tokenID: trade.tokenId,
          price: trade.price,
          amount,
          side,
        },
        orderOpts,
        config.orderType === "FAK" ? OrderType.FAK : OrderType.FOK,
      );
    } else {
      response = await c.createAndPostOrder(
        {
          tokenID: trade.tokenId,
          price: trade.price,
          size: copySize,
          side,
        },
        orderOpts,
        OrderType.GTC,
      );
    }

    // throwOnError defaults to false in ClobClient — must check success manually
    if (!response?.success) {
      const reason =
        response?.errorMsg ||
        JSON.stringify(response) ||
        "Order rejected by CLOB";
      console.error(`[Trader] ❌ Order rejected: ${reason}`);
      result.status = "FAILED";
      result.reason = reason;
      return result;
    }

    console.log(`[Trader] ✅ PLACED orderId=${response.orderID}`);
    result.status = "PLACED";
    result.orderId = response.orderID;
    return result;
  } catch (err: any) {
    console.error(`[Trader] ❌ createAndPostOrder FAILED: ${err.message}`);
    result.status = "FAILED";
    result.reason = err.message;
    return result;
  }
}

export async function getOpenOrders(): Promise<any[]> {
  try {
    const c = await initTrader();
    const res = await (c as any).getOpenOrders();
    return Array.isArray(res) ? res : (res?.data ?? []);
  } catch (err: any) {
    console.error("[Trader] getOpenOrders failed:", err.message);
    return [];
  }
}

export async function cancelOrdersByIds(
  orderIds: string[],
): Promise<{ ok: boolean; cancelled: number; reason?: string }> {
  if (orderIds.length === 0) return { ok: true, cancelled: 0 };
  try {
    const c = await initTrader();
    await (c as any).cancelOrders(orderIds);
    console.log(`[Trader] 🗑 Cancelled ${orderIds.length} order(s).`);
    return { ok: true, cancelled: orderIds.length };
  } catch (err: any) {
    console.error("[Trader] cancelOrders failed:", err.message);
    return { ok: false, cancelled: 0, reason: err.message };
  }
}
