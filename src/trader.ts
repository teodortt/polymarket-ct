import {
  ClobClient,
  Side,
  OrderType,
  Chain,
  AssetType,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

function parseShareMinimum(
  reason: unknown,
): { attempted: number; min: number } | null {
  const m = String(reason ?? "").match(
    /size\s*\(([0-9]*\.?[0-9]+)\)\s*lower than the minimum:\s*([0-9]*\.?[0-9]+)/i,
  );
  if (!m) return null;
  const attempted = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(attempted) || !Number.isFinite(min)) return null;
  return { attempted, min };
}

async function tryPlaceOrderWithClient(
  c: ClobClient,
  trade: Trade,
  copySizeUsdc: number,
  marketInfo: MarketInfo,
  sellSizeShares?: number,
) {
  const tickSize = marketInfo.tickSize as "0.1" | "0.01" | "0.001" | "0.0001";
  const orderOpts = { tickSize, negRisk: marketInfo.negRisk };
  const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
  const adjustedPrice = getPostedPrice(trade.side, trade.price, tickSize);
  const size =
    trade.side === "SELL" && Number.isFinite(sellSizeShares)
      ? Number(sellSizeShares)
      : toLimitOrderSizeShares(trade.side, copySizeUsdc, adjustedPrice);

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

function getPostedPrice(
  side: "BUY" | "SELL",
  inputPrice: number,
  tickSize: "0.1" | "0.01" | "0.001" | "0.0001",
): number {
  const tick = Number(tickSize || 0.01);
  const base = adjustPriceToTick(inputPrice, tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return base;

  if (side === "SELL") {
    // SELL exits should be slightly more aggressive than top-of-book so they
    // cross immediately instead of resting as stale GTC orders.
    const aggressive = Math.max(tick, base - 2 * tick);
    return adjustPriceToTick(aggressive, tickSize);
  }

  return base;
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

async function getAvailableConditionalShares(
  c: ClobClient,
  tokenId: string,
  forceUpdate = false,
): Promise<number | null> {
  try {
    if (forceUpdate) {
      try {
        await c.updateBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: tokenId,
        });
      } catch {
        // Non-fatal — fall through and read whatever is currently cached.
      }
    }
    const ba = await c.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenId,
    });
    const raw = Number(ba?.balance ?? "0");
    if (!Number.isFinite(raw) || raw < 0) return null;
    // Conditional token balances are also returned in 6-decimal units.
    return raw / 1_000_000;
  } catch {
    return null;
  }
}

async function retrySellWithSmallerSizes(
  c: ClobClient,
  trade: Trade,
  marketInfo: MarketInfo,
  baseShares: number,
  minShares: number | null,
) {
  let response: any = null;
  let usedShares = baseShares;
  const factors = [0.98, 0.9, 0.8, 0.67, 0.5, 0.4, 0.33];

  for (const factor of factors) {
    const shares = Number((baseShares * factor).toFixed(6));
    if (shares <= 0 || shares >= usedShares) continue;
    if (minShares !== null && shares < minShares) continue;

    // Re-sync token balance/allowance before each smaller-chunk retry.
    await getAvailableConditionalShares(c, trade.tokenId, true);

    response = await tryPlaceOrderWithClient(
      c,
      trade,
      shares * trade.price,
      marketInfo,
      shares,
    );
    if (response?.success) {
      return { response, usedShares: shares };
    }

    usedShares = shares;
    const shareMin = parseShareMinimum(response?.errorMsg || response);
    if (shareMin && shares < shareMin.min) {
      break;
    }
  }

  return { response, usedShares: baseShares };
}

async function retryOrderWithFallbackAuth(
  trade: Trade,
  copySize: number,
  marketInfo: MarketInfo,
  sellSizeShares?: number,
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
        sellSizeShares,
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

  if (trade.side === "BUY" && copySize < config.minTradeUsdc) {
    result.reason = `Size too small: $${copySize.toFixed(2)} < $${config.minTradeUsdc}`;
    return result;
  }

  // Guard against uncopyable source records. Some activity-feed entries (e.g.
  // neg-risk conversions/redemptions) carry an outcome but no usable price, so
  // they normalise to price 0. Placing an order from a non-positive price feeds
  // the CLOB rounding math a bad amount and crashes deep inside the client with
  // an opaque "reading 'toString'" error — skip with a clear reason instead.
  if (!Number.isFinite(trade.price) || trade.price <= 0) {
    result.status = "SKIPPED";
    result.reason = `No valid price on source trade (price=${trade.price}) — not copyable`;
    return result;
  }
  if (!trade.tokenId) {
    result.status = "SKIPPED";
    result.reason = "Missing tokenId on source trade — not copyable";
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

  const tickSize = marketInfo.tickSize as "0.1" | "0.01" | "0.001" | "0.0001";
  const submittedPrice = getPostedPrice(trade.side, trade.price, tickSize);

  if (config.dryRun) {
    const drySellShares =
      trade.side === "SELL"
        ? Number.isFinite(trade.size) && trade.size > 0
          ? Number(trade.size)
          : toLimitOrderSizeShares("SELL", copySize, submittedPrice)
        : undefined;
    result.status = "DRY_RUN";
    result.reason = `DRY_RUN: ${trade.side} $${copySize.toFixed(2)} @ ${trade.price}`;
    result.submittedPrice = submittedPrice;
    if (
      trade.side === "SELL" &&
      drySellShares &&
      Number.isFinite(drySellShares)
    ) {
      result.submittedSizeShares = drySellShares;
      result.submittedNotionalUsdc = drySellShares * submittedPrice;
    }
    return result;
  }

  try {
    const c = await initTrader();
    let effectiveCopySize = copySize;
    let effectiveSellSizeShares: number | undefined;

    if (trade.side === "SELL") {
      const fromTrade = Number(trade.size);
      if (Number.isFinite(fromTrade) && fromTrade > 0) {
        effectiveSellSizeShares = fromTrade;
      } else {
        effectiveSellSizeShares = toLimitOrderSizeShares(
          "SELL",
          copySize,
          trade.price,
        );
      }

      if (
        !Number.isFinite(effectiveSellSizeShares) ||
        effectiveSellSizeShares <= 0
      ) {
        result.status = "SKIPPED";
        result.reason = "Invalid SELL size — no shares available to exit";
        return result;
      }

      // Re-read token balance/allowance right before selling; local state can drift.
      const availableShares = await getAvailableConditionalShares(
        c,
        trade.tokenId,
        true,
      );
      if (availableShares !== null) {
        if (availableShares <= 0) {
          result.status = "SKIPPED";
          result.reason = "No conditional token balance available for SELL";
          return result;
        }
        const bufferedShares = Math.max(0, availableShares - 0.000001);
        if (bufferedShares <= 0) {
          result.status = "SKIPPED";
          result.reason = "Conditional token balance too small to sell";
          return result;
        }
        if (bufferedShares < effectiveSellSizeShares) {
          effectiveSellSizeShares = bufferedShares;
        }
      }
    }

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
      effectiveSellSizeShares,
    );

    // If server says min order is higher, retry once with that minimum.
    if (!response?.success) {
      const minSize = parseMinSize(response?.errorMsg || response);
      if (minSize && effectiveCopySize < minSize) {
        response = await tryPlaceOrderWithClient(
          c,
          trade,
          minSize,
          marketInfo,
          effectiveSellSizeShares,
        );
      }

      // Some rejects include the minimum in shares (e.g. "Size (3.04) lower than the minimum: 5").
      // BUY can increase notional and retry; SELL cannot exceed held shares, so skip cleanly.
      const shareMin = parseShareMinimum(response?.errorMsg || response);
      if (shareMin) {
        if (trade.side === "BUY") {
          const tickSize = marketInfo.tickSize as
            | "0.1"
            | "0.01"
            | "0.001"
            | "0.0001";
          const adjustedPrice = adjustPriceToTick(trade.price, tickSize);
          const minNotional = shareMin.min * adjustedPrice + 0.02;
          if (effectiveCopySize < minNotional) {
            effectiveCopySize = minNotional;
            response = await tryPlaceOrderWithClient(
              c,
              trade,
              effectiveCopySize,
              marketInfo,
              effectiveSellSizeShares,
            );
          }
        } else if (
          effectiveSellSizeShares !== undefined &&
          effectiveSellSizeShares < shareMin.min
        ) {
          result.status = "SKIPPED";
          result.reason =
            `Position too small to exit: ${effectiveSellSizeShares.toFixed(4)} shares ` +
            `< exchange minimum ${shareMin.min}`;
          return result;
        }
      }

      // SELL path: if balance/allowance drifts or book is thin, retry with
      // refreshed token balance and smaller chunks instead of reusing stale size.
      if (!response?.success && trade.side === "SELL") {
        const reason = response?.errorMsg || response;

        if (
          isInsufficientBalance(reason) &&
          effectiveSellSizeShares !== undefined
        ) {
          const availableShares = await getAvailableConditionalShares(
            c,
            trade.tokenId,
            true,
          );
          if (availableShares !== null && availableShares > 0) {
            const retryShares = Math.max(
              0,
              Math.min(effectiveSellSizeShares, availableShares - 0.000001),
            );
            if (retryShares > 0 && retryShares < effectiveSellSizeShares) {
              effectiveSellSizeShares = retryShares;
              response = await tryPlaceOrderWithClient(
                c,
                trade,
                retryShares * trade.price,
                marketInfo,
                retryShares,
              );
            }
          }
        }

        if (!response?.success && effectiveSellSizeShares !== undefined) {
          const minShares =
            parseShareMinimum(response?.errorMsg || response)?.min ?? null;
          const retried = await retrySellWithSmallerSizes(
            c,
            trade,
            marketInfo,
            effectiveSellSizeShares,
            minShares,
          );
          if (retried.response) {
            response = retried.response;
            if (response?.success) {
              effectiveSellSizeShares = retried.usedShares;
            }
          }
        }
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
              effectiveSellSizeShares,
            );
          }
        }
      }
    }

    if (
      !response?.success &&
      trade.side === "SELL" &&
      isInsufficientBalance(response?.errorMsg || response)
    ) {
      // Wrong auth/funder can surface as "not enough balance / allowance".
      const fallback = await retryOrderWithFallbackAuth(
        trade,
        effectiveCopySize,
        marketInfo,
        effectiveSellSizeShares,
      );
      if (fallback) response = fallback;
    }

    if (!response?.success && isAuthRetryable(response?.errorMsg || response)) {
      const fallback = await retryOrderWithFallbackAuth(
        trade,
        effectiveCopySize,
        marketInfo,
        effectiveSellSizeShares,
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
    result.submittedPrice = submittedPrice;
    if (trade.side === "SELL" && effectiveSellSizeShares) {
      result.submittedSizeShares = effectiveSellSizeShares;
      result.submittedNotionalUsdc = effectiveSellSizeShares * submittedPrice;
    }
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

    // Read the cached collateral balance (no forced refresh). /status can be
    // called frequently, and updateBalanceAllowance is a write call that adds
    // CLOB load / rate-limit pressure. The order-placement preflight already
    // forces a fresh sync where accuracy actually matters.
    const available = await getAvailableCollateralUsdc(c);
    if (available === null) return null;

    return { address, balance: available };
  } catch (err: any) {
    console.error("[Trader] getLiveUsdcBalance failed:", err?.message ?? err);
    return null;
  }
}
