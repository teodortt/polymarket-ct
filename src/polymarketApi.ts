import axios from "axios";
import { Trade, MarketInfo } from "./types";
import { getProxyAgent } from "./proxy";

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

export async function getTradesForWallet(
  walletAddress: string,
  after?: number,
): Promise<Trade[]> {
  // Guard: skip obviously invalid addresses
  if (
    !walletAddress ||
    walletAddress.startsWith("0xtarget") ||
    walletAddress.length < 10
  ) {
    console.error("[API] TARGET_WALLET is not set properly in .env!");
    return [];
  }

  try {
    const params: Record<string, string | number> = {
      user: walletAddress.toLowerCase(),
      limit: 100,
    };
    if (after) params.after = after;

    const fetchActivity = (agent: any) =>
      axios.get(`${DATA_API}/activity`, {
        params,
        timeout: 10_000,
        httpsAgent: agent,
        httpAgent: agent,
        maxRedirects: 5,
      });

    let res;
    try {
      res = await fetchActivity(getProxyAgent());
    } catch (proxyErr: any) {
      if (
        getProxyAgent() &&
        (proxyErr.message?.includes("redirects") ||
          proxyErr.code === "ERR_FR_TOO_MANY_REDIRECTS")
      ) {
        console.warn("[API] Proxy failed, retrying without proxy...");
        res = await fetchActivity(undefined);
      } else {
        throw proxyErr;
      }
    }

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

export async function getMarketInfo(
  tokenId: string,
  conditionId?: string,
): Promise<MarketInfo | null> {
  // The CLOB /markets endpoint requires the conditionId (0x... hex), not the numeric token ID.
  const lookupId = conditionId || tokenId;
  try {
    let res;
    try {
      res = await axios.get(`${CLOB_API}/markets/${lookupId}`, {
        timeout: 10_000,
        httpsAgent: getProxyAgent(),
        httpAgent: getProxyAgent(),
        maxRedirects: 5,
      });
    } catch (proxyErr: any) {
      if (
        getProxyAgent() &&
        (proxyErr.message?.includes("redirects") ||
          proxyErr.code === "ERR_FR_TOO_MANY_REDIRECTS")
      ) {
        res = await axios.get(`${CLOB_API}/markets/${lookupId}`, {
          timeout: 10_000,
          maxRedirects: 5,
        });
      } else {
        throw proxyErr;
      }
    }
    const d = res.data;
    // Find the specific outcome for this tokenId from the tokens array
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
    return null;
  }
}
