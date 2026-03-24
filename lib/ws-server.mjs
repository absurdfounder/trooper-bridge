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
  constructor({ server, path = '/ws' }) {
    this.wss = new WebSocketServer({ server, path });
    this.clients = new Map(); // ws → { user, authenticated }
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

    // Heartbeat interval — close dead connections
    this._pingInterval = setInterval(() => {
      for (const [ws] of this.clients) {
        if (!ws.isAlive) {
          this.clients.delete(ws);
          return ws.terminate();
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
        // Authenticate with Firebase token
        const token = msg.token;
        if (!token) {
          ws.send(JSON.stringify({ type: 'error', message: 'Token required' }));
          return ws.close(4002, 'No token');
        }

        if (isAuthEnabled()) {
          const user = await verifyIdToken(token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            return ws.close(4003, 'Invalid token');
          }
          client.user = user;
          client.authenticated = true;
          console.log(`[WS] Authenticated: ${user.email || user.uid}`);
        } else {
          // Auth disabled — accept with basic info
          client.user = { uid: msg.uid || 'anonymous', email: msg.email || null, name: msg.name || 'User' };
          client.authenticated = true;
        }

        // Send init payload
        // TODO: populate with real data from SQLite once chat processing moves to bridge
        ws.send(JSON.stringify({
          type: 'init',
          user: client.user,
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
