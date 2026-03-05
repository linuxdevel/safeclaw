import { WebSocketServer, type WebSocket } from "ws";
import type { Server, IncomingMessage } from "node:http";
import { verifyToken } from "./auth.js";
import type { RateLimiter } from "./rate-limit.js";
import type { WsClientMessage, WsServerMessage } from "./ws-types.js";

export interface WebSocketHandlerConfig {
  server: Server;
  authToken: string;
  rateLimiter: RateLimiter;
}

/** Handler for a single authenticated connection */
interface AuthenticatedConnection {
  ws: WebSocket;
  clientId: string;
  authenticated: boolean;
}

export type WsMessageHandler = (
  content: string,
  send: (msg: WsServerMessage) => void,
) => Promise<void>;

export class WebSocketHandler {
  private wss: WebSocketServer;
  private config: WebSocketHandlerConfig;
  private connections = new Set<AuthenticatedConnection>();
  private messageHandler: WsMessageHandler | null = null;

  constructor(config: WebSocketHandlerConfig) {
    this.config = config;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Register a handler for authenticated chat messages */
  onMessage(handler: WsMessageHandler): void {
    this.messageHandler = handler;
  }

  /** Attach to the HTTP server's upgrade event */
  attach(): void {
    this.config.server.on("upgrade", (req, socket, head) => {
      // Check for query parameter auth
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const queryToken = url.searchParams.get("token");

      if (queryToken) {
        // Validate token from query param
        if (!verifyToken(queryToken, this.config.authToken)) {
          // Reject the upgrade by closing the socket
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\n" +
              "Connection: close\r\n" +
              "\r\n",
          );
          socket.destroy();
          return;
        }

        // Token valid -- complete upgrade as pre-authenticated
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleConnection(ws, req, true);
        });
        return;
      }

      // No query token -- upgrade and require auth via first message
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleConnection(ws, req, false);
      });
    });
  }

  /** Close all connections and the WebSocket server */
  close(): void {
    for (const conn of this.connections) {
      conn.ws.close(1001, "Server shutting down");
    }
    this.connections.clear();
    this.wss.close();
  }

  private handleConnection(
    ws: WebSocket,
    req: IncomingMessage,
    preAuthenticated: boolean,
  ): void {
    const clientId = req.socket.remoteAddress ?? "unknown";

    const conn: AuthenticatedConnection = {
      ws,
      clientId,
      authenticated: preAuthenticated,
    };

    this.connections.add(conn);

    ws.on("message", (data) => {
      void this.handleMessage(conn, data);
    });

    ws.on("close", () => {
      this.connections.delete(conn);
    });

    ws.on("error", () => {
      this.connections.delete(conn);
    });
  }

  private async handleMessage(
    conn: AuthenticatedConnection,
    data: unknown,
  ): Promise<void> {
    // Parse message
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(String(data)) as WsClientMessage;
    } catch {
      this.sendTo(conn.ws, { type: "error", message: "Invalid JSON" });
      conn.ws.close(4002, "Invalid JSON");
      this.connections.delete(conn);
      return;
    }

    // Require auth as first message if not pre-authenticated
    if (!conn.authenticated) {
      if (msg.type !== "auth") {
        this.sendTo(conn.ws, {
          type: "auth_error",
          reason: "First message must be auth",
        });
        conn.ws.close(4001, "Not authenticated");
        this.connections.delete(conn);
        return;
      }

      if (!verifyToken(msg.token, this.config.authToken)) {
        this.sendTo(conn.ws, {
          type: "auth_error",
          reason: "Invalid token",
        });
        conn.ws.close(4001, "Invalid token");
        this.connections.delete(conn);
        return;
      }

      conn.authenticated = true;
      this.sendTo(conn.ws, { type: "auth_ok" });
      return;
    }

    // Authenticated -- handle message types
    switch (msg.type) {
      case "auth":
        // Already authenticated, ignore re-auth
        this.sendTo(conn.ws, { type: "auth_ok" });
        break;

      case "ping":
        this.sendTo(conn.ws, { type: "pong" });
        break;

      case "chat":
        await this.handleChat(conn, msg.content);
        break;

      default:
        this.sendTo(conn.ws, {
          type: "error",
          message: "Unknown message type",
        });
    }
  }

  private async handleChat(
    conn: AuthenticatedConnection,
    content: string,
  ): Promise<void> {
    // Rate limit check
    if (!this.config.rateLimiter.check(conn.clientId)) {
      this.sendTo(conn.ws, {
        type: "error",
        message: "Rate limited",
      });
      return;
    }

    if (!this.messageHandler) {
      this.sendTo(conn.ws, {
        type: "error",
        message: "No handler registered",
      });
      return;
    }

    try {
      await this.messageHandler(content, (msg) => this.sendTo(conn.ws, msg));
    } catch (err: unknown) {
      this.sendTo(conn.ws, {
        type: "error",
        message: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  private sendTo(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
