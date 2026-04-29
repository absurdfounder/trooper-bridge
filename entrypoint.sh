#!/bin/bash
# Root entrypoint wrapper: fix ownership then drop to node user via startup.sh
# docker-compose sets user: "0:0" so this runs as root initially

repair_openclaw_permissions() {
  # Fix ownership of mounted volumes (may have been created as root)
  chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
  chown -R 1000:1000 /home/node/.npm 2>/dev/null || true

  # OpenClaw writes config backups, session locks, devices, cron state, and
  # plugin mirrors during boot/restore. The host bridge and container node user
  # can have different UIDs, so mutable runtime dirs must be writable by either.
  find /home/node/.openclaw -type d -exec chmod 777 {} \; 2>/dev/null || true
  find /home/node/.openclaw -type f -exec chmod a+rw {} \; 2>/dev/null || true
  chmod 666 /home/node/.openclaw/openclaw.json /home/node/.openclaw/auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || true
  chmod 777 /home/node/.openclaw/devices /home/node/.openclaw/cron /home/node/.openclaw/cron/runs 2>/dev/null || true
  chmod 666 /home/node/.openclaw/devices/*.json /home/node/.openclaw/cron/*.json 2>/dev/null || true

  # OpenClaw's bundled plugins install/mirror runtime deps below /var/lib/openclaw
  # during validation. Keep it writable even if a prior reinstall made it root-owned.
  mkdir -p /var/lib/openclaw/plugin-runtime-deps 2>/dev/null || true
  chown -R 1000:1000 /var/lib/openclaw 2>/dev/null || true
  chmod -R 777 /var/lib/openclaw/plugin-runtime-deps 2>/dev/null || true

  # Identity files are read by the gateway as node; leave them readable after
  # the broad repair pass while avoiding execute bits on files.
  chmod 755 /home/node/.openclaw/identity 2>/dev/null || true
  chmod 644 /home/node/.openclaw/identity/*.json 2>/dev/null || true
}

repair_openclaw_permissions

# Clear jiti cache — previous runs may have created files as root.
# Use chmod 1777 (world-writable + sticky) so both root and node can create/read files.
# chown alone doesn't work because the gateway bootstrap creates files as root
# before su takes effect (Xvnc + node startup race).
rm -rf /tmp/jiti 2>/dev/null || true
mkdir -p /tmp/jiti && chmod 1777 /tmp/jiti

# Background: keep repairing through the restore/cutover window. Reinstall
# restores config, sessions, devices, and plugin mirrors after container start.
(for i in $(seq 1 90); do sleep 4; repair_openclaw_permissions; done) &

# Hand off to startup.sh (which drops to node for the gateway process)
exec /bin/bash /opt/startup.sh "$@"
