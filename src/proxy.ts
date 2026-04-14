import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

let agent: SocksProxyAgent | null = null;

export function setupProxy(proxyUrl: string): void {
  if (!proxyUrl) return;

  agent = new SocksProxyAgent(proxyUrl);

  // Inject SOCKS agent into every axios request that doesn't already have one.
  // polymarketApi.ts sets directAgent explicitly to bypass this.
  axios.interceptors.request.use((cfg) => {
    if (!cfg.httpsAgent) cfg.httpsAgent = agent;
    if (!cfg.httpAgent) cfg.httpAgent = agent;
    return cfg;
  });

  console.log(`[Proxy] Orders routed via WARP: ${proxyUrl}`);
}

/** Verifies the proxy is reachable and logs the exit IP. Call after setupProxy(). */
export async function verifyProxy(): Promise<void> {
  if (!agent) return;
  try {
    const res = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent: agent,
      httpAgent: agent,
      timeout: 8_000,
    });
    console.log(`[Proxy] ✅ Exit IP: ${res.data?.ip}`);
  } catch (err: any) {
    console.error(`[Proxy] ❌ WARP unreachable: ${err.message}`);
    console.error(
      `[Proxy] ⚠️  Orders will be sent WITHOUT proxy — may be geoblocked!`,
    );
  }
}

export function getProxyAgent(): SocksProxyAgent | undefined {
  return agent ?? undefined;
}
