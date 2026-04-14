import { WalletConfig } from "./types";
import { config } from "./config";

export class WalletConfigStore {
  private configs: Map<string, WalletConfig> = new Map();

  add(wallet: string, overrides: Partial<WalletConfig> = {}): WalletConfig {
    const key = wallet.toLowerCase();
    const cfg: WalletConfig = {
      wallet,
      label: overrides.label,
      enabled: overrides.enabled ?? true,
      sizeMultiplier: overrides.sizeMultiplier ?? config.sizeMultiplier,
      sizePercent: overrides.sizePercent ?? 0, // 0 = not set
      maxTradeUsdc: overrides.maxTradeUsdc ?? config.maxTradeUsdc,
      copySizeUsdc: overrides.copySizeUsdc ?? config.copySizeUsdc,
    };
    this.configs.set(key, cfg);
    return cfg;
  }

  remove(wallet: string): boolean {
    return this.configs.delete(wallet.toLowerCase());
  }

  get(wallet: string): WalletConfig | undefined {
    return this.configs.get(wallet.toLowerCase());
  }

  getAll(): WalletConfig[] {
    return Array.from(this.configs.values());
  }

  update(wallet: string, patch: Partial<WalletConfig>): WalletConfig | null {
    const key = wallet.toLowerCase();
    const existing = this.configs.get(key);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.configs.set(key, updated);
    return updated;
  }

  has(wallet: string): boolean {
    return this.configs.has(wallet.toLowerCase());
  }

  /**
   * Priority order:
   * 1. copySizeUsdc > 0  → fixed USDC amount
   * 2. sizePercent > 0   → % of original trade size
   * 3. sizeMultiplier    → multiplier of original size
   * Always capped by maxTradeUsdc.
   */
  calcSize(wallet: string, originalSize: number): number {
    const cfg = this.get(wallet);
    if (!cfg) return 0;

    let size: number;
    if (cfg.copySizeUsdc > 0) {
      size = cfg.copySizeUsdc;
    } else if (cfg.sizePercent > 0) {
      size = originalSize * (cfg.sizePercent / 100);
    } else {
      size = originalSize * cfg.sizeMultiplier;
    }

    return Math.min(size, cfg.maxTradeUsdc);
  }

  // Human-readable description of the sizing mode
  sizeModeLabel(wallet: string): string {
    const cfg = this.get(wallet);
    if (!cfg) return "—";
    if (cfg.copySizeUsdc > 0) return `Fixed $${cfg.copySizeUsdc}`;
    if (cfg.sizePercent > 0) return `${cfg.sizePercent}% of trade`;
    return `${cfg.sizeMultiplier}x multiplier`;
  }
}
