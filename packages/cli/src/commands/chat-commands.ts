import type { Agent, Session, SessionManager } from "@safeclaw/core";
import { PassThrough } from "node:stream";
import { runDoctor } from "./doctor.js";

export interface ChatCommandDeps {
  session: Session;
  sessionManager: SessionManager;
  agent: Agent;
  model: string;
}

export class ChatCommandHandler {
  private readonly deps: ChatCommandDeps;
  private model: string;

  constructor(deps: ChatCommandDeps) {
    this.deps = deps;
    this.model = deps.model;
  }

  isCommand(input: string): boolean {
    return input.startsWith("/");
  }

  async execute(input: string): Promise<string> {
    const parts = input.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);

    switch (command) {
      case "help":
        return this.helpCommand();
      case "new":
        return this.newCommand();
      case "status":
        return this.statusCommand();
      case "compact":
        return this.compactCommand();
      case "model":
        return this.modelCommand(args);
      case "doctor":
        return this.doctorCommand();
      default:
        return `Unknown command: /${command}. Type /help for available commands.`;
    }
  }

  getModel(): string {
    return this.model;
  }

  private helpCommand(): string {
    const lines = [
      "Available commands:",
      "  /new      Clear session history and start fresh",
      "  /status   Show session metadata and current model",
      "  /compact  Compact conversation context (placeholder)",
      "  /model    Show or change the current model",
      "  /doctor   Run system diagnostics and health checks",
      "  /help     Show this help message",
    ];
    return lines.join("\n");
  }

  private newCommand(): string {
    this.deps.session.clearHistory();
    return "Session cleared. Starting fresh.";
  }

  private statusCommand(): string {
    const meta = this.deps.session.metadata;
    const lines = [
      "Session Status:",
      `  Session ID:     ${meta.id}`,
      `  Model:          ${this.model}`,
      `  Messages:       ${meta.messageCount}`,
      `  Created:        ${meta.createdAt.toISOString()}`,
      `  Last activity:  ${meta.updatedAt.toISOString()}`,
    ];
    return lines.join("\n");
  }

  private compactCommand(): string {
    return "Context compaction not yet implemented.";
  }

  private modelCommand(args: string[]): string {
    if (args.length === 0) {
      return `Current model: ${this.model}`;
    }
    const newModel = args[0]!;
    const oldModel = this.model;
    this.model = newModel;
    return `Model changed: ${oldModel} → ${newModel}`;
  }

  private async doctorCommand(): Promise<string> {
    const output = new PassThrough();
    await runDoctor({ output });
    const chunks: Buffer[] = [];
    let chunk: Buffer | null;
    while ((chunk = output.read() as Buffer | null) !== null) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString().trimEnd();
  }
}
