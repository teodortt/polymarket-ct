import axios from "axios";
import type { Agent as HttpAgent } from "http";

// socks-proxy-agent v10 is ESM-only. Load it via a real dynamic import so the
// TypeScript CommonJS emitter does not rewrite it to require().
const importEsm = new Function("specifier", "return import(specifier)") as <
  T = unknown,
>(
  specifier: string,
) => Promise<T>;

let agent: HttpAgent | null = null;

export async function setupProxy(proxyUrl: string): Promise<void> {
  if (!proxyUrl) return;

  const mod = await importEsm<{
    SocksProxyAgent: new (url: string) => HttpAgent;
  }>("socks-proxy-agent");
  agent = new mod.SocksProxyAgent(proxyUrl);

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

export function getProxyAgent(): HttpAgent | undefined {
  return agent ?? undefined;
}
