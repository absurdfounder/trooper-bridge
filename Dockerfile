# Keep the CrabsHQ gateway current by rebuilding this image; it inherits the
# latest upstream OpenClaw runtime at build time, then layers our bridge code.
FROM ghcr.io/openclaw/openclaw:latest

USER root

# Install Chrome + TigerVNC + noVNC/websockify in a single layer
RUN apt-get update && \
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    (dpkg -i /tmp/chrome.deb || apt-get install -y -f) && \
    rm -f /tmp/chrome.deb && \
    apt-get install -y --no-install-recommends \
      tigervnc-standalone-server \
      novnc \
      websockify && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# OpenClaw installs bundled plugin runtime deps here at boot. The gateway runs
# as node, so this must be writable before plugins validate or startup degrades.
RUN mkdir -p /var/lib/openclaw/plugin-runtime-deps && \
    chown -R 1000:1000 /var/lib/openclaw && \
    chmod -R 777 /var/lib/openclaw/plugin-runtime-deps

# Chrome wrapper script (starts Xvnc + Chrome)
COPY chrome-wrapper.sh /opt/chrome-wrapper.sh
RUN chmod +x /opt/chrome-wrapper.sh

# Entrypoint wrapper (runs as root, chowns, drops to node)
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

# Simplified startup script
COPY startup.sh /opt/startup.sh
RUN chmod +x /opt/startup.sh

# Everything runs as node user
USER node

ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
