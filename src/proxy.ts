import axios from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";

let agent: SocksProxyAgent | null = null;

/**
 * Call once at startup. Patches Node's global HTTP/HTTPS agents so that
 * ALL outgoing requests (axios, ClobClient, telegraf, etc.) go through the proxy.
 */
export function setupProxy(proxyUrl: string): void {
  if (!proxyUrl) return;

  agent = new SocksProxyAgent(proxyUrl);

  // Use an interceptor so every axios call (including ClobClient's) gets the
  // SOCKS agent injected — unless the caller already set an explicit httpsAgent
  // (e.g. polymarketApi.ts uses directAgent to bypass the proxy).
  axios.interceptors.request.use((cfg) => {
    if (!cfg.httpsAgent) cfg.httpsAgent = agent;
    if (!cfg.httpAgent) cfg.httpAgent = agent;
    return cfg;
  });

  console.log(`[Proxy] Orders routed via WARP: ${proxyUrl}`);
}

/** Returns the proxy agent for explicit use in axios calls. */
export function getProxyAgent(): SocksProxyAgent | undefined {
  return agent ?? undefined;
}
