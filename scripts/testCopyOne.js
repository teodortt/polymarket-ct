#!/usr/bin/env node
const dotenv = require("dotenv");
const axios = require("axios");
const https = require("https");
const { ClobClient, Side, OrderType } = require("@polymarket/clob-client");
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
        tickSize: d.minimum_tick_size || "0.01",
        negRisk: Boolean(d.neg_risk),
        outcome: token?.outcome || d.outcome || "",
        question: d.question || "",
    };
}

async function initClient() {
    const privateKey = normalizePrivateKey(process.env.PRIVATE_KEY || "");
    const chainId = Number(process.env.CHAIN_ID || 137);
    const signatureType = Number(process.env.SIGNATURE_TYPE || 0);
    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    const funder = process.env.FUNDER_ADDRESS || account.address;

    const temp = new ClobClient(CLOB_API, chainId, signer, undefined, signatureType, funder);
    const apiCreds = await temp.createOrDeriveApiKey();
    return new ClobClient(CLOB_API, chainId, signer, apiCreds, signatureType, funder);
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
    const finalSize = Number.isFinite(copySize) && copySize > 0 ? copySize : trade.size;

    console.log("[Test] Selected latest trade:");
    console.log(
        `  ${trade.side} token=${trade.tokenId} market=${trade.market} price=${trade.price} originalSize=${trade.size}`,
    );
    console.log(`[Test] Copy size: $${finalSize.toFixed(2)}`);

    const dryRun = process.env.DRY_RUN !== "false";
    if (dryRun) {
        console.log("[Test] Result:", {
            status: "DRY_RUN",
            orderId: undefined,
            reason: `DRY_RUN: ${trade.side} $${finalSize.toFixed(2)} @ ${trade.price}`,
        });
        return;
    }

    if (finalSize < Number(process.env.MIN_TRADE_USDC || 1)) {
        console.log("[Test] Result:", {
            status: "SKIPPED",
            reason: `Size too small: $${finalSize.toFixed(2)}`,
        });
        return;
    }

    const market = await getMarketInfo(trade.market, trade.tokenId);
    const client = await initClient();
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    const orderTypeRaw = String(process.env.ORDER_TYPE || "FAK").toUpperCase();
    const orderOpts = {
        tickSize: market.tickSize,
        negRisk: market.negRisk,
    };

    let response;
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
        response = await client.createAndPostOrder(
            {
                tokenID: trade.tokenId,
                price: trade.price,
                size: finalSize,
                side,
            },
            orderOpts,
            OrderType.GTC,
        );
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
