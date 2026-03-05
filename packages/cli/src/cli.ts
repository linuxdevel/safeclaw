#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { CliAdapter } from "./adapter.js";
import { runOnboarding } from "./commands/onboard.js";
import { bootstrapAgent } from "./commands/bootstrap.js";
import { runAudit } from "./commands/audit.js";
import { runDoctor } from "./commands/doctor.js";
import { setupChat } from "./commands/chat.js";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "@safeclaw/gateway";
import { WebChatAdapter } from "@safeclaw/webchat";
import { listCopilotModels, DEFAULT_AGENT_CONFIG } from "@safeclaw/core";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

function printUsage(output: NodeJS.WritableStream): void {
  const lines = [
    "",
    "SafeClaw — AI coding agent with mandatory sandboxing",
    "",
    "Usage: safeclaw [command] [options]",
    "",
    "Commands:",
    "  chat              Start an interactive chat session (default)",
    "  onboard           Run the onboarding wizard",
    "  audit [--json]    Run a security audit of the running instance",
    "  serve|server      Start the gateway HTTP server + webchat",
    "  doctor            Run system diagnostics and health checks",
    "  help              Show this help message",
    "  version           Print the version",
    "",
    "Options:",
    "  --help            Show this help message",
    "  --version         Print the version",
    "",
  ];
  for (const line of lines) {
    output.write(line + "\n");
  }
}

function printVersion(output: NodeJS.WritableStream): void {
  output.write(`safeclaw v${pkg.version}\n`);
}

async function runChat(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { agent, sessionManager } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  const adapter = new CliAdapter(process.stdin, process.stdout);
  const session = sessionManager.getOrCreate({
    channelId: "cli",
    peerId: "local",
  });

  setupChat(adapter, agent, session, {
    sessionManager,
    model: DEFAULT_AGENT_CONFIG.model,
  });

  process.stdout.write("\nSafeClaw Interactive Chat\n");
  process.stdout.write(
    "Type your message and press Enter. Ctrl+C to exit.\n\n",
  );

  await adapter.connect();
}

async function runOnboard(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  mkdirSync(safeclawDir, { recursive: true });

  await runOnboarding({
    input: process.stdin,
    output: process.stdout,
    vaultPath: path.join(safeclawDir, "vault.json"),
    listModels: listCopilotModels,
  });
}

async function runAuditCommand(jsonFlag: boolean): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { capabilityRegistry, sessionManager, auditLog } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  runAudit({
    output: process.stdout,
    registry: capabilityRegistry,
    sessionManager,
    auditLog,
    format: jsonFlag ? "json" : "text",
  });
}

async function runServe(): Promise<void> {
  const safeclawDir = path.join(os.homedir(), ".safeclaw");
  const vaultPath = path.join(safeclawDir, "vault.json");

  const { agent, sessionManager } = await bootstrapAgent({
    input: process.stdin,
    output: process.stdout,
    vaultPath,
  });

  // Generate random auth token for this session
  const authToken = randomBytes(32).toString("hex");

  const gateway = new Gateway({
    ...DEFAULT_GATEWAY_CONFIG,
    authToken,
  });

  const webchat = new WebChatAdapter({ port: 0 });

  // Wire gateway to agent via session manager
  gateway.onMessage(async (msg) => {
    if (msg.type === "ping") {
      return { type: "pong" as const, payload: null };
    }

    const peer = { channelId: "gateway", peerId: "api-client" };
    const session = sessionManager.getOrCreate(peer);
    const response = await agent.processMessage(session, String(msg.payload));
    await sessionManager.save(session.id);
    return { type: "response" as const, payload: response.message };
  });

  // Wire WebSocket handler for streaming responses
  gateway.onWsMessage(async (content, send) => {
    const peer = { channelId: "gateway-ws", peerId: "ws-client" };
    const session = sessionManager.getOrCreate(peer);

    const stream = agent.processMessageStream(session, content);
    for await (const event of stream) {
      switch (event.type) {
        case "text_delta":
          send({ type: "text_delta", content: event.content });
          break;
        case "tool_start":
          send({
            type: "tool_start",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
          });
          break;
        case "tool_result":
          send({
            type: "tool_result",
            toolCallId: event.toolCallId,
            result: event.result,
            success: event.success,
          });
          break;
        case "done":
          send({ type: "done", response: event.response });
          break;
        case "error":
          send({ type: "error", message: event.error });
          break;
      }
    }

    await sessionManager.save(session.id);
  });

  // Wire webchat adapter to agent
  webchat.onMessage(async (msg) => {
    const session = sessionManager.getOrCreate(msg.peer);
    const response = await agent.processMessage(session, msg.content);
    await sessionManager.save(session.id);
    return { content: response.message };
  });

  await gateway.start();
  await webchat.connect();

  process.stdout.write("\nSafeClaw server started\n");
  process.stdout.write(
    `  Gateway API:  http://${DEFAULT_GATEWAY_CONFIG.host}:${DEFAULT_GATEWAY_CONFIG.port}/api/chat\n`,
  );
  process.stdout.write(
    `  WebSocket:    ws://${DEFAULT_GATEWAY_CONFIG.host}:${DEFAULT_GATEWAY_CONFIG.port}/\n`,
  );
  process.stdout.write(`  WebChat UI:   http://127.0.0.1:${webchat.port}/\n`);
  process.stdout.write(`  Auth token:   ${authToken}\n\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    process.stdout.write("\nShutting down...\n");
    await Promise.all([gateway.stop(), webchat.disconnect()]);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Keep process alive
  await new Promise(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "chat";

  switch (command) {
    case "chat":
      await runChat();
      break;

    case "onboard":
      await runOnboard();
      break;

    case "audit": {
      const jsonFlag = args.includes("--json");
      await runAuditCommand(jsonFlag);
      break;
    }

    case "serve":
    case "server":
      await runServe();
      break;

    case "doctor": {
      const exitCode = await runDoctor({ output: process.stdout });
      process.exit(exitCode);
      break;
    }

    case "help":
    case "--help":
      printUsage(process.stdout);
      break;

    case "version":
    case "--version":
      printVersion(process.stdout);
      break;

    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.stderr.write("Run 'safeclaw help' for usage information.\n");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
