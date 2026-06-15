import {
  ClobClient,
  Side,
  OrderType,
  Chain,
  AssetType,
} from "@polymarket/clob-client-v2";
import { createWalletClient, createPublicClient, http, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { config } from "./config";
import { Trade, CopiedTrade, MarketInfo } from "./types";
import { getMarketInfo } from "./polymarketApi";
import { adjustPriceToTick, toLimitOrderSizeShares } from "./orderSizing";

let client: ClobClient | null = null;
let activeAuthKey = "";

type AuthMode = {
  signatureType: 0 | 1 | 2 | 3;
  funder: string;
};

// Polymarket settles in USDC.e (bridged USDC) on Polygon.
const USDC_E_POLYGON =
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as `0x${string}`;
const publicClient = createPublicClient({
  chain: polygon,
  transport: http(),
});

function makeAuthKey(mode: AuthMode): string {
  return `${mode.signatureType}:${mode.funder.toLowerCase()}`;
}

function getDefaultAuthMode(): AuthMode {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const funder = config.funderAddress || account.address;
  // New Polymarket API users with a dedicated funder/deposit wallet should use signature type 3.
  const likelyDepositWallet =
    config.funderAddress &&
    config.funderAddress.toLowerCase() !== account.address.toLowerCase();

  return {
    signatureType: likelyDepositWallet
      ? 3
      : (config.signatureType as 0 | 1 | 2 | 3),
    funder,
  };
}

function getFallbackAuthModes(): AuthMode[] {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const addr = account.address;
  const envFunder = config.funderAddress || "";
  const candidates: AuthMode[] = [
    getDefaultAuthMode(),
    { signatureType: 3, funder: envFunder || addr },
    { signatureType: 0, funder: envFunder || addr },
    { signatureType: 1, funder: envFunder || addr },
    { signatureType: 2, funder: envFunder || addr },
    { signatureType: 0, funder: addr },
    { signatureType: 1, funder: addr },
  ];

  const seen = new Set<string>();
  return candidates.filter((m) => {
    const k = makeAuthKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function createClient(mode: AuthMode): Promise<ClobClient> {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.RPC_URL || "https://polygon-rpc.com"),
  });

  const tempClient = new ClobClient({
    host: config.host,
    chain: Chain.POLYGON,
    signer,
    signatureType: mode.signatureType,
    funderAddress: mode.funder,
  });

  const apiCreds = await tempClient.createOrDeriveApiKey();

  return new ClobClient({
    host: config.host,
    chain: Chain.POLYGON,
    signer,
    creds: apiCreds,
    signatureType: mode.signatureType,
    funderAddress: mode.funder,
  });
}

export async function initTrader(): Promise<ClobClient> {
  if (client) return client;

  const mode = getDefaultAuthMode();
  client = await createClient(mode);
  activeAuthKey = makeAuthKey(mode);
  console.log(
    `[Trader] Initialized. signatureType=${mode.signatureType} funder=${mode.funder}`,
  );
  return client;
}

function isOrderVersionMismatch(reason: unknown): boolean {
  const text = String(reason ?? "").toLowerCase();
  return text.includes("order_version_mismatch");
}

function isAuthRetryable(reason: unknown): boolean {
  const text = String(reason ?? "").toLowerCase();
  return (
    text.includes("order_version_mismatch") ||
    text.includes("maker address not allowed") ||
    text.includes("deposit wallet flow")
  );
}

function isInsufficientBalance(reason: unknown): boolean {
  const text = String(reason ?? "").toLowerCase();
  return text.includes("not enough balance") || text.includes("allowance");
}

function parseMinSize(reason: unknown): number | null {
  const m = String(reason ?? "").match(/minimum:\s*([0-9]*\.?[0-9]+)/i);
  return m ? Number(m[1]) : null;
}

async function tryPlaceOrderWithClient(
  c: ClobClient,
  trade: Trade,
  copySize: number,
  marketInfo: MarketInfo,
) {
  const tickSize = marketInfo.tickSize as "0.1" | "0.01" | "0.001" | "0.0001";
  const orderOpts = { tickSize, negRisk: marketInfo.negRisk };
  const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
  const adjustedPrice = adjustPriceToTick(trade.price, tickSize);
  const size = toLimitOrderSizeShares(trade.side, copySize, adjustedPrice);

  const orderType = config.orderType === "GTD" ? OrderType.GTD : OrderType.GTC;

  return c.createAndPostOrder(
    {
      tokenID: trade.tokenId,
      price: adjustedPrice,
      size,
      side,
    },
    orderOpts,
    orderType,
  );
}

function feeBpsForMode(isDryRun: boolean): number {
  const raw = isDryRun ? config.dryRunFeeBps : config.liveFeeBps;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return raw;
}

function feeFromNotional(notionalUsdc: number, feeBps: number): number {
  return (notionalUsdc * feeBps) / 10_000;
}

function finalizeExecutionMeta(
  result: CopiedTrade,
  attemptedCopySizeUsdc: number,
  effectiveCopySizeUsdc: number,
  marketInfoMs: number,
  orderSubmitMs: number,
  startedAt: number,
  isDryRun: boolean,
) {
  const feeBps = feeBpsForMode(isDryRun);
  const grossUsdc = effectiveCopySizeUsdc;
  const estimatedFeeUsdc = feeFromNotional(grossUsdc, feeBps);
  const netUsdc =
    result.originalTrade.side === "BUY"
      ? grossUsdc + estimatedFeeUsdc
      : grossUsdc - estimatedFeeUsdc;
  result.execution = {
    mode: isDryRun ? "DRY_RUN" : "LIVE",
    attemptedCopySizeUsdc,
    effectiveCopySizeUsdc,
    grossUsdc,
    estimatedFeeUsdc,
    feeBps,
    netUsdc,
    processingMs: Date.now() - startedAt,
    marketInfoMs,
    orderSubmitMs,
  };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAvailableCollateralUsdc(
  c: ClobClient,
): Promise<number | null> {
  try {
    const ba = await c.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    const raw = Number(ba?.balance ?? "0");
    if (!Number.isFinite(raw) || raw < 0) return null;
    // Polymarket collateral balances are returned in 6-decimal USDC units.
    return raw / 1_000_000;
  } catch {
    return null;
  }
}

async function retryOrderWithFallbackAuth(
  trade: Trade,
  copySize: number,
  marketInfo: MarketInfo,
) {
  const modes = getFallbackAuthModes();
  const modeByKey = new Map(modes.map((m) => [makeAuthKey(m), m]));
  const ordered = [
    ...modes.filter((m) => makeAuthKey(m) !== activeAuthKey),
    ...modes.filter((m) => makeAuthKey(m) === activeAuthKey),
  ];

  for (const mode of ordered) {
    const key = makeAuthKey(mode);
    try {
      const c = await createClient(mode);
      const response = await tryPlaceOrderWithClient(
        c,
        trade,
        copySize,
        marketInfo,
      );
      if (response?.success) {
        client = c;
        activeAuthKey = key;
        console.log(
          `[Trader] Switched auth mode: signatureType=${mode.signatureType} funder=${mode.funder}`,
        );
        return response;
      }

      const reason = response?.errorMsg || JSON.stringify(response);
      if (!isAuthRetryable(reason)) return response;
    } catch {
      console.log(
        `[Trader] Auth mode failed: signatureType=${mode.signatureType} funder=${mode.funder}`,
      );
      const known = modeByKey.get(key);
      if (!known) continue;
    }
  }

  return null;
}

export async function copyTradeWithSize(
  trade: Trade,
  copySize: number,
): Promise<CopiedTrade> {
  const startedAt = Date.now();
  let marketInfoMs = 0;
  let orderSubmitMs = 0;
  const result: CopiedTrade = {
    originalTrade: trade,
    status: "SKIPPED",
    timestamp: Date.now(),
  };

  if (copySize < config.minTradeUsdc) {
    result.reason = `Size too small: $${copySize.toFixed(2)} < $${config.minTradeUsdc}`;
    finalizeExecutionMeta(
      result,
      copySize,
      copySize,
      marketInfoMs,
      orderSubmitMs,
      startedAt,
      config.dryRun,
    );
    return result;
  }

  const marketInfoStart = Date.now();
  const marketInfo: MarketInfo | null = await getMarketInfo(
    trade.tokenId,
    trade.market,
  );
  marketInfoMs = Date.now() - marketInfoStart;
  if (!marketInfo) {
    result.status = "FAILED";
    result.reason = `Could not fetch market info for ${trade.tokenId}`;
    finalizeExecutionMeta(
      result,
      copySize,
      copySize,
      marketInfoMs,
      orderSubmitMs,
      startedAt,
      config.dryRun,
    );
    return result;
  }

  try {
    const c = config.dryRun ? null : await initTrader();
    let effectiveCopySize = copySize;

    // Preflight BUY sizing by available collateral to avoid avoidable rejects.
    if (trade.side === "BUY") {
      const available = c ? await getAvailableCollateralUsdc(c) : null;
      if (available !== null) {
        // Keep headroom for fees/slippage so we don't consume 100% balance.
        const buffered = Math.max(0, available * 0.97 - 0.02);
        effectiveCopySize = Math.min(copySize, buffered);
        if (effectiveCopySize < config.minTradeUsdc) {
          result.status = "SKIPPED";
          result.reason =
            `Insufficient collateral: available $${available.toFixed(2)} ` +
            `(< min trade $${config.minTradeUsdc.toFixed(2)})`;
          finalizeExecutionMeta(
            result,
            copySize,
            effectiveCopySize,
            marketInfoMs,
            orderSubmitMs,
            startedAt,
            config.dryRun,
          );
          return result;
        }
      }
    }

    const submitStart = Date.now();
    let response: any;
    if (config.dryRun) {
      await sleep(config.dryRunSimulatedOrderLatencyMs);
      response = {
        success: true,
        orderID: `DRY-${trade.id}-${Date.now()}`,
      };
    } else {
      response = await tryPlaceOrderWithClient(
        c as ClobClient,
        trade,
        effectiveCopySize,
        marketInfo,
      );
    }
    orderSubmitMs = Date.now() - submitStart;

    // If server says min order is higher, retry once with that minimum.
    if (!config.dryRun && !response?.success) {
      const minSize = parseMinSize(response?.errorMsg || response);
      if (minSize && effectiveCopySize < minSize) {
        effectiveCopySize = minSize;
        const retryStart = Date.now();
        response = await tryPlaceOrderWithClient(
          c as ClobClient,
          trade,
          minSize,
          marketInfo,
        );
        orderSubmitMs += Date.now() - retryStart;
      }
      // If BUY still hits balance/allowance, downsize once and retry.
      if (
        !response?.success &&
        trade.side === "BUY" &&
        isInsufficientBalance(response?.errorMsg || response)
      ) {
        const available = await getAvailableCollateralUsdc(c as ClobClient);
        if (available !== null) {
          const retrySize = Math.max(0, available * 0.94 - 0.02);
          if (retrySize >= config.minTradeUsdc) {
            effectiveCopySize = retrySize;
            const retryStart = Date.now();
            response = await tryPlaceOrderWithClient(
              c as ClobClient,
              trade,
              retrySize,
              marketInfo,
            );
            orderSubmitMs += Date.now() - retryStart;
          }
        }
      }
    }

    if (
      !config.dryRun &&
      !response?.success &&
      isAuthRetryable(response?.errorMsg || response)
    ) {
      const fallbackStart = Date.now();
      const fallback = await retryOrderWithFallbackAuth(
        trade,
        effectiveCopySize,
        marketInfo,
      );
      orderSubmitMs += Date.now() - fallbackStart;
      if (fallback) response = fallback;
    }

    // throwOnError defaults to false in ClobClient — must check success manually
    if (!response?.success) {
      let reason =
        response?.errorMsg ||
        JSON.stringify(response) ||
        "Order rejected by CLOB";
      if (isOrderVersionMismatch(reason)) {
        reason +=
          " | auth mismatch: for new Polymarket API users use SIGNATURE_TYPE=3 with FUNDER_ADDRESS=deposit/profile address.";
      }
      if (isInsufficientBalance(reason)) {
        result.status = "SKIPPED";
        result.reason = reason;
        finalizeExecutionMeta(
          result,
          copySize,
          effectiveCopySize,
          marketInfoMs,
          orderSubmitMs,
          startedAt,
          config.dryRun,
        );
        return result;
      }
      console.error(`[Trader] ❌ Order rejected: ${reason}`);
      result.status = "FAILED";
      result.reason = reason;
      finalizeExecutionMeta(
        result,
        copySize,
        effectiveCopySize,
        marketInfoMs,
        orderSubmitMs,
        startedAt,
        config.dryRun,
      );
      return result;
    }

    console.log(
      `[Trader] ${config.dryRun ? "🔵 DRY" : "✅ PLACED"} orderId=${response.orderID}`,
    );
    result.status = config.dryRun ? "DRY_RUN" : "PLACED";
    result.orderId = response.orderID;
    result.reason =
      result.status === "DRY_RUN"
        ? `DRY_RUN: ${trade.side} $${effectiveCopySize.toFixed(2)} @ ${trade.price}`
        : result.reason;
    finalizeExecutionMeta(
      result,
      copySize,
      effectiveCopySize,
      marketInfoMs,
      orderSubmitMs,
      startedAt,
      config.dryRun,
    );
    return result;
  } catch (err: any) {
    console.error(`[Trader] ❌ createAndPostOrder FAILED: ${err.message}`);
    result.status = "FAILED";
    result.reason = err.message;
    finalizeExecutionMeta(
      result,
      copySize,
      copySize,
      marketInfoMs,
      orderSubmitMs,
      startedAt,
      config.dryRun,
    );
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

// Reads the on-chain USDC.e balance of the live trading wallet (the funder
// address if set, otherwise the EOA derived from PRIVATE_KEY). Returns the
// balance as a USDC float (6 decimals). Returns null on RPC failure so the
// caller can render "n/a" instead of crashing.
export async function getLiveUsdcBalance(): Promise<{
  address: `0x${string}`;
  balance: number;
} | null> {
  try {
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const address = (config.funderAddress || account.address) as `0x${string}`;
    const raw = (await publicClient.readContract({
      address: USDC_E_POLYGON,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    return { address, balance: Number(raw) / 1_000_000 };
  } catch (err: any) {
    console.error("[Trader] getLiveUsdcBalance failed:", err?.message ?? err);
    return null;
  }
}
