export function adjustPriceToTick(price: number, tickSize: string): number {
  const tick = Number(tickSize || 0.01);
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const rounded = Math.round(price / tick) * tick;
  const clipped = Math.max(tick, Math.min(1 - tick, rounded));
  const decimals = String(tickSize).includes(".")
    ? String(tickSize).split(".")[1].length
    : 2;
  return Number(clipped.toFixed(Math.max(decimals, 2)));
}

export function toLimitOrderSizeShares(
  side: "BUY" | "SELL",
  notionalUsdc: number,
  adjustedPrice: number,
): number {
  if (adjustedPrice <= 0) return 0;
  // Tiny BUY buffer avoids falling just below $1 minimum due to rounding.
  const adjustedNotional = side === "BUY" ? notionalUsdc + 0.02 : notionalUsdc;
  return adjustedNotional / adjustedPrice;
}
