#!/usr/bin/env node
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CliAdapter } from "./adapter.js";
import { runOnboarding } from "./commands/onboard.js";

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
    "  serve             Start the gateway HTTP server + webchat",
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
  const adapter = new CliAdapter(process.stdin, process.stdout);

  adapter.onMessage(async () => {
    return {
      content:
        "SafeClaw is not fully configured. Run 'safeclaw onboard' first.",
    };
  });

  process.stdout.write(
    "\nSafeClaw Interactive Chat (placeholder wiring)\n",
  );
  process.stdout.write(
    "Note: Full agent/session creation requires vault + Copilot auth.\n",
  );
  process.stdout.write(
    "Run 'safeclaw onboard' to complete setup.\n\n",
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
  });
}

function runAuditCommand(_jsonFlag: boolean): void {
  process.stdout.write(
    "\nSafeClaw Security Audit\n",
  );
  process.stdout.write(
    "=======================\n\n",
  );
  process.stdout.write(
    "Audit requires a running SafeClaw instance (registry, sessionManager, auditLog).\n",
  );
  process.stdout.write(
    "Run 'safeclaw serve' first, then use audit to inspect the running instance.\n\n",
  );
}

function runServe(): void {
  process.stdout.write(
    "\nStarting SafeClaw gateway server...\n\n",
  );
  process.stdout.write(
    "This is a placeholder. Full wiring requires:\n",
  );
  process.stdout.write(
    "  - Vault unlock (passphrase or keyring)\n",
  );
  process.stdout.write(
    "  - Copilot authentication\n",
  );
  process.stdout.write(
    "  - Agent + session initialization\n",
  );
  process.stdout.write(
    "  - Gateway + WebChat adapter binding\n\n",
  );
  process.stdout.write(
    "Run 'safeclaw onboard' first to configure credentials.\n",
  );
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
      runAuditCommand(jsonFlag);
      break;
    }

    case "serve":
      runServe();
      break;

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
