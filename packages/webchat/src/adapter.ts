import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  PeerIdentity,
} from "@safeclaw/core";

const STATIC_DIR = resolve(
  join(fileURLToPath(import.meta.url), "..", "static"),
);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

export interface WebChatOptions {
  /** Port to listen on (0 = random) */
  port?: number | undefined;
  /** Whether to serve static files. Set to false to disable (for tests). Defaults to true. */
  staticDir?: boolean | undefined;
}

export class WebChatAdapter implements ChannelAdapter {
  readonly id = "webchat";
  private server: Server | null = null;
  private handler:
    | ((msg: InboundMessage) => Promise<OutboundMessage>)
    | null = null;
  private readonly requestedPort: number;
  private readonly serveStatic: boolean;
  private assignedPort = 0;

  constructor(options?: WebChatOptions) {
    this.requestedPort = options?.port ?? 0;
    this.serveStatic = options?.staticDir !== false;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  get port(): number {
    return this.assignedPort;
  }

  async connect(): Promise<void> {
    if (this.server) return;

    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.requestedPort, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.assignedPort = addr.port;
        }
        resolve();
      });
    });

    this.server = server;
  }

  async disconnect(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = null;
    this.assignedPort = 0;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onMessage(
    handler: (msg: InboundMessage) => Promise<OutboundMessage>,
  ): void {
    this.handler = handler;
  }

  async send(
    _peer: PeerIdentity,
    _content: OutboundMessage,
  ): Promise<void> {
    // No-op: responses flow through handleChatMessage return value
  }

  /**
   * Process an incoming chat message from the SPA.
   * Called by the gateway's message handler.
   */
  async handleChatMessage(
    peerId: string,
    content: string,
  ): Promise<OutboundMessage> {
    if (!this.isRunning) {
      return { content: "Error: adapter not connected" };
    }

    if (!this.handler) {
      return { content: "Error: No handler registered" };
    }

    const inbound: InboundMessage = {
      peer: { channelId: "webchat", peerId },
      content,
      timestamp: new Date(),
    };

    try {
      return await this.handler(inbound);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      return { content: `Error: ${message}` };
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!this.serveStatic) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    void this.serveStaticFile(req, res);
  }

  private async serveStaticFile(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");

    // Security: only serve known extensions
    const ext = extname(url);
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Security: resolve-based path traversal defense
    const filePath = resolve(join(STATIC_DIR, url));
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }
}
