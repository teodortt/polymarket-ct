#!/usr/bin/env node
const dotenv = require("dotenv");
const axios = require("axios");
const https = require("https");
const { ClobClient, Side, OrderType, Chain } = require("@polymarket/clob-client-v2");
const { createWalletClient, http } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { polygon } = require("viem/chains");

dotenv.config();

const DATA_API = "https://data-api.polymarket.com";
const CLOB_API = process.env.HOST || "https://clob.polymarket.com";
const httpsAgent = new https.Agent();

function usage() {
    console.log(
        "Usage: npm run test:copy-one -- <sourceWallet> [copyUsdc]\n" +
        "Example: npm run test:copy-one -- 0xabc...def 1\n" +
        "DRY_RUN=true (default). Set DRY_RUN=false for real order.",
    );
}

function normalizePrivateKey(input) {
    const raw = (input || "").trim();
    const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error("Invalid PRIVATE_KEY format");
    }
    return `0x${hex.toLowerCase()}`;
}

function normalizeTrade(raw) {
    const side = String(raw.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
    const tokenId = raw.asset ?? raw.assetId ?? raw.tokenId ?? raw.asset_id ?? "";
    return {
        id: raw.id ?? raw.tradeId ?? `${raw.transactionHash || "tx"}-${tokenId}`,
        market: raw.conditionId ?? raw.condition_id ?? "",
        outcome: raw.outcome ?? "",
        tokenId,
        side,
        price: Number(raw.price ?? 0),
        size: Number(raw.usdcSize ?? raw.size ?? raw.usd_size ?? 0),
        timestamp: raw.timestamp ? Math.floor(Number(raw.timestamp)) : Math.floor(Date.now() / 1000),
    };
}

async function getTradesForWallet(wallet) {
    const res = await axios.get(`${DATA_API}/activity`, {
        params: { user: wallet.toLowerCase(), limit: 100 },
        timeout: 10000,
        httpsAgent,
    });
    const raw = Array.isArray(res.data) ? res.data : res.data?.data ?? [];
    return raw
        .filter(
            (t) =>
                t.type === "TRADE" ||
                t.action === "TRADE" ||
                t.eventType === "TRADE" ||
                t.outcome !== undefined,
        )
        .map(normalizeTrade);
}

async function getMarketInfo(conditionId, tokenId) {
    const res = await axios.get(`${CLOB_API}/markets/${conditionId}`, {
        timeout: 10000,
        httpsAgent,
    });
    const d = res.data || {};
    const token = (d.tokens || []).find((t) => t.token_id === tokenId);
    return {
        tickSize: String(d.minimum_tick_size || "0.01"),
        negRisk: Boolean(d.neg_risk),
        outcome: token?.outcome || d.outcome || "",
        question: d.question || "",
    };
}

function getSigner() {
    const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY || "");
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = process.env.RPC_URL || "https://polygon-rpc.com";
    return {
        account,
        signer: createWalletClient({
            account,
            chain: polygon,
            transport: http(rpcUrl),
        }),
    };
}

async function createClientForMode({ signatureType, funder }) {
    const { signer } = getSigner();
    const temp = new ClobClient({
        host: CLOB_API,
        chain: Chain.POLYGON,
        signer,
        signatureType,
        funderAddress: funder,
    });
    const apiCreds = await temp.createOrDeriveApiKey();
    return {
        client: new ClobClient({
            host: CLOB_API,
            chain: Chain.POLYGON,
            signer,
            creds: apiCreds,
            signatureType,
            funderAddress: funder,
        }),
        signatureType,
        funder,
    };
}

function buildAuthModes() {
    const { account } = getSigner();
    const envFunder = (process.env.FUNDER_ADDRESS || "").trim();
    const envSig = Number(process.env.SIGNATURE_TYPE || 3);

    const modes = [
        { signatureType: envSig, funder: envFunder || account.address },
        { signatureType: 3, funder: envFunder || account.address },
        { signatureType: 1, funder: envFunder || account.address },
        { signatureType: 0, funder: account.address },
        { signatureType: 1, funder: account.address },
    ];

    const seen = new Set();
    return modes.filter((m) => {
        const k = `${m.signatureType}:${String(m.funder).toLowerCase()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function adjustPriceToTick(price, tickSize) {
    const tick = Number(tickSize || 0.01);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    const decimals = String(tickSize).includes(".")
        ? String(tickSize).split(".")[1].length
        : 0;
    const rounded = Math.round(price / tick) * tick;
    const clipped = Math.max(tick, Math.min(1 - tick, rounded));
    return Number(clipped.toFixed(Math.max(decimals, 2)));
}

function parseMinSize(reason) {
    const m = String(reason || "").match(/minimum:\s*([0-9]*\.?[0-9]+)/i);
    return m ? Number(m[1]) : null;
}

function isAuthRetryable(reason) {
    const text = String(reason || "").toLowerCase();
    return (
        text.includes("order_version_mismatch") ||
        text.includes("maker address not allowed") ||
        text.includes("deposit wallet flow")
    );
}

async function main() {
    const sourceWallet = process.argv[2] || process.env.SOURCE_WALLET || "";
    const copyUsdcArg = process.argv[3];

    if (!sourceWallet || sourceWallet.length < 10) {
        usage();
        process.exit(1);
    }

    console.log(`[Test] Fetching trades for ${sourceWallet} ...`);
    const trades = await getTradesForWallet(sourceWallet);
    if (!trades.length) {
        console.error("[Test] No trades found for this wallet.");
        process.exit(1);
    }

    const trade = [...trades].sort((a, b) => b.timestamp - a.timestamp)[0];
    const copySize = Number(copyUsdcArg);
    const finalSizeBase = Number.isFinite(copySize) && copySize > 0 ? copySize : trade.size;

    console.log("[Test] Selected latest trade:");
    console.log(
        `  ${trade.side} token=${trade.tokenId} market=${trade.market} price=${trade.price} originalSize=${trade.size}`,
    );
    console.log(`[Test] Copy size: $${finalSizeBase.toFixed(2)}`);

    const dryRun = process.env.DRY_RUN !== "false";
    if (dryRun) {
        console.log("[Test] Result:", {
            status: "DRY_RUN",
            orderId: undefined,
            reason: `DRY_RUN: ${trade.side} $${finalSizeBase.toFixed(2)} @ ${trade.price}`,
        });
        return;
    }

    if (finalSizeBase < Number(process.env.MIN_TRADE_USDC || 1)) {
        console.log("[Test] Result:", {
            status: "SKIPPED",
            reason: `Size too small: $${finalSizeBase.toFixed(2)}`,
        });
        return;
    }

    const market = await getMarketInfo(trade.market, trade.tokenId);
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    const orderTypeRaw = String(process.env.ORDER_TYPE || "GTC").toUpperCase();
    const adjustedPrice = adjustPriceToTick(trade.price, market.tickSize);
    let finalSize = finalSizeBase;
    const negRiskModes = [market.negRisk, !market.negRisk].filter(
        (v, i, arr) => arr.indexOf(v) === i,
    );

    let response;
    const authModes = buildAuthModes();
    for (const mode of authModes) {
        try {
            const { client, signatureType, funder } = await createClientForMode(mode);
            console.log(`[Test] Trying auth mode: signatureType=${signatureType} funder=${funder}`);
            for (const negRisk of negRiskModes) {
                const orderOpts = {
                    tickSize: market.tickSize,
                    negRisk,
                };
                console.log(`[Test] Trying order route: negRisk=${negRisk}`);
                if (orderTypeRaw === "FAK" || orderTypeRaw === "FOK") {
                    const amount = side === Side.BUY ? finalSize : trade.price > 0 ? finalSize / trade.price : 0;
                    response = await client.createAndPostMarketOrder(
                        {
                            tokenID: trade.tokenId,
                            price: trade.price,
                            amount,
                            side,
                        },
                        orderOpts,
                        orderTypeRaw === "FAK" ? OrderType.FAK : OrderType.FOK,
                    );
                } else {
                    const orderSize =
                        adjustedPrice > 0
                            ? (side === Side.BUY ? finalSize + 0.02 : finalSize) / adjustedPrice
                            : 0;
                    response = await client.createAndPostOrder(
                        {
                            tokenID: trade.tokenId,
                            price: adjustedPrice,
                            size: orderSize,
                            side,
                        },
                        orderOpts,
                        OrderType.GTC,
                    );
                }

                if (response?.success) break;
                const routeReason = response?.errorMsg || JSON.stringify(response) || "Order rejected";
                const minSize = parseMinSize(routeReason);
                if (minSize && finalSize < minSize) {
                    finalSize = minSize;
                    console.log(`[Test] Retrying with market minimum size: ${finalSize}`);
                    continue;
                }
                if (!isAuthRetryable(routeReason)) break;
            }

            if (response?.success) break;
            const reason = response?.errorMsg || JSON.stringify(response) || "Order rejected";
            if (!isAuthRetryable(reason)) break;
        } catch (err) {
            const message = err?.message || String(err);
            if (!isAuthRetryable(message)) {
                throw err;
            }
        }
    }

    if (!response || !response.success) {
        const reason = response?.errorMsg || JSON.stringify(response) || "Order rejected";
        console.log("[Test] Result:", { status: "FAILED", orderId: undefined, reason });
        process.exit(1);
    }

    console.log("[Test] Result:", {
        status: "PLACED",
        orderId: response.orderID,
        reason: undefined,
    });
}

main().catch((err) => {
    console.error("[Test] Fatal:", err?.message || err);
    process.exit(1);
});
