import { parsePositiveInt } from './utils/env.js';
import { TunnelManager } from './tunnel/tunnel-manager.js';
import { ensureTunnelKey, startTunnelApi } from './tunnel/tunnel-api.js';
import { HEALTH_PATH, PANEL_SERVICE } from './web/panel-paths.js';

/**
 * issue 0030：tunnel-manager 服務的進入點（Compose 以同一個主映像、不同命令啟動）。
 * 這個容器不放 Bot Token、不掛 data；只負責 cloudflared 的啟停。
 */

const HEALTH_TIMEOUT_MS = 5_000;

async function isPanelReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      redirect: 'error'
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { service?: unknown };
    return body.service === PANEL_SERVICE;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const keyFile = process.env.TUNNEL_KEY_FILE?.trim() || '/run/telenexus-tunnel/key';
  const host = process.env.TUNNEL_API_HOST?.trim() || '0.0.0.0';
  const port = parsePositiveInt(process.env.TUNNEL_API_PORT, 8790);
  const manager = new TunnelManager({
    cloudflaredBin: process.env.CLOUDFLARED_BIN?.trim() || 'cloudflared',
    targetUrl: process.env.TUNNEL_TARGET_URL?.trim() || 'http://telenexus:3040',
    healthCheck: isPanelReachable,
    startTimeoutMs: parsePositiveInt(process.env.TUNNEL_START_TIMEOUT_MS, 60_000)
  });
  const key = ensureTunnelKey(keyFile);
  const api = await startTunnelApi({ host, port, key, manager });
  console.log(`[TunnelManager] API listening on ${host}:${api.port}`);

  const shutdown = () => {
    void Promise.allSettled([manager.stop(), api.close()]).finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error('[TunnelManager] failed to start:', error);
  process.exit(1);
});
