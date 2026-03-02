import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { validateAuthToken, verifyToken } from "./auth.js";
import { RateLimiter } from "./rate-limit.js";
import type {
  GatewayConfig,
  GatewayMessage,
  GatewayResponse,
} from "./types.js";

export class Gateway {
  private server: Server | null = null;
  private config: GatewayConfig;
  private rateLimiter: RateLimiter;
  private messageHandler:
    | ((msg: GatewayMessage) => Promise<GatewayResponse>)
    | null = null;

  constructor(config: GatewayConfig) {
    // Validate at construction — fail-closed
    validateAuthToken(config.authToken);
    this.config = config;
    this.rateLimiter = new RateLimiter(
      config.rateLimit.maxRequests,
      config.rateLimit.windowMs,
    );
  }

  /** Set the handler for incoming messages */
  onMessage(handler: (msg: GatewayMessage) => Promise<GatewayResponse>): void {
    this.messageHandler = handler;
  }

  /** Start the HTTP server */
  async start(): Promise<void> {
    if (this.server) return;

    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.config.port, this.config.host, () => {
        // Update port if 0 was used (random port assignment)
        const addr = server.address();
        if (addr && typeof addr === "object") {
          this.config = { ...this.config, port: addr.port };
        }
        resolve();
      });
    });

    this.server = server;
  }

  /** Stop the server */
  async stop(): Promise<void> {
    if (!this.server) return;

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Handle incoming HTTP request */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Only accept POST to /api/chat
    if (req.method !== "POST" || req.url !== "/api/chat") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", payload: "Not found" }));
      return;
    }

    // 1. Check auth header: Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", payload: "Unauthorized" }));
      return;
    }

    const token = authHeader.slice("Bearer ".length);
    if (!verifyToken(token, this.config.authToken)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", payload: "Unauthorized" }));
      return;
    }

    // 2. Check rate limit (use remote address as client ID)
    const clientId = req.socket.remoteAddress ?? "unknown";
    if (!this.rateLimiter.check(clientId)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", payload: "Rate limited" }));
      return;
    }

    // 3. Read body and parse JSON
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void this.processBody(chunks, res);
    });
  }

  private async processBody(
    chunks: Buffer[],
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = Buffer.concat(chunks).toString("utf8");
      const message = JSON.parse(body) as GatewayMessage;

      if (!this.messageHandler) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", payload: "No handler registered" }),
        );
        return;
      }

      const response = await this.messageHandler(message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", payload: "Invalid request body" }),
      );
    }
  }

  get isRunning(): boolean {
    return this.server !== null;
  }
}
