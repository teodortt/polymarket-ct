import {
  ClobClient,
  Side,
  OrderType,
  Chain,
  AssetType,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
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

  return c.createAndPostOrder(
    {
      tokenID: trade.tokenId,
      price: adjustedPrice,
      size,
      side,
    },
    orderOpts,
    OrderType.GTC,
  );
}

async function getAvailableCollateralUsdc(
  c: ClobClient,
  forceUpdate = false,
): Promise<number | null> {
  try {
    if (forceUpdate) {
      // The CLOB caches balance/allowance server-side and can report a stale
      // $0.00 after deposits or on a freshly-derived API key. updateBalanceAllowance
      // forces it to re-sync the on-chain balance before we read it.
      try {
        await c.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      } catch {
        // Non-fatal — fall through and read whatever is currently cached.
      }
    }
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
    let effectiveCopySize = copySize;

    // Preflight BUY sizing by available collateral to avoid avoidable rejects.
    if (trade.side === "BUY") {
      // Force a fresh balance sync — the CLOB otherwise can report a stale $0.00.
      const available = await getAvailableCollateralUsdc(c, true);
      // Only downsize when we get a *positive* reading. A 0/null reading means we
      // couldn't reliably determine the balance (stale cache / API hiccup); in
      // that case proceed with the requested size and let order placement (with
      // its auth fallback + balance retry) surface the real error instead of
      // false-skipping a trade we actually have funds for.
      if (available !== null && available > 0) {
        // Keep headroom for fees/slippage so we don't consume 100% balance.
        const buffered = Math.max(0, available * 0.97 - 0.02);
        effectiveCopySize = Math.min(copySize, buffered);
        if (effectiveCopySize < config.minTradeUsdc) {
          result.status = "SKIPPED";
          result.reason =
            `Insufficient collateral: available $${available.toFixed(2)} ` +
            `(< min trade $${config.minTradeUsdc.toFixed(2)})`;
          return result;
        }
      }
    }

    let response = await tryPlaceOrderWithClient(
      c,
      trade,
      effectiveCopySize,
      marketInfo,
    );

    // If server says min order is higher, retry once with that minimum.
    if (!response?.success) {
      const minSize = parseMinSize(response?.errorMsg || response);
      if (minSize && effectiveCopySize < minSize) {
        response = await tryPlaceOrderWithClient(c, trade, minSize, marketInfo);
      }
      // If BUY still hits balance/allowance, downsize once and retry.
      if (
        !response?.success &&
        trade.side === "BUY" &&
        isInsufficientBalance(response?.errorMsg || response)
      ) {
        const available = await getAvailableCollateralUsdc(c, true);
        if (available !== null && available > 0) {
          const retrySize = Math.max(0, available * 0.94 - 0.02);
          if (retrySize >= config.minTradeUsdc) {
            response = await tryPlaceOrderWithClient(
              c,
              trade,
              retrySize,
              marketInfo,
            );
          }
        }
      }
    }

    if (!response?.success && isAuthRetryable(response?.errorMsg || response)) {
      const fallback = await retryOrderWithFallbackAuth(
        trade,
        effectiveCopySize,
        marketInfo,
      );
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
        return result;
      }
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

// Reads the Polymarket collateral balance (USDC deposited in Polymarket account,
// not on-chain wallet balance). Returns the balance as a USDC float. Returns null
// on API failure so the caller can render "n/a" instead of crashing.
export async function getLiveUsdcBalance(): Promise<{
  address: `0x${string}`;
  balance: number;
} | null> {
  try {
    const c = await initTrader();
    const account = privateKeyToAccount(config.privateKey as `0x${string}`);
    const address = (config.funderAddress || account.address) as `0x${string}`;

    // Get Polymarket collateral balance via CLOB API. Force a refresh so the
    // status command reflects on-chain truth, not a stale server cache.
    const available = await getAvailableCollateralUsdc(c, true);
    if (available === null) return null;

    return { address, balance: available };
  } catch (err: any) {
    console.error("[Trader] getLiveUsdcBalance failed:", err?.message ?? err);
    return null;
  }
}
