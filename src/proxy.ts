import { SocksProxyAgent } from "socks-proxy-agent";

let agent: SocksProxyAgent | null = null;

/**
 * Call once at startup. Patches Node's global HTTP/HTTPS agents so that
 * ALL outgoing requests (axios, ClobClient, telegraf, etc.) go through the proxy.
 */
export function setupProxy(proxyUrl: string): void {
  if (!proxyUrl) return;

  agent = new SocksProxyAgent(proxyUrl);

  console.log(`[Proxy] Traffic routed via WARP: ${proxyUrl}`);
}

/** Returns the proxy agent for explicit use in axios calls. */
export function getProxyAgent(): SocksProxyAgent | undefined {
  return agent ?? undefined;
}
