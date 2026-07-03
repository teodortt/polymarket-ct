import axios from "axios";
import * as https from "https";
import { Trade, MarketInfo } from "./types";

const directAgent = new https.Agent();

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export async function getTradesForWallet(
  walletAddress: string,
  after?: number,
): Promise<Trade[]> {
  // Guard: skip obviously invalid addresses (must be a 0x-prefixed 40-char hex)
  if (
    !walletAddress ||
    walletAddress.startsWith("0xtarget") ||
    !/^0x[0-9a-fA-F]{40}$/.test(walletAddress.trim())
  ) {
    console.error(
      `[API] Invalid wallet address skipped: "${walletAddress}" — check TARGET_WALLETS in .env`,
    );
    return [];
  }

  const user = walletAddress.trim().toLowerCase();

  try {
    const params: Record<string, string | number> = {
      user,
      limit: 100,
    };
    if (after) params.after = after;

    const res = await axios.get(`${DATA_API}/activity`, {
      params,
      timeout: 10_000,
      httpsAgent: directAgent,
      headers: {
        "User-Agent": "polymarket-ct/2.0.0",
      },
    });

    const raw: any[] = Array.isArray(res.data)
      ? res.data
      : (res.data?.data ?? []);

    const trades = raw
      .filter(
        (t: any) =>
          t.type === "TRADE" ||
          t.action === "TRADE" ||
          t.eventType === "TRADE" ||
          t.outcome !== undefined,
      )
      .map(normalizeTrade);

    return trades;
  } catch (err: any) {
    if (axios.isAxiosError(err)) {
      console.error(
        `[API] Failed to fetch trades: ${err.message}`,
        `\n      URL   : ${DATA_API}/activity`,
        `\n      User  : ${user}`,
        `\n      Status: ${err.response?.status}`,
        `\n      Body  : ${JSON.stringify(err.response?.data)}`,
      );
    } else {
      console.error("[API] Failed to fetch trades:", err.message);
    }
    return [];
  }
}

function normalizeTrade(raw: any): Trade {
  const side = raw.side?.toUpperCase() === "SELL" ? "SELL" : "BUY";
  // API returns the token/asset id in the "asset" field
  const tokenId = raw.asset ?? raw.assetId ?? raw.tokenId ?? raw.asset_id ?? "";
  return {
    id: raw.id ?? raw.tradeId ?? `${raw.transactionHash}-${tokenId}`,
    market: raw.conditionId ?? raw.condition_id ?? "",
    outcome: raw.outcome ?? "",
    tokenId,
    side,
    price: parseFloat(raw.price ?? "0"),
    size: parseFloat(raw.usdcSize ?? raw.size ?? raw.usd_size ?? "0"),
    // API already returns Unix seconds — do NOT wrap in new Date() which treats it as ms
    timestamp: raw.timestamp
      ? Math.floor(Number(raw.timestamp))
      : Math.floor(Date.now() / 1000),
    transactionHash: raw.transactionHash ?? raw.transaction_hash ?? "",
    maker_address: raw.maker ?? raw.maker_address ?? "",
    taker_address: raw.taker ?? raw.taker_address ?? "",
    type: "TAKER",
  };
}

const GAMMA_API = "https://gamma-api.polymarket.com";

export async function getMarketInfo(
  tokenId: string,
  conditionId?: string,
): Promise<MarketInfo | null> {
  // The CLOB /markets endpoint requires the conditionId (0x... hex), not the numeric token ID.
  // If conditionId looks like a hex condition ID, use it; otherwise fall through to Gamma lookup.
  const hexConditionId =
    conditionId && /^0x[0-9a-fA-F]+$/.test(conditionId) ? conditionId : null;

  if (hexConditionId) {
    try {
      const res = await axios.get(`${CLOB_API}/markets/${hexConditionId}`, {
        timeout: 10_000,
        httpsAgent: directAgent,
      });
      const d = res.data;
      const token = (d.tokens ?? []).find((t: any) => t.token_id === tokenId);
      return {
        conditionId: d.condition_id ?? conditionId ?? "",
        tokenId,
        outcome: token?.outcome ?? d.outcome ?? "",
        question: d.question ?? "",
        tickSize: d.minimum_tick_size ?? "0.01",
        negRisk: d.neg_risk ?? false,
      };
    } catch {
      // fall through to Gamma API
    }
  }

  // Fallback: look up by token ID via the Gamma API. This handles cases where
  // the conditionId is missing (e.g. older stored trade records) or the CLOB
  // lookup failed.
  try {
    const res = await axios.get(`${GAMMA_API}/markets`, {
      params: { clob_token_ids: tokenId },
      timeout: 10_000,
      httpsAgent: directAgent,
    });
    const markets: any[] = Array.isArray(res.data) ? res.data : [];
    const market = markets[0];
    if (!market) return null;
    // Gamma returns clobTokenIds as a JSON-encoded array string.
    const tokens: string[] = (() => {
      try {
        return JSON.parse(market.clobTokenIds ?? "[]");
      } catch {
        return [];
      }
    })();
    const idx = tokens.indexOf(tokenId);
    const outcomes: string[] = (() => {
      try {
        return JSON.parse(market.outcomes ?? "[]");
      } catch {
        return [];
      }
    })();
    return {
      conditionId: market.conditionId ?? market.condition_id ?? "",
      tokenId,
      outcome: outcomes[idx] ?? "",
      question: market.question ?? "",
      tickSize: market.minimum_tick_size ?? "0.01",
      negRisk: market.negRisk ?? market.neg_risk ?? false,
    };
  } catch {
    return null;
  }
}
