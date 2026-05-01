// Periodic boot + interval heartbeat to Crabs-HQ /api/fleet/heartbeat.
//
// Lets Crabs-HQ track which VPS runs what version without scraping every
// bridge with /health on a poll. Boot heartbeat fires immediately so a
// freshly-provisioned VPS shows up in the fleet view within seconds; the
// 5-minute ticker keeps long-running bridges alive in the dashboard and
// surfaces drift introduced by an out-of-band /update.
//
// Fails closed: if MISSION_CONTROL_URL or ORG_ID is unset (dev / unconfigured),
// the heartbeat is a no-op. Network failures are logged but never thrown.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;

export function startFleetHeartbeat({
  missionControlUrl,
  orgId,
  bridgeAuthToken,
  port,
  readVersion,
  bootedAt = new Date().toISOString(),
  intervalMs = DEFAULT_INTERVAL_MS,
  log = console,
} = {}) {
  if (!missionControlUrl || !orgId) {
    log.log?.('[fleet] heartbeat disabled (missionControlUrl or orgId missing)');
    return { stop: () => {}, send: async () => {} };
  }

  const url = `${String(missionControlUrl).replace(/\/$/, '')}/api/fleet/heartbeat`;

  const send = async (reason) => {
    let version = null;
    try {
      version = readVersion?.() ?? null;
    } catch (err) {
      log.warn?.(`[fleet] readVersion failed: ${err.message}`);
    }

    const payload = {
      orgId,
      reason,
      bootedAt,
      sentAt: new Date().toISOString(),
      port: port ?? null,
      version,
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (bridgeAuthToken) headers.Authorization = `Bearer ${bridgeAuthToken}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn?.(`[fleet] heartbeat ${reason} got HTTP ${res.status}`);
      }
    } catch (err) {
      log.warn?.(`[fleet] heartbeat ${reason} failed: ${err.message}`);
    }
  };

  // Initial boot heartbeat — fire-and-forget so we never block server.listen().
  send('boot');

  const handle = setInterval(() => { send('periodic'); }, intervalMs);
  // Keep heartbeat from blocking process exit during graceful shutdown.
  if (typeof handle.unref === 'function') handle.unref();

  return {
    stop: () => clearInterval(handle),
    send,
  };
}
