import { WebSocketServer } from 'ws';
import { verifyIdToken, isAuthEnabled } from './firebase-auth.mjs';
import { captureLog } from './log-buffer.mjs';

/**
 * BridgeWSServer — manages browser WebSocket connections
 *
 * Protocol (same as current Render WS):
 * - Client sends: { type: 'identify', token: '<firebase-id-token>' }
 * - Server sends: { type: 'init', agents: [...], messages: [...], ... }
 * - Client sends: { type: 'chat:send', content: '...', ... }
 * - Server broadcasts: { type: 'message', ... }, { type: 'agent:typing', ... }, etc.
 */
export class BridgeWSServer {
  constructor({ server, path = '/ws', bridgeAuthToken = '' }) {
    this.wss = new WebSocketServer({ server, path });
    this.clients = new Map(); // ws → { user, authenticated }
    this.bridgeAuthToken = typeof bridgeAuthToken === 'string' ? bridgeAuthToken.trim() : '';
    this._setupHandlers();
    console.log(`[WS] Bridge WebSocket server ready on path ${path}`);
    captureLog('info', `WebSocket server ready on ${path}`);
  }

  _setupHandlers() {
    this.wss.on('connection', (ws, req) => {
      console.log(`[WS] New connection from ${req.socket.remoteAddress}`);
      this.clients.set(ws, { user: null, authenticated: false, connectedAt: Date.now() });

      // Auth timeout — must identify within 10s
      const authTimeout = setTimeout(() => {
        if (!this.clients.get(ws)?.authenticated) {
          ws.close(4001, 'Authentication timeout');
          this.clients.delete(ws);
        }
      }, 10000);

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await this._handleMessage(ws, msg);
        } catch (err) {
          console.warn('[WS] Message parse error:', err.message);
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimeout);
        const client = this.clients.get(ws);
        if (client?.user) {
          console.log(`[WS] Client disconnected: ${client.user.email || client.user.uid}`);
        }
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.warn('[WS] Client error:', err.message);
        this.clients.delete(ws);
      });

      // Ping/pong keepalive
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
    });

    // Heartbeat interval — close dead connections.
    // NOTE: this is a for...of loop, not Array.forEach, so a bare `return` would
    // abort the ENTIRE sweep at the first dead socket — leaving later clients
    // un-pinged (no keepalive, isAlive never reset) and additional dead sockets
    // un-reaped until subsequent ticks. Use `continue` so every client is
    // serviced on every tick.
    this._pingInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if (!ws.isAlive) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
  }

  async _handleMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (msg.type) {
      case 'identify': {
        // Accept either the bridge auth token (server-to-server) or a Firebase ID token.
        const token = typeof msg.token === 'string' ? msg.token.trim() : '';
        const isBridgeInternal = !!this.bridgeAuthToken && token === this.bridgeAuthToken;

        if (isBridgeInternal) {
          client.user = {
            uid: msg.uid || 'bridge-internal',
            email: null,
            name: msg.name || 'Bridge Internal',
            role: msg.role || 'server',
          };
          client.authenticated = true;
          client.authMode = 'bridge-token';
          console.log(`[WS] Authenticated internal client: ${client.user.name}`);
        } else if (!token && (isAuthEnabled() || this.bridgeAuthToken)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Token required' }));
          return ws.close(4002, 'No token');
        }
        
        if (!client.authenticated && isAuthEnabled()) {
          const user = await verifyIdToken(token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            return ws.close(4003, 'Invalid token');
          }
          client.user = user;
          client.authenticated = true;
          client.authMode = 'firebase';
          console.log(`[WS] Authenticated: ${user.email || user.uid}`);
        } else if (!client.authenticated) {
          // Auth disabled — accept with basic info
          client.user = { uid: msg.uid || 'anonymous', email: msg.email || null, name: msg.name || 'User' };
          client.authenticated = true;
          client.authMode = 'none';
        }

        // Send init payload — include recent messages for replay
        let recentMessages = [];
        try {
          const { getRecentMessages } = await import('./chat-handler.mjs');
          recentMessages = getRecentMessages('general', 50);
        } catch (_) { /* chat-handler not available yet */ }

        // Include the user's task snapshot so direct-bridge clients don't
        // lose their tasks after a WS reconnect / logout+login. Scoped to
        // the authenticated user (with legacy creator_id=null rows kept
        // visible — see listTasks in task-handler.mjs).
        let recentTasks = [];
        try {
          const { listTasks } = await import('./task-handler.mjs');
          recentTasks = listTasks({ userId: client.user?.uid, limit: 200 });
        } catch (_) { /* task-handler not available yet */ }

        ws.send(JSON.stringify({
          type: 'init',
          user: client.user,
          messages: recentMessages,
          tasks: recentTasks,
          serverTime: Date.now(),
          capabilities: {
            directBridge: true,  // flag so frontend knows it's on direct bridge
          },
        }));
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        break;

      case 'chat:send':
        // TODO Phase 4: process chat messages on bridge
        // For now, acknowledge receipt
        if (!client.authenticated) return;
        this._onChatMessage?.(msg, client.user, ws);
        break;

      case 'stop_generation':
        if (!client.authenticated) return;
        this._onStopGeneration?.(msg, client.user, ws);
        break;

      default:
        // Forward unknown message types to handler if registered
        if (this._onMessage) {
          this._onMessage(msg, client.user, ws);
        }
        break;
    }
  }

  /**
   * Broadcast a message to all authenticated clients.
   */
  broadcast(type, data) {
    const payload = JSON.stringify({ type, ...data });
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  /**
   * Send to a specific user by uid.
   */
  sendToUser(uid, type, data) {
    const payload = JSON.stringify({ type, ...data });
    for (const [ws, client] of this.clients) {
      if (client.user?.uid === uid && ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  /**
   * Register handlers for chat processing (called from index.mjs).
   */
  onChatMessage(handler) { this._onChatMessage = handler; }
  onStopGeneration(handler) { this._onStopGeneration = handler; }
  onMessage(handler) { this._onMessage = handler; }

  /**
   * Get count of connected + authenticated clients.
   */
  get clientCount() {
    let count = 0;
    for (const [, client] of this.clients) {
      if (client.authenticated) count++;
    }
    return count;
  }

  /**
   * Cleanup.
   */
  close() {
    clearInterval(this._pingInterval);
    this.wss.close();
  }
}
